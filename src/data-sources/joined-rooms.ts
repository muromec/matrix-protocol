import type { DataSource } from './types.ts';
import type { DmKey } from './bi-di-memory.ts';

export interface JoinedRoomsClient {
  getJoinedRooms(): Promise<string[]>;
  getJoinedMembers(roomId: string): Promise<Record<string, unknown>>;
}

export class JoinedRoomsSource implements DataSource<DmKey, string> {
  readonly #client: JoinedRoomsClient;
  readonly #userId: string;

  constructor(client: JoinedRoomsClient, userId: string) {
    this.#client = client;
    this.#userId = userId;
  }

  async get(key: DmKey): Promise<string | null> {
    if (key.tag === 'mxid') return this.#findByMxid(key.value);
    return this.#findByRoomId(key.value);
  }

  async #findByMxid(mxid: string): Promise<string | null> {
    try {
      const joined = await this.#client.getJoinedRooms();
      for (const roomId of joined) {
        try {
          const members = await this.#client.getJoinedMembers(roomId);
          if (Object.keys(members).includes(mxid)) return roomId;
        } catch {
          /* skip */
        }
      }
    } catch {
      /* can't list rooms */
    }
    return null;
  }

  async #findByRoomId(roomId: string): Promise<string | null> {
    try {
      const members = await this.#client.getJoinedMembers(roomId);
      const ids = Object.keys(members);
      // Only exactly-2-member rooms are DMs.
      if (ids.length !== 2) return null;
      for (const id of ids) {
        if (id !== this.#userId) return id;
      }
      return null;
    } catch {
      /* can't check */
    }
    return null;
  }
  async set(_key: DmKey, _value: string): Promise<void> {
    /* source of truth */
  }
  invalidate(_key: DmKey): void {
    /* source of truth */
  }
}
