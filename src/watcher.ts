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

import { MatrixClient, MatrixError, type MatrixEvent, type SyncResponse } from './client.ts';
import { MatrixMessage, isMediaMessageType } from './message.ts';
import { loadState, saveState, type ClientState } from './state.ts';
import { loadSyncToken } from './sync-token.ts';
import { chain } from './data-sources/chain.ts';
import type { DataSource, Warmable } from './data-sources/types.ts';
import { BiDiMemorySource } from './data-sources/bi-di-memory.ts';
import type { DmKey } from './data-sources/bi-di-memory.ts';
import { mDirectSource } from './data-sources/m-direct.ts';
import { joinedRoomsSource } from './data-sources/joined-rooms.ts';
import {
  isRtcMemberEvent,
  readRtcMembership,
  rtcCallsInRoom,
  type RtcCall,
  type RtcMembership,
} from './rtc.ts';

// ── types ──────────────────────────────────────────────────────────────────

export interface WatcherConfig {
  baseUrl: string;
  userId: string;
  password: string;
  deviceId?: string;
  initialDeviceDisplayName?: string;
  syncTimeout?: number;
  /**
   * How much life an access token must have left before a request is allowed to start on it.
   *
   * Three sync timeouts, or whatever is larger: a long poll must never be the thing that discovers
   * an expired token, so the margin is measured in whole requests rather than in seconds, and a
   * deployment that lengthens its poll lengthens the margin with it.
   */
  tokenMarginMs?: number;
  reconnectDelay?: number;
  /**
   * Where the session lives: the tokens, the device and the sync position, in one file.  Omitted,
   * nothing is persisted and every start logs in with the password.
   */
  statePath?: string;
  /**
   * The token file written before the session file existed.  Read once, to seed a fresh session, so
   * a restart does not replay events; drop the setting when no deployment carries the old file.
   */
  syncTokenPath?: string;
  /**
   * The room event types this watcher hands over, in the order a caller wrote them.
   *
   * `m.room.message` alone by default, which is what it has always been: a caller that wants a
   * widget's own events, a poll's answers or the room's state names them here, and gets the whole
   * event on `message.event`.
   */
  eventTypes?: readonly string[];
  /** Skip events this account sent.  Default true; false is for a caller that wants its own back. */
  ignoreOwn?: boolean;
  /**
   * Where this library's own lines go.
   *
   * A caller routes them to the logger it already has — the harness names them `matrix:<persona>`
   * — so nothing here writes to a global.  Without one they go to the console under `DEBUG`.
   */
  debugSink?: (line: string) => void;
}

export interface WatcherEvent {
  type: 'connected' | 'disconnected' | 'message' | 'invite' | 'error' | 'call' | 'ring';
  message?: MatrixMessage;
  roomId?: string;
  inviter?: string;
  error?: Error;
  call?: CallChange;
  ring?: RingNotice;
}

/** What changed about a call, and the call as it stands after the change. */
export interface CallChange {
  slot: string;
  change: 'joined' | 'left' | 'updated';
  /** The member the change is about. */
  member: RtcMembership;
  /** True when that member is this client. */
  mine: boolean;
  /** The call after the change. */
  call: RtcCall;
}

/** A ring: somebody wants a call with us in this room. */
export interface RingNotice {
  /** The slot the ring names, when it names one. */
  slot?: string;
  sender: string;
  lifetimeMs?: number;
}

// ── watcher ────────────────────────────────────────────────────────────────

const DEBUG = process.env.DEBUG?.includes('matrix') || process.env.DEBUG?.includes('*');
const debugLog = (...args: unknown[]) => {
  if (DEBUG) console.log(...args);
};

export class MatrixWatcher extends EventTarget {
  #config: WatcherConfig;
  /** The event types this watcher hands over, and whether this account's own are skipped. */
  #wantedTypes: Set<string>;
  #ignoreOwn: boolean;
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

  /** The record this watcher persists: the credentials, and the position of the last sync. */
  #state: ClientState = {};
  #stateLoaded = false;

  /** The latest membership event per room and state key.  A call is room
   *  state, so what is held is the state, not a stream of deltas. */
  #rtcState = new Map<string, Map<string, MatrixEvent>>();

