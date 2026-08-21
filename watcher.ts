// ── MatrixWatcher ─────────────────────────────────────────────────────────
//
// High-level watcher built on top of MatrixClient and MatrixMessage.
//
// Wraps the /sync long-poll loop with:
//   - Automatic reconnection on network errors
//   - Auto-join on room invites (m.room.member with membership=invite)
//   - Keepalive sync cycling (the server already does long-poll, so
//     minimal keepalive logic is needed — we just re-enter /sync
//     immediately on response)
//   - Deduplication via event_id tracking

import { MatrixClient, MatrixError, type MatrixEvent, type SyncResponse } from "./client.ts";
import { MatrixMessage } from "./message.ts";
import { loadSyncToken, saveSyncToken } from "./sync-token.ts";
import { chain } from "../../src/data-sources/types.ts";
import type { DataSource, Warmable } from "../../src/data-sources/types.ts";
import { BiDiMemorySource } from "../../src/data-sources/bi-di-memory.ts";
import type { DmKey } from "../../src/data-sources/bi-di-memory.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface WatcherConfig {
  baseUrl: string;
  userId: string;
  password: string;
  deviceId?: string;
  initialDeviceDisplayName?: string;
  syncTimeout?: number;
  reconnectDelay?: number;
  syncTokenPath?: string;
}

export interface WatcherEvent {
  type: "connected" | "disconnected" | "message" | "invite" | "error";
  message?: MatrixMessage;
  roomId?: string;
  inviter?: string;
  error?: Error;
}

// ── local data-source helpers ─────────────────────────────────────────────

interface MDirectLike {
  getAccountData(type: string): Promise<unknown>;
  setAccountData(type: string, content: unknown): Promise<void>;
  getJoinedRooms?(): Promise<string[]>;
  getJoinedMembers?(roomId: string): Promise<Record<string, unknown>>;
}

interface JoinedRoomsLike {
  getJoinedRooms(): Promise<string[]>;
  getJoinedMembers(roomId: string): Promise<Record<string, unknown>>;
  /** Create a new DM room.  If absent, creation happens outside the chain. */
  createRoom?(opts: { is_direct: boolean; invite: string[]; preset: string }): Promise<string>;
}

/** m.direct account-data backed DataSource with warmup for stale-room
 *  cleanup at startup. */
function mDirectSource(client: MDirectLike): DataSource<DmKey, string> & Warmable {
  let cache: Record<string, string[]> | null = null;

  async function fetch(): Promise<Record<string, string[]>> {
    if (cache) return cache;
    try {
      cache = await client.getAccountData('m.direct') as Record<string, string[]>;
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

    invalidate(_key: DmKey): void { cache = null; },

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
          } catch { /* best-effort */ }
        }
      } catch { /* can't validate, skip */ }
    },
  };
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
function joinedRoomsSource(client: JoinedRoomsLike, userId: string): DataSource<DmKey, string> {
  return {
    async get(key: DmKey): Promise<string | null> {
      if (key.tag === 'mxid') {
        try {
          const joined = await client.getJoinedRooms();
          for (const roomId of joined) {
            try {
              const members = await client.getJoinedMembers(roomId);
              if (Object.keys(members).includes(key.value)) return roomId;
            } catch { /* skip */ }
          }
        } catch { /* can't list rooms */ }

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
      } catch { /* can't check */ }
      return null;
    },

    async set(_key: DmKey, _value: string): Promise<void> { /* source of truth */ },
    invalidate(_key: DmKey): void { /* source of truth */ },
  };
}
// ── watcher ────────────────────────────────────────────────────────────────



const DEBUG = process.env.DEBUG?.includes('matrix') || process.env.DEBUG?.includes('*');
const debugLog = (...args: unknown[]) => { if (DEBUG) console.log(...args); };

export class MatrixWatcher extends EventTarget {
  #config: WatcherConfig;
  #client: MatrixClient | null = null;
  #abortController: AbortController | null = null;

  #seenEvents = new Set<string>();
  #maxSeen = 10_000;
  #readyPromise: Promise<void>;
  #readyResolve!: () => void;

  /** Three-layer DM room cache: memory → m.direct → joined-rooms scan. */
  #dmCache: (DataSource<DmKey, string> & Warmable) | null = null;
  /** The underlying memory layer, shared so tests can seed it. */
  #dmMemory: BiDiMemorySource | null = null;

  #syncToken: string | undefined;

  constructor(config: WatcherConfig) {
    super();
    this.#config = config;
    this.#readyPromise = new Promise((resolve) => { this.#readyResolve = resolve; });
  }

  // ── public API ──────────────────────────────────────────────────────────

