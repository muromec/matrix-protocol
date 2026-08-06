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
//
// Usage:
// ```ts
// const watcher = new MatrixWatcher(config);
// watcher.on("message", (event) => {
//   console.log(event.message.text);
// });
// await watcher.start();
// ```

import { MatrixClient, MatrixError, type MatrixConfig, type MatrixEvent, type SyncResponse } from "./client.ts";
import { MatrixMessage } from "./message.ts";
import { loadSyncToken, saveSyncToken } from "./sync-token.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface WatcherConfig {
  /** Matrix homeserver and credentials (passed through to MatrixClient). */
  baseUrl: string;
  userId: string;
  password: string;
  deviceId?: string;
  initialDeviceDisplayName?: string;

  /** /sync long-poll timeout (ms). Default 30_000. */
  syncTimeout?: number;

  /** Delay (ms) before reconnecting after a disconnect. Default 5_000. */
  reconnectDelay?: number;

  /**
   * Filesystem path for persisting the /sync `next_batch` token.
   *
   * When set, the watcher saves the token after every successful
   * /sync response and restores it on the next start.  This means
   * restarts and reconnects only fetch events that arrived after
   * the last processed sync — no replay of old messages.
   *
   * If the file doesn't exist on first start, the watcher does
   * an initial sync (no `since`), then saves the token.
   *
   * If omitted, every reconnect starts from an initial sync,
   * which replays all timeline events from all joined rooms.
   */
  syncTokenPath?: string;
}

export interface WatcherEvent {
  type: "connected" | "disconnected" | "message" | "invite" | "error";
  message?: MatrixMessage;
  roomId?: string;
  inviter?: string;
  error?: Error;
}

// ── watcher ────────────────────────────────────────────────────────────────

export class MatrixWatcher extends EventTarget {
  #config: WatcherConfig;
  #client: MatrixClient | null = null;
  #abortController: AbortController | null = null;

  /** Set of event IDs we've already processed (dedup).  Capped at 10k. */
  #seenEvents = new Set<string>();
  #directs = new Map<string, string>();
  #maxSeen = 10_000;
  #readyPromise: Promise<void>;
  #readyResolve!: () => void;

  /** Current /sync `next_batch` token, persisted to `syncTokenPath`. */
  #syncToken: string | undefined;

