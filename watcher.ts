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
  #maxSeen = 10_000;

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

        // Initial sync: get a `next_batch` token.  Use a short timeout
        // so we don't block for 30s on first connect.
        const initResp = await this.#client.sync(undefined, 5000);
        this.#processSync(initResp);
        since = initResp.next_batch;

        if (signal.aborted) break;

        // Main sync loop.
        while (!signal.aborted) {
          try {
            const resp = await this.#client.sync(since, syncTimeout);
            this.#processSync(resp);
            since = resp.next_batch;
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

    // 2. Handle joined-room timeline events.
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