  get ready(): Promise<void> { return this.#readyPromise; }

  async start(): Promise<void> {
    debugLog('[watcher:lifecycle] start() called');
    if (this.#abortController) {
      debugLog('[watcher:lifecycle] already running, skipping');
      return;
    }
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    const syncTimeout = this.#config.syncTimeout ?? 30_000;
    const reconnectDelay = this.#config.reconnectDelay ?? 5_000;

    while (!signal.aborted) {
      let since: string | undefined;

      try {
        this.#client = await MatrixClient.login({
          baseUrl: this.#config.baseUrl,
          userId: this.#config.userId,
          password: this.#config.password,
          deviceId: this.#config.deviceId,
          initialDeviceDisplayName: this.#config.initialDeviceDisplayName,
        });

        this.#readyPromise = new Promise((resolve) => { this.#readyResolve = resolve; });
        this.#emit({ type: "connected" });

        this.#client.setPresence("online").catch(() => {});
        if (this.#config.initialDeviceDisplayName && this.#client) {
          this.#client.setDisplayName(this.#config.initialDeviceDisplayName).catch(() => {});
        }

        // Build the DM cache chain and validate stale entries.
        await this.#createCache();
        await this.#warmupCache();
        this.#readyResolve();

        if (this.#syncToken === undefined) {
          this.#syncToken = await loadSyncToken(this.#config.syncTokenPath);
        }
        since = this.#syncToken;

        const initResp = await this.#client.sync(since, since ? undefined : 5000, signal);
        this.#processSync(initResp);
        since = initResp.next_batch;

        this.#syncToken = since;
        await saveSyncToken(this.#config.syncTokenPath, since);

        if (signal.aborted) break;

        while (!signal.aborted) {
          try {
            const resp = await this.#client.sync(since, syncTimeout, signal);
            this.#processSync(resp);
            since = resp.next_batch;

            this.#syncToken = since;
            await saveSyncToken(this.#config.syncTokenPath, since);
          } catch (err) {
            if (isRecoverable(err)) continue;
            throw err;
          }
        }

        break;
      } catch (err) {
        if (signal.aborted) break;
        this.#emit({ type: "error", error: err as Error });
      }

      if (signal.aborted) break;
      this.#emit({ type: "disconnected" });
      await this.#sleep(reconnectDelay, signal);
    }
  }

  stop(): void {
    this.#abortController?.abort();
    this.#abortController = null;
  }

  // ── events ──────────────────────────────────────────────────────────────

  on(
    type: "message" | "connected" | "disconnected" | "invite" | "error",
    listener: (event: WatcherEvent) => void,
  ): void {
    this.addEventListener(type, (e) =>
      listener((e as CustomEvent<WatcherEvent>).detail),
    );
  }

  #emit(event: WatcherEvent): void {
    this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
  }

  // ── sync processing ─────────────────────────────────────────────────────