  constructor(config: WatcherConfig) {
    super();
    this.#config = config;
    this.#readyPromise = new Promise((resolve) => { this.#readyResolve = resolve; });
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Promise that resolves once #fetchDirects() completes and the cache
   *  is populated.  Resets on reconnect. */
  get ready(): Promise<void> { return this.#readyPromise; }

  /** Start watching.  Resolves when the first connection succeeds.
   *  Runs until `stop()` is called. */
  async start(): Promise<void> {
    console.log('[watcher:lifecycle] start() called');
    if (this.#abortController) {
      console.log('[watcher:lifecycle] already running, skipping');
      return;
    }
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    const syncTimeout = this.#config.syncTimeout ?? 30_000;
    const reconnectDelay = this.#config.reconnectDelay ?? 5_000;

    while (!signal.aborted) {
      let since: string | undefined;

      try {
        // Log in (fresh access token each reconnect).
        this.#client = await MatrixClient.login({
          baseUrl: this.#config.baseUrl,
          userId: this.#config.userId,
          password: this.#config.password,
          deviceId: this.#config.deviceId,
          initialDeviceDisplayName: this.#config.initialDeviceDisplayName,
        });

        this.#readyPromise = new Promise((resolve) => { this.#readyResolve = resolve; });
        this.#emit({ type: "connected" });

        // Announce ourselves as online so clients see a green indicator.
        this.#client.setPresence("online").catch(() => {});
        
        // Set the user-visible display name from identity config.
        if (this.#config.initialDeviceDisplayName && this.#client) {
          this.#client.setDisplayName(this.#config.initialDeviceDisplayName).catch(() => {});
        }

        // Fetch m.direct before processing any messages — the
        // incremental /sync (with saved since token) won't include
        // account_data unless it changed.  Without this, the first
        // messages after reconnection won't detect DMs.
        await this.#fetchDirects();
        this.#cleanupSelfRooms().catch(() => {}); // fire-and-forget, best-effort
        this.#readyResolve();

        // Restore the saved sync token if available (survives restarts).
        if (this.#syncToken === undefined) {
          this.#syncToken = await loadSyncToken(this.#config.syncTokenPath);
        }

        // Use the saved token to skip already-processed events.
        // If this is the very first run, since stays undefined and
        // we do a full initial sync.
        since = this.#syncToken;

        const initResp = await this.#client.sync(since, since ? undefined : 5000);
        this.#processSync(initResp);
        since = initResp.next_batch;

        // Persist the new token immediately so a crash doesn't lose it.
        this.#syncToken = since;
        await saveSyncToken(this.#config.syncTokenPath, since);

        if (signal.aborted) break;

        // Main sync loop.
        while (!signal.aborted) {
          try {
            const resp = await this.#client.sync(since, syncTimeout);
            this.#processSync(resp);
            since = resp.next_batch;

            // Persist the token after every successful sync.
            this.#syncToken = since;
            await saveSyncToken(this.#config.syncTokenPath, since);
          } catch (err) {
            // Classify: is this a recoverable transport error or a
            // fatal auth/server error?
            if (isRecoverable(err)) {
              // Long-poll timeout, connection reset — just retry with
              // the same `since` token.  Don't full-reconnect.
              continue;
            }
            throw err; // re-raise for outer catch → full reconnect
          }
        }

        break; // signal.aborted → exit cleanly
      } catch (err) {
        if (signal.aborted) break;
        this.#emit({ type: "error", error: err as Error });
      }

      // Don't sleep if we're already told to stop.
      if (signal.aborted) break;
      this.#emit({ type: "disconnected" });
      await this.#sleep(reconnectDelay, signal);
    }
  }

  /** Stop watching.  The running /sync loop will exit cleanly. */
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

  /**
   * Process a /sync response: handle invites first, then joined-room
   * timeline events.
   */
  #processSync(resp: SyncResponse): void {
    if (!this.#client) return;

    // 1. Handle invites — auto-join, then emit invite event.
    if (resp.rooms?.invite) {
      for (const [roomId, roomData] of Object.entries(resp.rooms.invite)) {
        const events = roomData?.invite_state?.events ?? [];
        const memberEvent = events.find(
          (e) => e.type === "m.room.member" && e.state_key === this.#client!.userId,
        );
        const inviter = memberEvent?.sender ?? "unknown";
        const membership = memberEvent?.content?.membership;

        if (membership === "invite") {
          // Auto-join in the background.
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

    // 2. Handle account_data (m.direct) updates.
    this.#processAccountData(resp);

    // 3. Handle joined-room timeline events.
    if (resp.rooms?.join) {
      for (const [roomId, roomData] of Object.entries(resp.rooms.join)) {
        const timelineEvents = roomData?.timeline?.events ?? [];

        for (const event of timelineEvents) {
          // Skip events we've already processed.
          if (this.#seenEvents.has(event.event_id)) continue;
          this.#trackSeen(event.event_id);

          // Skip our own messages.
          if (event.sender === this.#client.userId) continue;

          // Only process m.room.message with text/notice.
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

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Lazy DM check: if a room isn't in #directs, query joined_members.
   * If exactly 2 members (self + one peer), mark as DM and return the
   * peer's MXID.  Results are cached in #directs so we only query once
   * per room per connection.
   */
  async #ensureRoomType(roomId: string): Promise<{ isDm: boolean; members: string[] }> {
    if (!this.#client) return { isDm: false, members: [] };

    // Already known — check the map.
    const known = this.#directs.get(roomId);
    if (known) return { isDm: true, members: [this.#client.userId, known] };

    // Lazy: query joined_members.  Fire-and-forget-ish but waited.
    try {
      const joined = await this.#client.getJoinedMembers(roomId);
      const mxids = Object.keys(joined);
      if (mxids.length === 2) {
        const peer = mxids.find((m) => m !== this.#client!.userId) ?? mxids[0];
        this.#directs.set(roomId, peer);
        return { isDm: true, members: mxids };
      }
    } catch {
      // Not joined or error — not a DM we can detect.
    }

    return { isDm: false, members: [] };
  }

  /**
   * Fetch m.direct explicitly and seed the #directs map.
   * Called on connect to ensure DM detection works from the start —
   * the incremental /sync response may not include account_data.
   */
  /** Leave rooms where the only member is self.  Best-effort cleanup
   *  for rooms created by buggy `findOrCreateRoom` calls. */
  async #cleanupSelfRooms(): Promise<void> {
    if (!this.#client) return;
    try {
      const joined = await this.#client.getJoinedRooms();
      const userId = this.#config.userId;
      for (const roomId of joined) {
        try {
          const members = await this.#client.getJoinedMembers(roomId);
          const memberIds = Object.keys(members);
          if (memberIds.length === 1 && memberIds[0] === userId) {
            await this.#client.leave(roomId);
          }
        } catch {
          // Can't check this room — skip it.
        }
      }
    } catch {
      // Can't list joined rooms — skip cleanup.
    }
  }

  async #fetchDirects(): Promise<void> {
    if (!this.#client) return;
    try {
      const raw = await this.#client.getAccountData('m.direct');
      const content = raw as Record<string, string[]>;
      let count = 0;
      for (const [mxid, roomIds] of Object.entries(content)) {
        for (const roomId of roomIds) {
          this.#directs.set(roomId, mxid);
          count++;
        }
      }
      console.log(`[watcher:fetchDirects] (${this.#config.userId}) seeded ${count} entries from m.direct`);
    } catch {
      console.log(`[watcher:fetchDirects] (${this.#config.userId}) m.direct fetch failed (may not exist yet)`);
    }
  }

  /**
   * Parse account_data events for m.direct and rebuild the
   * roomId → mxid map.  Called on every /sync response that
   * includes account_data.
   */
  #processAccountData(resp: SyncResponse): void {
    const events = resp.account_data?.events ?? [];
    for (const evt of events) {
      if (evt.type !== 'm.direct') continue;
      const content = evt.content as Record<string, string[]>;
      this.#directs.clear();
      for (const [mxid, roomIds] of Object.entries(content)) {
        for (const roomId of roomIds) {
          this.#directs.set(roomId, mxid);
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
      // Cull half the set to avoid unbounded growth.
      const entries = [...this.#seenEvents];
      this.#seenEvents = new Set(entries.slice(entries.length / 2));
    }
    this.#seenEvents.add(eventId);
  }

  /** Expose the client for direct API calls (e.g. typing indicators). */
  get client(): MatrixClient | null {
    return this.#client;
  }

  /** Expose the roomId → mxid map for known DM rooms. */
  get directs(): ReadonlyMap<string, string> {
    return this.#directs;
  }

  /**
   * Resolve whether a room is a DM.  Uses the cached #directs map if
   * available, otherwise queries joined_members (single HTTP call per
   * room, cached for the rest of the connection).
   */
  resolveDm(roomId: string): Promise<{ isDm: boolean; members: string[] }> {
    return this.#ensureRoomType(roomId);
  }

  // ── DM room resolution ────────────────────────────────────────────────

  /**
   * Find an existing DM room for `mxid` or create one.
   *
   * 1. Check the in-memory `#directs` map (populated from /sync
   *    account_data).  Cross-reference with `getJoinedRooms()` to
   *    prune stale entries.
   * 2. If not found, fetch `m.direct` explicitly as a fallback.
   * 3. If still not found, create a new DM room, invite `mxid`,
   *    update `m.direct` account data, and seed `#directs`.
   *
   * Returns the room ID.
   * Throws on network/auth errors — caller should handle gracefully.
   */
  async findOrCreateRoom(mxid: string): Promise<string> {
    console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) looking for ${mxid}`);
    if (!this.#client) {
      throw new Error('MatrixWatcher: not connected — no client');
    }

    // ── 1. Check in-memory map (populated from sync) ──────────────────
    let roomId = await this.#lookupDmRoom(mxid);
    if (roomId) {
      console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) cache hit → ${roomId}`);
      return roomId;
    }
    console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) cache miss, falling back to m.direct`);

    // ── 2. Explicit fallback: fetch m.direct ──────────────────────────
    try {
      const directs = await this.#client.getAccountData('m.direct');
      const dict = directs as Record<string, string[]>;
      const roomIds = dict[mxid] ?? [];
      if (roomIds.length > 0) {
        // Verify we're still joined to at least one.
        const joined = await this.#client.getJoinedRooms();
        const valid = roomIds.filter((rid) => joined.includes(rid));
        if (valid.length === 1) {
          console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) m.direct fallback, 1 valid → ${valid[0]}`);
          this.#directs.set(valid[0], mxid);
          return valid[0];
        }
        if (valid.length > 1) {
          console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) m.direct fallback, ${valid.length} valid, checking membership`);
          // Multiple rooms — pick the one where the target is a member.
          for (const rid of valid) {
            try {
              const members = await this.#client.getJoinedMembers(rid);
              if (Object.keys(members).includes(mxid)) {
                console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) membership verified → ${rid}`);
                this.#directs.set(rid, mxid);
                return rid;
              }
              console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) ${mxid} not in ${rid} members`);
            } catch {
              console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) membership check failed for ${rid}, skipping`);
            }
          }
          // None verified — return the first joined room.
          console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) none verified, falling back to first → ${valid[0]}`);
          this.#directs.set(valid[0], mxid);
          return valid[0];
        }
      }
    } catch {
      // m.direct may not exist yet (404) — that's fine, proceed to create.
    }

    // ── 3. Create new DM room ─────────────────────────────────────────
    console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) creating new DM for ${mxid}`);
    roomId = await this.#client.createRoom({
      is_direct: true,
      invite: [mxid],
      preset: 'trusted_private_chat',
    });

    // Update m.direct: merge with existing, persist, seed map.
    try {
      let existing: Record<string, string[]> = {};
      try {
        existing = await this.#client.getAccountData('m.direct') as Record<string, string[]>;
      } catch {
        // No existing m.direct — start fresh.
      }

      const updated = { ...existing };
      updated[mxid] = [...(existing[mxid] ?? []), roomId];

      await this.#client.setAccountData('m.direct', updated);
    } catch {
      // Room was created but m.direct update failed — still return the
      // room ID.  The next /sync will pick it up.
    }

    console.log(`[watcher:findOrCreateRoom] (${this.#config.userId}) created → ${roomId}`);
    this.#directs.set(roomId, mxid);
    return roomId;
  }

