import { describe, it, expect } from 'vitest';
import type { MatrixEvent } from '../src/client.ts';
import {
  isRtcMemberEvent,
  leaveEventFor,
  legacyStateKey,
  membershipEventFor,
  membershipEventTypeFor,
  notificationEventFor,
  RTC_NOTIFICATION_MAX_LIFETIME_MS,
  RTC_NOTIFICATION_TYPE,
  readRtcMembership,
  rtcCallsInRoom,
  rtcFociFromWellKnown,
  rtcTokenDialectInRoom,
  slotOf,
} from '../src/rtc.ts';

// ── fixtures ────────────────────────────────────────────────────────────────
//
// The legacy fixture is one membership event exactly as a real client left it
// in a real room (2026-09-30): it joined a call and then left, so the content
// is empty and the membership survives only in `unsigned.prev_content`.

const LEGACY_CONTENT = {
  application: 'm.call',
  call_id: '',
  device_id: 'LPJNXXHPNU',
  expires: 14400000,
  foci_preferred: [
    {
      livekit_alias: '!lIqimBZRAIrSvjejvG:muromec.nl',
      livekit_service_url: 'https://livekit.muromec.nl',
      type: 'livekit',
    },
  ],
  focus_active: { focus_selection: 'multi_sfu', type: 'livekit' },
  'm.call.intent': 'audio',
  membershipID: '@ip:muromec.nl:LPJNXXHPNU',
  scope: 'm.room',
};

const LEGACY_LEFT: MatrixEvent = {
  type: 'org.matrix.msc3401.call.member',
  state_key: '_@ip:muromec.nl_LPJNXXHPNU_m.call',
  sender: '@ip:muromec.nl',
  content: {},
  event_id: '$G8_iFAQ2kQ9IRAuK5Zw5R6t6cIFf1Wpc7IckFqcmFXc',
  room_id: '!lIqimBZRAIrSvjejvG:muromec.nl',
  origin_server_ts: 1790775289703,
  unsigned: { prev_content: LEGACY_CONTENT, age: 18214 },
};

const LEGACY_IN_CALL: MatrixEvent = {
  ...LEGACY_LEFT,
  content: LEGACY_CONTENT,
  event_id: '$in-call',
  unsigned: { age: 10 },
};

const MODERN_IN_CALL: MatrixEvent = {
  type: 'm.rtc.member',
  state_key: '@ip:muromec.nl:AB12CD34EF',
  sender: '@ip:muromec.nl',
  content: {
    application: 'm.call',
    call_id: '',
    slot_id: 'm.call#ROOM',
    member: { user_id: '@ip:muromec.nl', device_id: 'AB12CD34EF', id: '@ip:muromec.nl:AB12CD34EF' },
    membership: 'join',
    expires: 1790780000000,
    transports: [{ type: 'livekit', livekit_service_url: 'https://livekit.muromec.nl' }],
  },
  event_id: '$modern',
  room_id: '!lIqimBZRAIrSvjejvG:muromec.nl',
  origin_server_ts: 1790776000000,
};

const A_MESSAGE: MatrixEvent = {
  type: 'm.room.message',
  sender: '@ip:muromec.nl',
  content: { msgtype: 'm.text', body: 'hello' },
  event_id: '$msg',
  room_id: '!lIqimBZRAIrSvjejvG:muromec.nl',
  origin_server_ts: 1790775000000,
};

// ── tests ───────────────────────────────────────────────────────────────────

describe('isRtcMemberEvent', () => {
  it('knows all three generations and nothing else', () => {
    for (const type of ['org.matrix.msc3401.call.member', 'm.call.member', 'm.rtc.member']) {
      expect(isRtcMemberEvent({ type })).toBe(true);
    }
    expect(isRtcMemberEvent({ type: 'm.room.message' })).toBe(false);
  });
});

describe('slotOf', () => {
  it('defaults an empty call id to the room-scoped slot', () => {
    expect(slotOf({ application: 'm.call', call_id: '' })).toBe('m.call#ROOM');
  });

  it('names a call that has an id', () => {
    expect(slotOf({ application: 'm.call', call_id: 'c1' })).toBe('m.call#c1');
  });

  it('prefers an explicit slot id', () => {
    expect(slotOf({ application: 'm.call', call_id: 'c1', slot_id: 'm.call#elsewhere' })).toBe(
      'm.call#elsewhere',
    );
  });
});