  constructor(config: WatcherConfig) {
    super();
    this.#config = config;
    this.#wantedTypes = new Set(config.eventTypes ?? ['m.room.message']);
    this.#ignoreOwn = config.ignoreOwn ?? true;
    this.#readyPromise = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
  }

  // ── public API ──────────────────────────────────────────────────────────

  get ready(): Promise<void> {
    return this.#readyPromise;
  }

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
    // A token is renewed when less than this much of it is left, and the margin is three long
    // polls, so the two clocks cannot meet: the poll outlives nothing.
    const tokenMargin = Math.max(this.#config.tokenMarginMs ?? 0, syncTimeout * 3);

    while (!signal.aborted) {
      let since: string | undefined;

      try {
        this.#client = await this.#openClient();

        this.#readyPromise = new Promise((resolve) => {
          this.#readyResolve = resolve;
        });
        this.#emit({ type: 'connected' });

        this.#client.setPresence('online').catch(() => {});
        if (this.#config.initialDeviceDisplayName && this.#client) {
          this.#client.setDisplayName(this.#config.initialDeviceDisplayName).catch(() => {});
        }

        // Build the DM cache chain and validate stale entries.
        await this.#createCache();
        await this.#warmupCache();
        this.#readyResolve();

        since = await this.#storedSyncToken();

        await this.#keepTokenFresh(tokenMargin);
        const initResp = await this.#client.sync(since, since ? undefined : 5000, signal);
        this.#processSync(initResp);
        since = initResp.next_batch;

        await this.#storeSyncToken(since);

        if (signal.aborted) break;

        while (!signal.aborted) {
          try {
            await this.#keepTokenFresh(tokenMargin);
            const resp = await this.#client.sync(since, syncTimeout, signal);
            this.#processSync(resp);
            since = resp.next_batch;

            await this.#storeSyncToken(since);
          } catch (err) {
            if (isRecoverable(err)) continue;
            throw err;
          }
        }

        break;
      } catch (err) {
        if (signal.aborted) break;
        // A refused token is not a transport failure: it is a session that has to be renewed, and
        // the next pass of the loop does that instead of retrying the same dead token.  It is not
        // reported upwards either — a caller that treats an error as fatal would take a renewal
        // for a death, which is exactly how a five-minute token killed every transport.
        await this.#renewSpentSession(err);
        if (!isSpentToken(err)) this.#emit({ type: 'error', error: err as Error });
      }

      if (signal.aborted) break;
      this.#emit({ type: 'disconnected' });
      await this.#sleep(reconnectDelay, signal);
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────

  /** The record this watcher persists, read from disk once. */
  async #stateNow(): Promise<ClientState> {
    if (!this.#stateLoaded) {
      this.#stateLoaded = true;
      this.#state = await loadState(this.#config.statePath);
      if (this.#state.syncToken === undefined && this.#config.syncTokenPath) {
        const legacy = await loadSyncToken(this.#config.syncTokenPath);
        if (legacy !== undefined) {
          this.#state.syncToken = legacy;
          await this.#persistState();
        }
      }
    }
    return this.#state;
  }

  async #persistState(): Promise<void> {
    await saveState(this.#config.statePath, this.#state);
  }

  async #storedSyncToken(): Promise<string | undefined> {
    return (await this.#stateNow()).syncToken;
  }

