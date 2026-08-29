import type { DataSource } from './types.ts';
import type { DmKey } from './bi-di-memory.ts';

export interface JoinedRoomsLike {
  getJoinedRooms(): Promise<string[]>;
  getJoinedMembers(roomId: string): Promise<Record<string, unknown>>;
  /** Create a new DM room.  If absent, creation happens outside the chain. */
  createRoom?(opts: { is_direct: boolean; invite: string[]; preset: string }): Promise<string>;
}

/** Joined-rooms scan DataSource.
 *
 * Does NOT clean up zombie rooms (solo rooms not in m.direct).
 * That responsibility lives in mDirectSource.warmup(), which
 * validates m.direct entries against actual membership.  Rooms
 * created through this source propagate upward to m.direct via
 * the chain, so they are cleaned on the next warmup cycle.
 * Pre-existing zombies from before this fix are harmless (idle).
 *
 * For mxid→room: scans all joined rooms for the target, creates
 * on miss.  For room→mxid: only returns a peer for exactly-2-member
 * rooms (DMs). */
export function joinedRoomsSource(
  client: JoinedRoomsLike,
  userId: string,
): DataSource<DmKey, string> {
  return {
    async get(key: DmKey): Promise<string | null> {
      if (key.tag === 'mxid') {
        try {
          const joined = await client.getJoinedRooms();
          for (const roomId of joined) {
            try {
              const members = await client.getJoinedMembers(roomId);
              if (Object.keys(members).includes(key.value)) return roomId;
            } catch {
              /* skip */
            }
          }
        } catch {
          /* can't list rooms */
        }

        // Source of truth miss: create the room.  The chain
        // automatically propagates the result to faster layers.
        if (client.createRoom) {
          return client.createRoom({
            is_direct: true,
            invite: [key.value],
            preset: 'trusted_private_chat',
          });
        }
        return null;
      }
      // roomId → MXID: only exactly-2-member rooms are DMs.
      try {
        const members = await client.getJoinedMembers(key.value);
        const ids = Object.keys(members);
        if (ids.length !== 2) return null;
        const peer = ids.find((id) => id !== userId);
        return peer ?? null;
      } catch {
        /* can't check */
      }
      return null;
    },

    async set(_key: DmKey, _value: string): Promise<void> {
      /* source of truth */
    },
    invalidate(_key: DmKey): void {
      /* source of truth */
    },
  };
}
