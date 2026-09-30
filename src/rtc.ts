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

import type { MatrixEvent } from './client.ts';

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
