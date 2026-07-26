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

  /** Current /sync `next_batch` token, persisted to `syncTokenPath`. */
  #syncToken: string | undefined;

  constructor(config: WatcherConfig) {
    super();
    this.#config = config;
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Start watching.  Resolves when the first connection succeeds.
   *  Runs until `stop()` is called. */
  async start(): Promise<void> {
    if (this.#abortController) return; // already running
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

        this.#emit({ type: "connected" });

        // Announce ourselves as online so clients see a green indicator.
        this.#client.setPresence("online").catch(() => {});

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
    if (!this.#client) {
      throw new Error('MatrixWatcher: not connected — no client');
    }

    // ── 1. Check in-memory map (populated from sync) ──────────────────
    let roomId = this.#lookupDmRoom(mxid);
    if (roomId) return roomId;

    // ── 2. Explicit fallback: fetch m.direct ──────────────────────────
    try {
      const directs = await this.#client.getAccountData('m.direct');
      const dict = directs as Record<string, string[]>;
      const roomIds = dict[mxid] ?? [];
      if (roomIds.length > 0) {
        // Verify we're still joined to at least one.
        const joined = await this.#client.getJoinedRooms();
        for (const rid of roomIds) {
          if (joined.includes(rid)) {
            this.#directs.set(rid, mxid);
            return rid;
          }
        }
      }
    } catch {
      // m.direct may not exist yet (404) — that's fine, proceed to create.
    }

    // ── 3. Create new DM room ─────────────────────────────────────────
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
    if (candidates.length === 0) return null;

    // Verify at least one is still joined.
    try {
      const joined = await this.#client!.getJoinedRooms();
      for (const rid of candidates) {
        if (joined.includes(rid)) return rid;
      }
    } catch {
      // Can't verify — trust the map for now.
      return candidates[0];
    }

    return null; // all candidates are stale
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
