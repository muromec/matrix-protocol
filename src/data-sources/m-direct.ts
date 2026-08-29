import type { DataSource, Warmable } from './types.ts';
import type { DmKey } from './bi-di-memory.ts';

export interface MDirectLike {
  getAccountData(type: string): Promise<unknown>;
  setAccountData(type: string, content: unknown): Promise<void>;
  getJoinedRooms?(): Promise<string[]>;
  getJoinedMembers?(roomId: string): Promise<Record<string, unknown>>;
}

/** m.direct account-data backed DataSource with warmup for stale-room
 *  cleanup at startup. */
export function mDirectSource(client: MDirectLike): DataSource<DmKey, string> & Warmable {
  let cache: Record<string, string[]> | null = null;

  async function fetch(): Promise<Record<string, string[]>> {
    if (cache) return cache;
    try {
      cache = (await client.getAccountData('m.direct')) as Record<string, string[]>;
    } catch {
      cache = {};
    }
    return cache;
  }

  return {
    async get(key: DmKey): Promise<string | null> {
      const directs = await fetch();
      if (key.tag === 'mxid') {
        const rooms = directs[key.value];
        return rooms?.length ? rooms[0] : null;
      }
      for (const [mxid, rooms] of Object.entries(directs)) {
        if (rooms.includes(key.value)) return mxid;
      }
      return null;
    },

    async set(key: DmKey, value: string): Promise<void> {
      if (key.tag !== 'mxid') return;
      const directs = await fetch();
      const existing = directs[key.value] ?? [];
      if (!existing.includes(value)) {
        directs[key.value] = [...existing, value];
        try {
          await client.setAccountData('m.direct', directs);
          cache = directs;
        } catch {
          cache = directs;
        }
      }
    },

    invalidate(_key: DmKey): void {
      cache = null;
    },

    /** Validate m.direct entries against joined rooms.  Removes stale
     *  rooms that are no longer joined.  Called once at startup. */
    async warmup(): Promise<void> {
      if (!client.getJoinedRooms || !client.getJoinedMembers) return;
      try {
        const raw = await client.getAccountData('m.direct');
        const directs = { ...(raw as Record<string, string[]>) };
        const joined = await client.getJoinedRooms();
        let changed = false;
        for (const [mxid, roomIds] of Object.entries(directs)) {
          const valid: string[] = [];
          for (const rid of roomIds) {
            if (!joined.includes(rid)) continue; // not joined → stale
            // Verify the target MXID is actually a member.
            try {
              const members = await client.getJoinedMembers!(rid);
              if (Object.keys(members).includes(mxid)) {
                valid.push(rid);
              }
            } catch {
              // Can't verify — keep the room.
              valid.push(rid);
            }
          }
          if (valid.length !== roomIds.length) {
            if (valid.length === 0) {
              delete directs[mxid];
            } else {
              directs[mxid] = valid;
            }
            changed = true;
          }
        }
        if (changed) {
          try {
            await client.setAccountData('m.direct', directs);
            cache = directs;
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* can't validate, skip */
      }
    },
  };
}
