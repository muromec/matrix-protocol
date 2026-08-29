import type { DataSource } from './types.ts';
import type { DmKey } from './bi-di-memory.ts';

export interface MDirectClient {
  getAccountData(type: string): Promise<Record<string, unknown>>;
  setAccountData(type: string, content: Record<string, unknown>): Promise<void>;
  getJoinedRooms?(): Promise<string[]>;
  getJoinedMembers?(roomId: string): Promise<Record<string, unknown>>;
}

/** m.direct account-data backed DataSource.  Handles both MXID→roomId
 *  (direct lookup) and roomId→MXID (scan of cached dict). */
export class MDirectSource implements DataSource<DmKey, string> {
  readonly #client: MDirectClient;
  #cache: Record<string, string[]> | null = null;

  constructor(client: MDirectClient) {
    this.#client = client;
  }

  async #fetch(): Promise<Record<string, string[]>> {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = (await this.#client.getAccountData('m.direct')) as Record<string, string[]>;
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  async get(key: DmKey): Promise<string | null> {
    const directs = await this.#fetch();
    if (key.tag === 'mxid') {
      const rooms = directs[key.value];
      return rooms?.length ? rooms[0] : null;
    }
    // roomId → MXID: scan cached dict.
    for (const [mxid, rooms] of Object.entries(directs)) {
      if (rooms.includes(key.value)) return mxid;
    }
    return null;
  }

  async set(key: DmKey, value: string): Promise<void> {
    if (key.tag !== 'mxid') return; // roomId→MXID writes not persisted
    const directs = await this.#fetch();
    const existing = directs[key.value] ?? [];
    if (!existing.includes(value)) {
      directs[key.value] = [...existing, value];
      try {
        await this.#client.setAccountData('m.direct', directs);
        this.#cache = directs;
      } catch {
        this.#cache = directs; // best-effort
      }
    }
  }

  async warmup(): Promise<void> {
    const client = this.#client;
    if (!client.getJoinedRooms || !client.getJoinedMembers) return;
    try {
      const directs = await this.#fetch();
      const joined = await client.getJoinedRooms();
      let changed = false;
      for (const [mxid, roomIds] of Object.entries(directs)) {
        const valid = roomIds.filter((rid) => joined.includes(rid));
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
          this.#cache = directs;
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* can't validate, skip */
    }
  }

  invalidate(_key: DmKey): void {
    this.#cache = null;
  }
}
