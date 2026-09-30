// ── MatrixRTC memberships ──────────────────────────────────────────────────
//
// A call is room state rather than a server-side object: each participant
// publishes a membership event naming itself, the slot it is in, the
// transports (foci) it can be reached on and how long that membership holds.
// An empty content is a participant that has left — the membership that was
// there survives only in `unsigned.prev_content`, which is how a call nobody is
// in any more is still identifiable.
//
// Three event types are in the wild, oldest first: the unstable MSC3401 name,
// the stabilised `m.call.member`, and the current `m.rtc.member`.  They differ
// in where the slot and the member block live, and reconciling that is the
// whole of what this module does.  Nothing here talks to a server.

import type { MatrixEvent, RtcTokenDialect } from './client.ts';

/** The membership event types three generations of clients write. */
export const RTC_MEMBER_TYPES: string[] = [
  'org.matrix.msc3401.call.member',
  'm.call.member',
  'm.rtc.member',
];

const RTC_MEMBER_TYPE_SET = new Set(RTC_MEMBER_TYPES);

/** Where a member asks to be reached.  `livekit_alias` is the old shape's
 *  field and carries the Matrix room ID, not the SFU's room name. */
export interface RtcFocus {
  type: string;
  livekit_service_url?: string;
  livekit_alias?: string;
}

/** The member block of the current shape.  The device ID is claimed, never
 *  verified, which is why the field says so. */
export interface RtcMemberRef {
  user_id?: string;
  device_id?: string;
  id?: string;
}

/** A membership event's content, however the three shapes write it. */
export interface RtcMembershipContent {
  application?: string;
  call_id?: string;
  device_id?: string;
  slot_id?: string;
  member?: RtcMemberRef;
  membershipID?: string;
  membership?: string;
  scope?: string;
  expires?: number;
  foci_preferred?: RtcFocus[];
  transports?: RtcFocus[];
  focus_active?: { type?: string; focus_selection?: string };
  'm.call.intent'?: string;
}

/** One participant's membership, read out of one event. */
export interface RtcMembership {
  eventId: string;
  type: string;
  stateKey: string;
  sender: string;
  userId: string;
  deviceId?: string;
  /** `{userId}:{deviceId}` where the event states one, else the user ID. */
  memberId: string;
  application: string;
  callId: string;
  /** `{application}#{id}` — the session inside the room.  The room-scoped call
   *  every client in the wild creates has the slot `m.call#ROOM`. */
  slot: string;
  /** False when the content is empty: the member left. */
  inCall: boolean;
  expires?: number;
  intent?: string;
  scope?: string;
  foci: RtcFocus[];
  /** The membership the current (empty) content replaced, for a leave. */
  previous?: RtcMembershipContent;
}

/** A slot's participants.  A room can hold several of these. */
export interface RtcCall {
  slot: string;
  application: string;
  callId: string;
  /** Members whose content says they are in the call. */
  members: RtcMembership[];
  /** Every member with an event for this slot, including those who left. */
  all: RtcMembership[];
  /** Where the first member in the call asks to be reached. */
  focus?: RtcFocus;
  intent?: string;
}

function asContent(value: unknown): RtcMembershipContent | undefined {
  return typeof value === 'object' && value !== null ? (value as RtcMembershipContent) : undefined;
}

/** Whether an event is a membership event of any generation. */
export function isRtcMemberEvent(event: Pick<MatrixEvent, 'type'>): boolean {
  return RTC_MEMBER_TYPE_SET.has(event.type);
}

/** The slot a membership content names: `{application}#{id}`.
 *
 *  The current shape states the slot outright (`slot_id`); the older ones only
 *  carry a call ID, and an empty one means the room-scoped call, which is the
 *  `m.call#ROOM` every client in the wild uses. */
export function slotOf(content: RtcMembershipContent): string {
  if (content.slot_id) return content.slot_id;
  const application = content.application ?? 'm.call';
  const id = content.call_id ? content.call_id : 'ROOM';
  return `${application}#${id}`;
}

/** Where a member asks to be reached, current shape first. */
export function fociOf(content: RtcMembershipContent): RtcFocus[] {
  return [...(content.transports ?? []), ...(content.foci_preferred ?? [])];
}

/** Read one participant's membership, or null for an event that is not one. */
export function readRtcMembership(event: MatrixEvent): RtcMembership | null {
  if (!isRtcMemberEvent(event)) return null;

  const content = asContent(event.content) ?? {};
  const previous = asContent(event.unsigned?.prev_content);
  const inCall = Object.keys(content).length > 0;
  const described = inCall ? content : (previous ?? content);

  const ref = described.member ?? content.member;
  const userId = ref?.user_id ?? event.sender;
  const deviceId = ref?.device_id ?? described.device_id;
  const memberId =
    ref?.id ?? described.membershipID ?? (deviceId ? `${userId}:${deviceId}` : userId);

  return {
    eventId: event.event_id,
    type: event.type,
    stateKey: event.state_key ?? '',
    sender: event.sender,
    userId,
    deviceId,
    memberId,
    application: described.application ?? 'm.call',
    callId: described.call_id ?? '',
    slot: slotOf(described),
    inCall,
    expires: described.expires,
    intent: described['m.call.intent'],
    scope: described.scope,
    foci: fociOf(described),
    previous,
  };
}