describe('readRtcMembership', () => {
  it('reads a leave: empty content, membership in prev_content', () => {
    const m = readRtcMembership(LEGACY_LEFT);
    expect(m).not.toBeNull();
    expect(m!.inCall).toBe(false);
    expect(m!.slot).toBe('m.call#ROOM');
    expect(m!.userId).toBe('@ip:muromec.nl');
    expect(m!.deviceId).toBe('LPJNXXHPNU');
    expect(m!.memberId).toBe('@ip:muromec.nl:LPJNXXHPNU');
    expect(m!.application).toBe('m.call');
    expect(m!.callId).toBe('');
    expect(m!.intent).toBe('audio');
    expect(m!.scope).toBe('m.room');
    expect(m!.expires).toBe(14400000);
    expect(m!.foci).toHaveLength(1);
    expect(m!.foci[0].livekit_service_url).toBe('https://livekit.muromec.nl');
    expect(m!.previous?.call_id).toBe('');
  });

  it('reads a member that is in the call', () => {
    const m = readRtcMembership(LEGACY_IN_CALL)!;
    expect(m.inCall).toBe(true);
    expect(m.foci[0].type).toBe('livekit');
  });

  it('reads the current shape, where the slot and the member block are stated', () => {
    const m = readRtcMembership(MODERN_IN_CALL)!;
    expect(m.inCall).toBe(true);
    expect(m.slot).toBe('m.call#ROOM');
    expect(m.memberId).toBe('@ip:muromec.nl:AB12CD34EF');
    expect(m.deviceId).toBe('AB12CD34EF');
    expect(m.foci[0].livekit_service_url).toBe('https://livekit.muromec.nl');
  });

  it('returns null for an event that is not a membership', () => {
    expect(readRtcMembership(A_MESSAGE)).toBeNull();
  });
});

describe('rtcCallsInRoom', () => {
  it('reports a call nobody is in any more, and who left it', () => {
    const calls = rtcCallsInRoom([LEGACY_LEFT]);
    expect(calls).toHaveLength(1);
    expect(calls[0].slot).toBe('m.call#ROOM');
    expect(calls[0].members).toHaveLength(0);
    expect(calls[0].all).toHaveLength(1);
    expect(calls[0].focus).toBeUndefined();
  });

  it('counts only the members whose content says they are in the call', () => {
    const calls = rtcCallsInRoom([LEGACY_LEFT, LEGACY_IN_CALL]);
    expect(calls).toHaveLength(1);
    expect(calls[0].members).toHaveLength(1);
    expect(calls[0].all).toHaveLength(2);
    expect(calls[0].focus?.livekit_service_url).toBe('https://livekit.muromec.nl');
    expect(calls[0].intent).toBe('audio');
  });

  it('keeps two slots apart', () => {
    const calls = rtcCallsInRoom([LEGACY_IN_CALL, MODERN_IN_CALL]);
    expect(calls.map((c) => c.slot).sort()).toEqual(['m.call#ROOM']);
    const other = rtcCallsInRoom([
      LEGACY_IN_CALL,
      { ...MODERN_IN_CALL, content: { ...MODERN_IN_CALL.content, slot_id: 'm.call#c2' } },
    ]);
    expect(other.map((c) => c.slot).sort()).toEqual(['m.call#ROOM', 'm.call#c2']);
  });
});

describe('rtcFociFromWellKnown', () => {
  it('reads the advertised focus', () => {
    const foci = rtcFociFromWellKnown({
      'm.homeserver': { base_url: 'https://muromec.nl' },
      'org.matrix.msc4143.rtc_foci': [
        { type: 'livekit', livekit_service_url: 'https://livekit.muromec.nl' },
      ],
    });
    expect(foci).toHaveLength(1);
    expect(foci[0].livekit_service_url).toBe('https://livekit.muromec.nl');
  });

  it('answers an empty list for a document without foci or not an object', () => {
    expect(rtcFociFromWellKnown({})).toEqual([]);
    expect(rtcFociFromWellKnown(undefined)).toEqual([]);
    expect(rtcFociFromWellKnown('nonsense')).toEqual([]);
  });
});