  #processSync(resp: SyncResponse): void {
    if (!this.#client) return;

    if (resp.rooms?.invite) {
      for (const [roomId, roomData] of Object.entries(resp.rooms.invite)) {
        const events = roomData?.invite_state?.events ?? [];
        const memberEvent = events.find(
          (e) => e.type === "m.room.member" && e.state_key === this.#client!.userId,
        );
        const inviter = memberEvent?.sender ?? "unknown";
        const membership = memberEvent?.content?.membership;

        if (membership === "invite") {
          this.#joinRoom(roomId).catch((err) => {
            this.#emit({
              type: "error",
              error: new Error(`Failed to join room ${roomId}: ${(err as Error).message}`),
            });
          });
          this.#emit({ type: "invite", roomId, inviter });
        }
      }
    }

    this.#processAccountData(resp);

    if (resp.rooms?.join) {
      for (const [roomId, roomData] of Object.entries(resp.rooms.join)) {
        const timelineEvents = roomData?.timeline?.events ?? [];

        for (const event of timelineEvents) {
          if (this.#seenEvents.has(event.event_id)) continue;
          this.#trackSeen(event.event_id);

          if (event.sender === this.#client.userId) continue;
          if (event.type !== "m.room.message") continue;

          const msgtype = event.content?.msgtype as string | undefined;
          if (msgtype !== "m.text" && msgtype !== "m.notice") continue;

          const msg = MatrixMessage.fromEvent(event, roomId);
          if (msg.text.length === 0) continue;

          this.#emit({ type: "message", message: msg, roomId });
        }
      }
    }
  }

  // ── cache lifecycle ─────────────────────────────────────────────────────

  /** Build the 3-layer chain: memory → m.direct → joined-rooms scan.
   *  Seeds the memory layer from current m.direct account data. */
  async #createCache(): Promise<void> {
    const client = this.#client;
    if (!client) return;

    this.#dmMemory = new BiDiMemorySource();
    const md = mDirectSource(client);
    const jr = joinedRoomsSource(client, this.#config.userId);

    this.#dmCache = chain(this.#dmMemory, md, jr) as DataSource<DmKey, string> & Warmable;

    // Seed from m.direct through the chain (populates all layers).
    try {
      const raw = await client.getAccountData('m.direct');
      const content = raw as Record<string, string[]>;
      let count = 0;
      for (const [mxid, roomIds] of Object.entries(content)) {
        for (const roomId of roomIds) {
          await this.#dmCache.set({ tag: 'roomid', value: roomId }, mxid);
          count++;
        }
      }
      debugLog(`[watcher:createCache] (${this.#config.userId}) seeded ${count} entries`);
    } catch {
      debugLog(`[watcher:createCache] (${this.#config.userId}) m.direct fetch failed (may not exist yet)`);
    }

  }


  /** Validate the m.direct layer against joined rooms, removing stale
   *  entries.  Called once at startup after #createCache(). */
  async #warmupCache(): Promise<void> {
    if (!this.#dmCache) return;
    try {
      await this.#dmCache.warmup();
      debugLog(`[watcher:warmupCache] (${this.#config.userId}) complete`);
    } catch {
      debugLog(`[watcher:warmupCache] (${this.#config.userId}) failed (non-fatal)`);
    }
  }

  /** Handle m.direct account_data updates from /sync.  Writes through
   *  the chain so all layers stay consistent. */
  #processAccountData(resp: SyncResponse): void {
    const events = resp.account_data?.events ?? [];
    for (const evt of events) {
      if (evt.type !== 'm.direct') continue;
      const content = evt.content as Record<string, string[]>;
      const cache = this.#dmCache;
      if (!cache) return;
      for (const [mxid, roomIds] of Object.entries(content)) {
        for (const roomId of roomIds) {
          cache.set({ tag: 'roomid', value: roomId }, mxid).catch(() => {});
        }
      }
    }
  }


  async #joinRoom(roomId: string): Promise<void> {
    if (!this.#client) return;
    await this.#client.join(roomId);
  }

  #trackSeen(eventId: string): void {
    if (this.#seenEvents.size >= this.#maxSeen) {
      const toDelete = Math.floor(this.#maxSeen / 2);
      let i = 0;
      for (const id of this.#seenEvents) {
        if (i >= toDelete) break;
        this.#seenEvents.delete(id);
        i++;
      }
    }
    this.#seenEvents.add(eventId);
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  // ── public methods ──────────────────────────────────────────────────────

  get client(): MatrixClient | null { return this.#client; }

  /** Expose the in-memory cache layer (for tests). */
  get dmMemory(): BiDiMemorySource | null { return this.#dmMemory; }

  /** Resolve whether a room is a DM via the 3-layer chain. */
  async resolveDm(roomId: string): Promise<{ isDm: boolean; members: string[] }> {
    if (!this.#client) return { isDm: false, members: [] };
    if (!this.#dmCache) return { isDm: false, members: [] };

    const peer = await this.#dmCache.get({ tag: 'roomid', value: roomId });
    if (peer) {
      return { isDm: true, members: [this.#client.userId, peer] };
    }
    return { isDm: false, members: [] };
  }

  /** Find the DM room for `mxid` via the chain.  The source-of-truth
   *  layer (joinedRoomsSource) creates the room on miss, and the chain
   *  automatically propagates the result to all faster layers. */
  async findOrCreateRoom(mxid: string): Promise<string> {
    if (!this.#client) throw new Error('MatrixWatcher: not connected');
    debugLog(`[watcher:findOrCreateRoom] (${this.#config.userId}) looking for ${mxid}`);

    if (!this.#dmCache) {
      throw new Error('MatrixWatcher: dmCache not initialised');
    }

    const roomId = await this.#dmCache.get({ tag: 'mxid', value: mxid });
    if (!roomId) {
      throw new Error(`MatrixWatcher: could not find or create room for ${mxid}`);
    }

    debugLog(`[watcher:findOrCreateRoom] (${this.#config.userId}) → ${roomId}`);
    return roomId;
  }
}

// ── error classification ──────────────────────────────────────────────────

function isRecoverable(err: unknown): boolean {
  if (!err) return false;

  if (err instanceof MatrixError) {
    if (err.errcode === "M_REQUEST_TIMEOUT") return true;
    if (err.errcode === "M_CONNECTION_ERROR") return true;
    if (err.status >= 500 && err.status < 600) return true;
    if (err.status === 429) return true;
    return false;
  }

  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    return true;
  }

  return false;
}