/** The slots a room's state describes, each with its members. */
export function rtcCallsInRoom(events: MatrixEvent[]): RtcCall[] {
  const bySlot = new Map<string, RtcCall>();

  for (const event of events) {
    const membership = readRtcMembership(event);
    if (!membership) continue;

    const call: RtcCall = bySlot.get(membership.slot) ?? {
      slot: membership.slot,
      application: membership.application,
      callId: membership.callId,
      members: [],
      all: [],
    };

    call.all.push(membership);
    if (membership.inCall) {
      call.members.push(membership);
      if (call.focus === undefined) {
        call.focus = membership.foci.find((f) => f.type === 'livekit') ?? membership.foci[0];
      }
      if (call.intent === undefined) call.intent = membership.intent;
    }
    bySlot.set(membership.slot, call);
  }

  return [...bySlot.values()];
}
/** The foci a homeserver advertises in its `.well-known/matrix/client`
 *  document — the fallback for a membership that names none. */
export function rtcFociFromWellKnown(document: unknown): RtcFocus[] {
  if (typeof document !== 'object' || document === null) return [];
  const foci = (document as Record<string, unknown>)['org.matrix.msc4143.rtc_foci'];
  return Array.isArray(foci) ? (foci as RtcFocus[]) : [];
}

/** A membership event as it is written: what to PUT, and where. */
export interface RtcMembershipEvent {
  type: string;
  stateKey: string;
  content: RtcMembershipContent;
}

/** The event type to write for a call in this room: the generation the room
 *  already uses, so that the clients already in the call can read us.  The
 *  oldest one is the fallback because it is what the clients here write. */
export function membershipEventTypeFor(events: MatrixEvent[]): string {
  for (const type of [...RTC_MEMBER_TYPES].reverse()) {
    if (events.some((e) => e.type === type)) return type;
  }
  return RTC_MEMBER_TYPES[0];
}

/** The membership type that carries a member block, and with it an identity that
 *  has to be hashed.  The two older ones name the device outright. */
const MODERN_MEMBER_TYPE = 'm.rtc.member';

/**
 * The token dialect the call in this room speaks.
 *
 * The identity in the token is what the others in the room see us as, and a
 * client can only bind a participant whose identity it can derive, so we ask the
 * way the room asks: the newest generation with somebody in the call, and the
 * older one when there is nobody yet, because the clients in the wild are old.
 */
export function rtcTokenDialectInRoom(events: MatrixEvent[]): RtcTokenDialect {
  for (const type of [...RTC_MEMBER_TYPES].reverse()) {
    const inCall = events.some((e) => e.type === type && readRtcMembership(e)?.inCall === true);
    if (inCall) return type === MODERN_MEMBER_TYPE ? 'modern' : 'legacy';
  }
  return 'legacy';
}

/** The state key a legacy membership lives under: `_{user}_{device}_{call id}`,
 *  with the application standing in for a call that has no id. */
export function legacyStateKey(userId: string, deviceId: string, callId?: string): string {
  return `_${userId}_${deviceId}_${callId && callId.length > 0 ? callId : 'm.call'}`;
}

/**
 * The membership to publish in order to be in a call.
 *
 * Shape: the unstable MSC3401 one, which is what the clients here speak — the
 * current `m.rtc.member` shape differs in where the slot and the member block
 * live and in what `expires` means, and nothing here has seen one of those yet.
 *
 * `expiresMs` is a *duration* in this shape (a client renews before it runs
 * out); four hours is what the clients use by default.
 */
export function membershipEventFor(opts: {
  userId: string;
  deviceId: string;
  roomId: string;
  serviceUrl: string;
  type?: string;
  application?: string;
  callId?: string;
  intent?: string;
  expiresMs?: number;
}): RtcMembershipEvent {
  const application = opts.application ?? 'm.call';
  const callId = opts.callId ?? '';
  const expiresMs = opts.expiresMs ?? 4 * 60 * 60 * 1000;

  return {
    type: opts.type ?? RTC_MEMBER_TYPES[0],
    stateKey: legacyStateKey(opts.userId, opts.deviceId, callId),
    content: {
      application,
      call_id: callId,
      device_id: opts.deviceId,
      expires: expiresMs,
      // The old shape's `livekit_alias` carries the Matrix room ID; the SFU's
      // room name is the focus's own hash of (room, slot).
      foci_preferred: [
        {
          type: 'livekit',
          livekit_service_url: opts.serviceUrl,
          livekit_alias: opts.roomId,
        },
      ],
      focus_active: { type: 'livekit', focus_selection: 'multi_sfu' },
      'm.call.intent': opts.intent ?? 'audio',
      membershipID: `${opts.userId}:${opts.deviceId}`,
      scope: 'm.room',
    },
  };
}

/** The leave: the same event, emptied.  A member that is not in the call has a
 *  membership whose content is `{}` — the way out is an empty event, not a
 *  removed one. */
export function leaveEventFor(membership: RtcMembershipEvent): RtcMembershipEvent {
  return { type: membership.type, stateKey: membership.stateKey, content: {} };
}