describe('membershipEventFor', () => {
  const opts = {
    userId: '@bot:hs',
    deviceId: 'DEV',
    roomId: '!r:hs',
    serviceUrl: 'https://sfu.example',
  };

  it('writes the membership a client in the wild reads', () => {
    const ev = membershipEventFor(opts);
    expect(ev.type).toBe('org.matrix.msc3401.call.member');
    expect(ev.stateKey).toBe('_@bot:hs_DEV_m.call');
    expect(ev.content.application).toBe('m.call');
    expect(ev.content.call_id).toBe('');
    expect(ev.content.device_id).toBe('DEV');
    expect(ev.content.expires).toBe(4 * 60 * 60 * 1000);
    expect(ev.content.membershipID).toBe('@bot:hs:DEV');
    expect(ev.content['m.call.intent']).toBe('audio');
    expect(ev.content.scope).toBe('m.room');
    expect(ev.content.foci_preferred?.[0]).toEqual({
      type: 'livekit',
      livekit_service_url: 'https://sfu.example',
      livekit_alias: '!r:hs',
    });
  });

  it('names the call in the state key when it has one', () => {
    expect(legacyStateKey('@bot:hs', 'DEV', 'c1')).toBe('_@bot:hs_DEV_c1');
    expect(legacyStateKey('@bot:hs', 'DEV')).toBe('_@bot:hs_DEV_m.call');
  });

  it('reads back as a member in the call, and as gone once emptied', () => {
    const ev = membershipEventFor(opts);
    const asEvent: MatrixEvent = {
      type: ev.type,
      state_key: ev.stateKey,
      sender: opts.userId,
      content: { ...ev.content } as Record<string, unknown>,
      event_id: '$ours',
      room_id: opts.roomId,
      origin_server_ts: 1,
    };

    const mine = readRtcMembership(asEvent)!;
    expect(mine.inCall).toBe(true);
    expect(mine.slot).toBe('m.call#ROOM');
    expect(mine.memberId).toBe('@bot:hs:DEV');

    const left = leaveEventFor(ev);
    expect(left.type).toBe(ev.type);
    expect(left.stateKey).toBe(ev.stateKey);
    expect(left.content).toEqual({});

    const asLeft: MatrixEvent = {
      ...asEvent,
      content: {},
      unsigned: { prev_content: { ...ev.content } as Record<string, unknown> },
    };
    expect(readRtcMembership(asLeft)!.inCall).toBe(false);
  });

  it('prefers the type the room already uses', () => {
    expect(membershipEventTypeFor([])).toBe('org.matrix.msc3401.call.member');
    expect(membershipEventTypeFor([LEGACY_IN_CALL])).toBe('org.matrix.msc3401.call.member');
    expect(membershipEventTypeFor([LEGACY_IN_CALL, MODERN_IN_CALL])).toBe('m.rtc.member');
  });
});

describe('rtcTokenDialectInRoom', () => {
  it('answers for the generation the room is in', () => {
    expect(rtcTokenDialectInRoom([MODERN_IN_CALL])).toBe('modern');
    expect(rtcTokenDialectInRoom([LEGACY_IN_CALL])).toBe('legacy');
  });

  it('lets a newer participant outrank an older one', () => {
    expect(rtcTokenDialectInRoom([LEGACY_IN_CALL, MODERN_IN_CALL])).toBe('modern');
  });

  it('answers the older dialect when nobody is in the call', () => {
    expect(rtcTokenDialectInRoom([])).toBe('legacy');
    expect(rtcTokenDialectInRoom([LEGACY_LEFT])).toBe('legacy');
    expect(rtcTokenDialectInRoom([A_MESSAGE])).toBe('legacy');
  });
});

describe('notificationEventFor', () => {
  it('writes the ring a client raises a call from', () => {
    const event = notificationEventFor({
      slot: 'm.call#ROOM',
      membershipEventId: '$membership',
      senderTs: 1790776225000,
    });

    expect(event.type).toBe(RTC_NOTIFICATION_TYPE);
    expect(event.content.slot_id).toBe('m.call#ROOM');
    expect(event.content.notification_type).toBe('ring');
    expect(event.content['m.relates_to']).toEqual({
      event_id: '$membership',
      rel_type: 'm.reference',
    });
    expect(event.content['m.mentions']).toEqual({ user_ids: [], room: true });
    expect(event.content.sender_ts).toBe(1790776225000);
    expect(event.content.lifetime).toBe(90_000);
    expect(event.content.msc4354_sticky_key).toBe('m.call#ROOM');
  });

  it('caps a lifetime rather than refusing it, and names who it is for when told', () => {
    const event = notificationEventFor({
      slot: 'm.call#ROOM',
      membershipEventId: '$membership',
      lifetimeMs: 10 * 60 * 1000,
      intent: 'audio',
      userIds: ['@them:example.org'],
      room: false,
      senderTs: 1,
    });

    expect(event.content.lifetime).toBe(RTC_NOTIFICATION_MAX_LIFETIME_MS);
    expect(event.content['m.call.intent']).toBe('audio');
    expect(event.content['m.mentions']).toEqual({ user_ids: ['@them:example.org'], room: false });
  });
});