  async #storeSyncToken(token: string): Promise<void> {
    const state = await this.#stateNow();
    state.syncToken = token;
    await this.#persistState();
  }

  /** A client built on the stored credentials, or a fresh login when there are none. */
  async #openClient(): Promise<MatrixClient> {
    const state = await this.#stateNow();
    if (state.session) {
      return MatrixClient.fromSession({
        baseUrl: this.#config.baseUrl,
        userId: state.session.userId || this.#config.userId,
        deviceId: state.session.deviceId,
        accessToken: state.session.accessToken,
        ...(state.session.refreshToken === undefined
          ? {}
          : { refreshToken: state.session.refreshToken }),
      });
    }

    const client = await MatrixClient.login({
      baseUrl: this.#config.baseUrl,
      userId: this.#config.userId,
      password: this.#config.password,
      deviceId: this.#config.deviceId,
      initialDeviceDisplayName: this.#config.initialDeviceDisplayName,
      useRefreshTokens: true,
    });
    // Only the credentials are replaced: the sync position is a part of the record, not of a login.
    state.session = {
      userId: client.userId,
      deviceId: client.deviceId,
      accessToken: client.accessToken,
      ...(client.refreshToken === undefined ? {} : { refreshToken: client.refreshToken }),
    };
    if (client.accessTokenLifetimeMs !== undefined) {
      state.session.expiresAtMs = Date.now() + client.accessTokenLifetimeMs;
    }
    await this.#persistState();
    return client;
  }

  /**
   * Exchange the refresh token for a new pair, and record when the new access token dies.
   *
   * Answers false when the server refused it — a spent refresh token, or none at all — which
   * leaves the password as the only door.  The sync position is not touched.
   */
  async #refreshSession(): Promise<boolean> {
    const state = await this.#stateNow();
    const session = state.session;
    if (!session?.refreshToken) return false;

    try {
      const issuedAt = Date.now();
      const resp = await MatrixClient.refresh(this.#config.baseUrl, session.refreshToken);
      session.accessToken = resp.access_token;
      if (resp.refresh_token !== undefined) session.refreshToken = resp.refresh_token;
      if (resp.expires_in_ms !== undefined) session.expiresAtMs = issuedAt + resp.expires_in_ms;
      await this.#persistState();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Renew the access token when less of it is left than the margin, and hand the new one to the
   * client.  Called before every sync, so the loop's own pace is the clock and nothing here needs
   * a timer.  A token whose expiry the server never stated is left alone: only a refusal can
   * report it, and that path renews as well.
   */
  async #keepTokenFresh(marginMs: number): Promise<void> {
    const state = await this.#stateNow();
    const session = state.session;
    if (!session || session.refreshToken === undefined) return;
    if (session.expiresAtMs === undefined) return;
    if (session.expiresAtMs - Date.now() > marginMs) return;
    if (!(await this.#refreshSession())) return;
    if (this.#client) this.#client.setAccessToken(session.accessToken);
  }

  /**
   * The server refused the access token.  Refresh it when a refresh token can, else drop the
   * credentials so the next pass logs in; either way the caller stops retrying the dead token.
   */
  async #renewSpentSession(err: unknown): Promise<void> {
    if (!isSpentToken(err)) return;
    const state = await this.#stateNow();
    if (!state.session) return;
    if (await this.#refreshSession()) return;
    state.session = undefined;
    await this.#persistState();
  }

  stop(): void {
    this.#abortController?.abort();
    this.#abortController = null;
  }

  // ── events ──────────────────────────────────────────────────────────────

  on(
    type: 'message' | 'connected' | 'disconnected' | 'invite' | 'error' | 'call' | 'ring',
    listener: (event: WatcherEvent) => void,
  ): void {
    this.addEventListener(type, (e) => listener((e as CustomEvent<WatcherEvent>).detail));
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
          (e) => e.type === 'm.room.member' && e.state_key === this.#client!.userId,
        );
        const inviter = memberEvent?.sender ?? 'unknown';
        const membership = memberEvent?.content?.membership;

        if (membership === 'invite') {
          this.#joinRoom(roomId).catch((err) => {
            this.#emit({
              type: 'error',
              error: new Error(`Failed to join room ${roomId}: ${(err as Error).message}`),
            });
          });
          this.#emit({ type: 'invite', roomId, inviter });
        }
      }
    }

    this.#processAccountData(resp);
    this.#processToDevice(resp);

    if (resp.rooms?.join) {
      for (const [roomId, roomData] of Object.entries(resp.rooms.join)) {
        // A call is room state: one that is already up arrives in the state
        // block of the first sync, and every change after that in the timeline.
        const events = [...(roomData?.state?.events ?? []), ...(roomData?.timeline?.events ?? [])];

        for (const event of events) {
          if (this.#seenEvents.has(event.event_id)) {
            // Said out loud rather than swallowed: the sync cursor is what prevents a replay, so
            // every time this fires is evidence about whether the set earns its memory.
            this.#say(`[watcher] ${event.event_id} was already seen — dropping it (${event.type})`);
            continue;
          }
          this.#trackSeen(event.event_id);

          if (isRtcMemberEvent(event)) {
            this.#processMembership(roomId, event);
            continue;
          }

          if (!this.#wantedTypes.has(event.type)) continue;
          if (this.#ignoreOwn && event.sender === this.#client.userId) continue;

          const msg = MatrixMessage.fromEvent(event, roomId);

          // Inside a message, words and files are what is worth handing on.  Any other event type
          // was asked for by name, so it goes over whatever it holds — its content is on
          // `msg.event`, and a poll answer has no body at all.
          if (event.type === 'm.room.message') {
            const msgtype = event.content?.msgtype as string | undefined;
            if (msgtype !== 'm.text' && msgtype !== 'm.notice' && !isMediaMessageType(msgtype)) {
              continue;
            }
            if (msg.text.length === 0 && !msg.media) continue;
          }

          this.#emit({ type: 'message', message: msg, roomId });
        }
      }
    }
  }

  /** A membership event, as a change to the call it belongs to.  The call
   *  after the change travels with it, so a reader does not have to keep the
   *  call's state itself. */
  #processMembership(roomId: string, event: MatrixEvent): void {
    const membership = readRtcMembership(event);
    if (!membership) return;

    const byKey = this.#rtcState.get(roomId) ?? new Map<string, MatrixEvent>();
    const previous = byKey.get(membership.stateKey);
    byKey.set(membership.stateKey, event);
    this.#rtcState.set(roomId, byKey);

    const wasInCall = previous ? (readRtcMembership(previous)?.inCall ?? false) : false;
    let change: CallChange['change'] = 'updated';
    if (membership.inCall && !wasInCall) change = 'joined';
    if (!membership.inCall && wasInCall) change = 'left';

    const call = rtcCallsInRoom([...byKey.values()]).find((c) => c.slot === membership.slot) ?? {
      slot: membership.slot,
      application: membership.application,
      callId: membership.callId,
      members: [],
      all: [],
    };

    this.#emit({
      type: 'call',
      roomId,
      call: {
        slot: membership.slot,
        change,
        member: membership,
        mine: membership.userId === this.#client?.userId,
        call,
      },
    });
  }

  /** Rings arrive to-device.  A call that is merely announced (a notification
   *  of `notify` rather than `ring`) is not news here: the call itself arrives
   *  as a membership. */
  #processToDevice(resp: SyncResponse): void {
    for (const event of resp.to_device?.events ?? []) {
      if (event.type !== 'm.call.notify') continue;

      const content = event.content;
      if (content['notification_type'] !== 'ring') continue;

      const slot = typeof content['slot_id'] === 'string' ? content['slot_id'] : undefined;
      const lifetimeMs = typeof content['lifetime'] === 'number' ? content['lifetime'] : undefined;
      void this.#emitRing(event.sender, slot, lifetimeMs);
    }
  }

  /** A ring names no room: it comes from a user, and the room it is about is
   *  the DM room with that user. */
  async #emitRing(
    sender: string,
    slot: string | undefined,
    lifetimeMs: number | undefined,
  ): Promise<void> {
    let roomId: string | undefined;
    try {
      roomId = (await this.#dmCache?.get({ tag: 'mxid', value: sender })) ?? undefined;
    } catch {
      roomId = undefined;
    }
    this.#emit({ type: 'ring', roomId, ring: { slot, sender, lifetimeMs } });
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
      debugLog(
        `[watcher:createCache] (${this.#config.userId}) m.direct fetch failed (may not exist yet)`,
      );
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

  /** Say something: to the caller's sink when it gave one, otherwise the console under DEBUG. */
  #say(line: string): void {
    const sink = this.#config.debugSink;
    if (sink) sink(line);
    else debugLog(line);
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
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // ── public methods ──────────────────────────────────────────────────────

  get client(): MatrixClient | null {
    return this.#client;
  }

  /** Expose the in-memory cache layer (for tests). */
  get dmMemory(): BiDiMemorySource | null {
    return this.#dmMemory;
  }

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

/** A refused token: a renewal, not a transport failure. */
function isSpentToken(err: unknown): boolean {
  return err instanceof MatrixError && err.errcode === 'M_UNKNOWN_TOKEN';
}

function isRecoverable(err: unknown): boolean {
  if (!err) return false;

  if (err instanceof MatrixError) {
    if (err.errcode === 'M_REQUEST_TIMEOUT') return true;
    if (err.errcode === 'M_CONNECTION_ERROR') return true;
    if (err.status >= 500 && err.status < 600) return true;
    if (err.status === 429) return true;
    return false;
  }

  if (err instanceof Error) {
    if (err.name === 'AbortError') return false;
    return true;
  }

  return false;
}