  /**
   * Look up a DM room for `mxid` from the in-memory `#directs` map,
   * verifying the room is still joined.
   */
  async #lookupDmRoom(mxid: string): Promise<string | null> {
    // Find all rooms pointing to this mxid
    const candidates: string[] = [];
    for (const [rid, peer] of this.#directs) {
      if (peer === mxid) candidates.push(rid);
    }
    console.log(`[watcher:lookupDmRoom] (${this.#config.userId}) ${mxid}: ${candidates.length} cached, map size=${this.#directs.size}`);
    if (candidates.length === 0) return null;

    // Verify at least one is still joined and has the target as a member.
    try {
      const joined = await this.#client!.getJoinedRooms();
      const valid = candidates.filter((rid) => joined.includes(rid));
      if (valid.length === 0) return null;
      if (valid.length === 1) return valid[0];
      // Multiple candidates — pick the one where the target is a member.
      for (const rid of valid) {
        try {
          const members = await this.#client!.getJoinedMembers(rid);
          if (Object.keys(members).includes(mxid)) return rid;
        } catch {
          // Can't check this room — skip it.
        }
      }
      // None verified — return the first joined room anyway.
      return valid[0];
    } catch {
      // Can't verify — trust the map for now.
      return candidates[0];
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}



// ── error classification ──────────────────────────────────────────────────

/**
 * Returns true if the error is a transient transport-level failure
 * that should be retried with the same sync token (no full reconnect).
 *
 * Recoverable: timeouts, connection resets, DNS failures, 5xx server
 * errors from reverse proxies.
 *
 * Fatal (not recoverable): 401 (bad token → re-login), 403 (forbidden),
 * 400 (bad request — probably a logic bug).
 */
function isRecoverable(err: unknown): boolean {
  if (!err) {
    return false;
  }

  if (err instanceof MatrixError) {
    // Transport-level Matrix errors from our client.
    if (err.errcode === "M_REQUEST_TIMEOUT") return true;
    if (err.errcode === "M_CONNECTION_ERROR") return true;
    // 502/503/504 from reverse proxies between us and the homeserver.
    if (err.status >= 500 && err.status < 600) return true;
    // Rate limiting — back off and retry.
    if (err.status === 429) return true;
    // Anything else (401, 403, 400, etc.) is fatal.
    return false;
  }

  // Non-Matrix errors (bare network errors, AbortError from signal, etc.).
  if (err instanceof Error) {
    // AbortError means stop() was called — not really an error.
    if (err.name === "AbortError") return false;
    // All other network-level errors: retry.
    return true;
  }

  return false;
}
