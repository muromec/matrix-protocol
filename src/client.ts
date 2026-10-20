// ── Matrix CS API Client ───────────────────────────────────────────────────
//
// Zero-dependency Matrix Client-Server API client built on the platform's `fetch`.  Covers the small
// subset of the CS API a stateless bot needs:
//
//   POST /login             — password login, get access_token
//   GET  /sync              — long-poll for new events
//   PUT  /send/{eventType}/{txnId} — send a message
//   POST /join/{roomIdOrAlias}     — join a room (accept invite)
//
// Design notes:
//   - Keeps access_token, homeserver URL, and current presence state.
//   - The `sync` method is a long-poll (30s default timeout).  The caller
//     is expected to loop, passing the `next_batch` token from each
//     response.
//   - All methods throw on non-2xx responses with the Matrix error body.
//   - Transaction IDs (`txnId`) are `<epoch-ms>-<seq>`: unique per send, and not repeated
//     across a restart the way a bare counter was.

import { RTC_MEMBER_TYPES } from './rtc.ts';

// Transaction ids are minted per send: the time it was made, and a sequence to separate two
// sends in the same millisecond.
let txnSeq = 0;

// The device every client presents unless its config names one: a login that lets the server choose
// hands back a fresh device each time, and the watcher logs in again on every reconnect.
export const DEFAULT_DEVICE_ID = 'matrix-protocol';

// ── types ──────────────────────────────────────────────────────────────────

export interface MatrixConfig {
  /** Homeserver base URL, e.g. "https://matrix.org".  Must include the
   *  scheme. */
  baseUrl: string;

  /** Matrix user ID for login, e.g. "@bot:matrix.org". */
  userId: string;

  /** Password for login. */
  password: string;

  /** Device ID.  Defaults to `DEFAULT_DEVICE_ID`, so a reconnect is the same device. */
  deviceId?: string;

  /** Initial device display name. */
  initialDeviceDisplayName?: string;

  /** Timeout for individual HTTP requests (ms). Default 30_000. */
  requestTimeout?: number;

  /** Ask for a refresh token at login: it renews the session without the password. */
  useRefreshTokens?: boolean;
}

/** Raw Matrix event as delivered by /sync.  Only the subset of fields we
 *  care about for a text-message bot. */
export interface MatrixEvent {
  type: string; // e.g. "m.room.message", "m.room.member"
  sender: string; // full MXID of sender
  event_id: string;
  origin_server_ts: number;
  room_id: string;
  content: Record<string, unknown>;
  /** Present on state events (like m.room.member). */
  state_key?: string;
  /** Present on membership state events. */
  unsigned?: {
    prev_content?: Record<string, unknown>;
    age?: number;
  };
}

/** Top-level /sync response (abridged — only the fields we use). */
export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        /** A call that is already up arrives here on the first sync. */
        state?: { events: MatrixEvent[] };
        timeline?: { events: MatrixEvent[] };
      }
    >;
    invite?: Record<string, { invite_state?: { events: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
  /** To-device events: rings arrive here, and they carry no room. */
  to_device?: { events?: ToDeviceEvent[] };
  account_data?: {
    events?: Array<{ type: string; content: Record<string, unknown> }>;
  };
}

/** A to-device event as /sync delivers it: no event ID, no room. */
export interface ToDeviceEvent {
  type: string;
  sender: string;
  content: Record<string, unknown>;
}

/** POST /login response. */
export interface LoginResponse {
  user_id: string;
  access_token: string;
  device_id: string;
  home_server: string;
  /** Present when the login asked for one (`useRefreshTokens`). */
  refresh_token?: string;
  /** How long the access token lasts, when the server says. */
  expires_in_ms?: number;
}

/** POST /refresh response.  A refresh replaces both tokens. */
export interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in_ms?: number;
}

/** Response from PUT /send. */
export interface SendResponse {
  event_id: string;
}

/** Request body for POST /createRoom. */
export interface CreateRoomRequest {
  is_direct?: boolean;
  invite?: string[];
  preset?: string;
  name?: string;
}

/** POST /openid/request_token response: the credential a focus accepts in the
 *  older dialect, verified against the homeserver rather than by us. */
export interface OpenIdToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

// ── devices ────────────────────────────────────────────────────────────────

/** A device as the homeserver lists it. */
export interface DeviceInfo {
  device_id: string;
  display_name?: string;
  last_seen_ip?: string;
  last_seen_ts?: number;
}
/** What a focus's token service answers. */
export interface LivekitToken {
  /** The SFU's WebSocket address. */
  url: string;
  /** The participant JWT. */
  jwt: string;
  /** The JWT's `exp` claim, seconds since the epoch, when it has one. */
  expiresAtSec?: number;
}

/** The two token dialects in the wild.  They differ in the identity the token
 *  carries, which a participant can only bind if it can derive the same string:
 *  the older `/sfu/get` writes `@user:server:device`, the current `/get_token`
 *  writes a hash of the member. */
export type RtcTokenDialect = 'legacy' | 'modern';

// ── error ──────────────────────────────────────────────────────────────────

export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  readonly body: unknown;

  constructor(status: number, errcode: string, error: string, body: unknown) {
    super(`Matrix ${status} (${errcode}): ${error}`);
    this.status = status;
    this.errcode = errcode;
    this.body = body;
    this.name = 'MatrixError';
  }
}

// ── client ─────────────────────────────────────────────────────────────────

export class MatrixClient {
  #baseUrl: string;
  #accessToken: string;
  #requestTimeout: number;
  #userId: string;
  #deviceId: string;
  #refreshToken?: string;
  /** How long the token this client logged in with lasts, when the server said. */
  #accessTokenLifetimeMs?: number;
  #currentPresence: string;

  private constructor(
    baseUrl: string,
    accessToken: string,
    userId: string,
    deviceId: string,
    requestTimeout: number,
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ''); // strip trailing slashes
    this.#accessToken = accessToken;
    this.#userId = userId;
    this.#deviceId = deviceId;
    this.#requestTimeout = requestTimeout;
    this.#currentPresence = 'online';
  }

  /**
   * A client for a session that already exists: what a login would have returned, without the
   * password round trip.  The caller owns the tokens and persists what a refresh gives back.
   */
  static fromSession(opts: {
    baseUrl: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    refreshToken?: string;
    requestTimeout?: number;
  }): MatrixClient {
    const client = new MatrixClient(
      opts.baseUrl,
      opts.accessToken,
      opts.userId,
      opts.deviceId,
      opts.requestTimeout ?? 30_000,
    );
    client.#refreshToken = opts.refreshToken;
    return client;
  }

  /** The refresh token this client was built with, if any. */
  get refreshToken(): string | undefined {
    return this.#refreshToken;
  }

  /** How long the access token lasts, when the server said so at login. */
  get accessTokenLifetimeMs(): number | undefined {
    return this.#accessTokenLifetimeMs;
  }

  // ── static factory: login ──────────────────────────────────────────────

  /**
   * Log in with password and return a ready-to-use MatrixClient.
   * Throws MatrixError on bad credentials.
   */
  static async login(config: MatrixConfig): Promise<MatrixClient> {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const timeout = config.requestTimeout ?? 30_000;

    const body: Record<string, unknown> = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: config.userId },
      password: config.password,
    };
    body.device_id = config.deviceId ?? DEFAULT_DEVICE_ID;
    if (config.useRefreshTokens) body.refresh_token = true;
    if (config.initialDeviceDisplayName) {
      body.initial_device_display_name = config.initialDeviceDisplayName;
    }

    const resp = (await request(
      'POST',
      `${baseUrl}/_matrix/client/v3/login`,
      body,
      undefined,
      timeout,
    )) as LoginResponse;

    const client = new MatrixClient(
      baseUrl,
      resp.access_token,
      resp.user_id,
      resp.device_id,
      timeout,
    );
    client.#refreshToken = resp.refresh_token;
    if (resp.expires_in_ms !== undefined) client.#accessTokenLifetimeMs = resp.expires_in_ms;
    return client;
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * The server replaces the refresh token as it hands the new access token out, so the caller must
   * persist both or the next refresh uses a token that no longer exists.
   */
  static async refresh(
    baseUrl: string,
    refreshToken: string,
    requestTimeout = 30_000,
  ): Promise<RefreshResponse> {
    return (await request(
      'POST',
      `${baseUrl.replace(/\/+$/, '')}/_matrix/client/v3/refresh`,
      { refresh_token: refreshToken },
      undefined,
      requestTimeout,
    )) as RefreshResponse;
  }

  // ── accessors ──────────────────────────────────────────────────────────

  get userId(): string {
    return this.#userId;
  }

  /** The device ID the login was given — what an RTC membership names. */
  get deviceId(): string {
    return this.#deviceId;
  }

  /** The token this client authenticates with: what a session file has to hold. */
  get accessToken(): string {
    return this.#accessToken;
  }

  /**
   * Take a newer access token, after a refresh the caller made on this client's behalf.
   *
   * The client is a pipe with a token in it; the caller owns the record the token lives in, so a
   * refresh happens out there and the result is handed in here.
   */
  setAccessToken(token: string): void {
    this.#accessToken = token;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  // ── sync ───────────────────────────────────────────────────────────────

  /**
   * Perform a /sync request.  Pass `since` from the previous response's
   * `next_batch` to poll for new events.
   *
   * This is a long-poll: the server will hold the connection open for up
   * to `timeout` ms (default 30_000) waiting for new events.
   *
   * Returns parsed SyncResponse.  The caller should loop, passing
   * `next_batch` as `since` on each iteration.
   */
  async sync(since?: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<SyncResponse> {
    const params = new URLSearchParams();
    params.set('timeout', String(timeoutMs));
    if (since) params.set('since', since);
    // Filter out presence and typing notifications — we only care
    // about room events.
    params.set(
      'filter',
      JSON.stringify({
        presence: { types: [] },
        account_data: { types: ['m.direct'] },
        room: {
          timeline: { types: ['m.room.message', 'm.room.member', ...RTC_MEMBER_TYPES] },
          // A call is room state: this is what tells us about one that is
          // already up when the watcher starts.
          state: { types: RTC_MEMBER_TYPES },
        },
      }),
    );
    // Carry our current presence on every sync so the server doesn't
    // silently bump us back to "online" (the Matrix spec default when
    // set_presence is omitted — see CS API /sync docs).
    params.set('set_presence', this.#currentPresence);

    const url = `${this.#baseUrl}/_matrix/client/v3/sync?${params.toString()}`;
    // The server holds the connection for `timeoutMs`; a deadline equal to that would abort a
    // healthy long-poll just before its answer arrives, so it gets room on top.
    const deadline = Math.max(this.#requestTimeout, timeoutMs + 10_000);
    const resp = (await request(
      'GET',
      url,
      undefined,
      this.#accessToken,
      deadline,
      signal,
    )) as SyncResponse;

    // The Matrix spec says next_batch is always a string.
    // Some servers are broken and return it as a number — coerce.
    if (typeof resp.next_batch !== 'string') {
      resp.next_batch = String(resp.next_batch);
    }
    return resp;
  }

  // ── send ───────────────────────────────────────────────────────────────

  /**
   * Send a message event to a room.  `txnId` is auto-generated as `<epoch-ms>-<seq>`:
   * unique per send, and not repeated by a restart.
   *
   * `eventType` is typically `"m.room.message"`.  `content` is the
   * event content dict.
   *
   * Returns the assigned `event_id`.
   */
  async send(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string> {
    // A transaction id is the client saying "this exact send".  Time says when it was made; the
    // sequence keeps two sends in the same millisecond apart.  A bare counter said the same thing
    // again after a restart, and the server answered with the older event while the room never
    // saw the message.
    const txnId = `${Date.now()}-${txnSeq++}`;
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${txnId}`;
    const resp = (await request(
      'PUT',
      url,
      content,
      this.#accessToken,
      this.#requestTimeout,
    )) as SendResponse;
    return resp.event_id;
  }

  /**
   * Convenience: send a plain-text message to a room.
   */
  async sendText(
    roomId: string,
    body: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    return this.send(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body,
      ...extra,
    });
  }

  /**
   * Send an HTML+plaintext formatted message to a room.
   */
  async sendHtml(
    roomId: string,
    body: string,
    formattedBody: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    return this.send(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body,
      format: 'org.matrix.custom.html',
      formatted_body: formattedBody,
      ...extra,
    });
  }

  // ── join ───────────────────────────────────────────────────────────────

  /**
   * Join a room by ID or alias.  This is used to accept invites (the
   * server auto-joins on invite, but explicitly joining ensures we're
   * in the room).
   *
   * `roomIdOrAlias` can be a room ID (`!abc:matrix.org`) or alias
   * (`#room:matrix.org`).
   */
  async join(roomIdOrAlias: string): Promise<string> {
    const url = `${this.#baseUrl}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`;
    const resp = (await request('POST', url, {}, this.#accessToken, this.#requestTimeout)) as {
      room_id: string;
    };
    return resp.room_id;
  }

  /**
   * Get the display name for a user in a room.  Returns undefined if
   * not set.
   */
  async getDisplayName(userId: string): Promise<string | undefined> {
    const url = `${this.#baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`;
    try {
      const resp = (await request(
        'GET',
        url,
        undefined,
        this.#accessToken,
        this.#requestTimeout,
      )) as { displayname?: string };
      return resp.displayname;
    } catch (err) {
      if (err instanceof MatrixError && err.status === 404) return undefined;
      throw err;
    }
  }

  /**
   * Set the bot's own presence status.
   *
   * `presence` is one of: "online", "offline", "unavailable".
   */
  async setPresence(presence: string): Promise<void> {
    this.#currentPresence = presence;
    const url = `${this.#baseUrl}/_matrix/client/v3/presence/${encodeURIComponent(this.#userId)}/status`;
    await request('PUT', url, { presence }, this.#accessToken, this.#requestTimeout);
  }

  /** Set the user-visible display name for this account. */
  async setDisplayName(displayname: string): Promise<void> {
    const url = `${this.#baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(this.#userId)}/displayname`;
    await request('PUT', url, { displayname }, this.#accessToken, this.#requestTimeout);
  }

  /**
   * Send a typing notification to a room.
   *
   * `typing` — true to start typing, false to stop.
   * `timeoutMs` — how long before the server considers the typing
   *               stopped if no further notification arrives (default 15_000).
   */

  /**
   * Send a read marker (both fully-read and read receipt) for an event.
   *
   * https://spec.matrix.org/v1.13/client-server-api/#receiving-notifications
   */
  async sendReadMarker(roomId: string, eventId: string): Promise<void> {
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`;
    await request(
      'POST',
      url,
      {
        'm.fully_read': eventId,
        'm.read': eventId,
      },
      this.#accessToken,
      this.#requestTimeout,
    );
  }

  async sendTyping(roomId: string, typing: boolean, timeoutMs = 15_000): Promise<void> {
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.#userId)}`;
    await request(
      'PUT',
      url,
      { typing, timeout: timeoutMs },
      this.#accessToken,
      this.#requestTimeout,
    );
  }

  /**
   * Leave a room.
   */
  async leave(roomId: string): Promise<void> {
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`;
    await request('POST', url, {}, this.#accessToken, this.#requestTimeout);
  }

  // ── account data ───────────────────────────────────────────────────────

  /**
   * Get account data for the logged-in user.
   *
   * `type` is the event type, e.g. `"m.direct"`.
   * Returns the parsed content object, or throws MatrixError on failure.
   */
  async getAccountData(type: string): Promise<Record<string, unknown>> {
    const url = `${this.#baseUrl}/_matrix/client/v3/user/${encodeURIComponent(this.#userId)}/account_data/${encodeURIComponent(type)}`;
    return (await request(
      'GET',
      url,
      undefined,
      this.#accessToken,
      this.#requestTimeout,
    )) as Record<string, unknown>;
  }

  /**
   * Set account data for the logged-in user.
   *
   * `type` is the event type, `content` is the content dict.
   */
  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    const url = `${this.#baseUrl}/_matrix/client/v3/user/${encodeURIComponent(this.#userId)}/account_data/${encodeURIComponent(type)}`;
    await request('PUT', url, content, this.#accessToken, this.#requestTimeout);
  }

  // ── room management ────────────────────────────────────────────────────

  /**
   * Create a new room.
   *
   * `opts` may include `is_direct`, `invite` (list of MXIDs),
   * `preset` (e.g. `"trusted_private_chat"`), and `name`.
   *
   * Returns the new room ID.
   */
  async createRoom(opts: CreateRoomRequest): Promise<string> {
    const url = `${this.#baseUrl}/_matrix/client/v3/createRoom`;
    const resp = (await request('POST', url, opts, this.#accessToken, this.#requestTimeout)) as {
      room_id: string;
    };
    return resp.room_id;
  }

  /**
   * Get the list of rooms the user is currently joined to.
   *
   * Returns an array of room IDs.
   */
  async getJoinedRooms(): Promise<string[]> {
    const url = `${this.#baseUrl}/_matrix/client/v3/joined_rooms`;
    const resp = (await request(
      'GET',
      url,
      undefined,
      this.#accessToken,
      this.#requestTimeout,
    )) as { joined_rooms: string[] };
    return resp.joined_rooms;
  }

  /**
   * Get the list of members in a room.
   *
   * Returns a map of MXID → { display_name, avatar_url }.
   */
  async getJoinedMembers(
    roomId: string,
  ): Promise<Record<string, { display_name?: string; avatar_url?: string }>> {
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`;
    const resp = (await request(
      'GET',
      url,
      undefined,
      this.#accessToken,
      this.#requestTimeout,
    )) as { joined: Record<string, { display_name?: string; avatar_url?: string }> };
    return resp.joined;
  }
  // ── room state ────────────────────────────────────────────────────────────

  /**
   * The room's current state: every state event, of every type.
   *
   * A call lives in state rather than in a timeline (see `rtc.ts`), so a client
   * that wants to know whether a call is up reads it here instead of waiting
   * for a change to arrive through a sync.
   */
  async getRoomState(roomId: string): Promise<MatrixEvent[]> {
    const url = `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
    return (await request(
      'GET',
      url,
      undefined,
      this.#accessToken,
      this.#requestTimeout,
    )) as MatrixEvent[];
  }

  /**
   * Fetch the bytes behind an `mxc://` URL.
   *
   * The authenticated media endpoint (MSC3916).  Measured on this homeserver 2026-10-13: it
   * answers 401 there without a token, and 404 on the legacy `/_matrix/media/v3/download` path,
   * so there is one path to take rather than a fallback to keep.
   *
   * The bytes are the far side's: a file past the cap is refused rather than pulled into memory.
   */
  async downloadMedia(mxcUrl: string): Promise<Uint8Array> {
    const parsed = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUrl);
    if (!parsed) throw new Error(`downloadMedia: not an mxc url: ${mxcUrl}`);

    const url =
      `${this.#baseUrl}/_matrix/client/v1/media/download/` +
      `${encodeURIComponent(parsed[1])}/${encodeURIComponent(parsed[2])}`;

    return requestBytes(url, this.#accessToken, this.#requestTimeout);
  }

  /**
   * Write a room state event.  An empty `stateKey` is the type's default key.
   * Returns the event ID.
   */
  async sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const url =
      `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}` +
      `/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`;
    const resp = (await request(
      'PUT',
      url,
      content,
      this.#accessToken,
      this.#requestTimeout,
    )) as SendResponse;
    return resp.event_id;
  }

  // ── MatrixRTC ─────────────────────────────────────────────────────────────

  /**
   * Ask the homeserver for an OpenID token for this session — the credential a
   * focus's token service accepts in the older dialect.
   */
  async openIdToken(): Promise<OpenIdToken> {
    const url = `${this.#baseUrl}/_matrix/client/v3/user/${encodeURIComponent(this.#userId)}/openid/request_token`;
    return (await request('POST', url, {}, this.#accessToken, this.#requestTimeout)) as OpenIdToken;
  }

  /**
   * Obtain a LiveKit join token for a call from the focus that carries it.
   *
   * Two dialects are in the wild and they differ in the identity the JWT
   * carries, which a participant can only bind if it can derive the same
   * string: the older `/sfu/get` writes `@user:server:device`, the current
   * `/get_token` writes a hash of the member.  A caller that says nothing gets
   * the current one; `rtcTokenDialectInRoom` answers for a room.
   *
   * No bearer is sent — the OpenID token is the credential, and our access token
   * is not carried to the focus's host.
   */
  async getLivekitToken(opts: {
    serviceUrl: string;
    roomId: string;
    slot: string;
    memberId: string;
    /** Which dialect to ask in, for a caller that knows the room's. */
    dialect?: RtcTokenDialect;
  }): Promise<LivekitToken> {
    const openId = await this.openIdToken();
    const legacy = opts.dialect === 'legacy';
    const url = `${opts.serviceUrl.replace(/\/+$/, '')}/${legacy ? 'sfu/get' : 'get_token'}`;
    const body = legacy
      ? { room: opts.roomId, openid_token: openId, device_id: this.#deviceId }
      : {
          room_id: opts.roomId,
          slot_id: opts.slot,
          openid_token: openId,
          member: {
            id: opts.memberId,
            claimed_user_id: this.#userId,
            claimed_device_id: this.#deviceId,
          },
        };
    const resp = (await request('POST', url, body, undefined, this.#requestTimeout)) as {
      url: string;
      jwt: string;
    };

    return { url: resp.url, jwt: resp.jwt, expiresAtSec: jwtExpiry(resp.jwt) };
  }

  // ── devices ────────────────────────────────────────────────────────────

  /** Every device the account has, as the server lists it. */
  async listDevices(): Promise<DeviceInfo[]> {
    const resp = (await request(
      'GET',
      `${this.#baseUrl}/_matrix/client/v3/devices`,
      undefined,
      this.#accessToken,
      this.#requestTimeout,
    )) as { devices?: DeviceInfo[] };
    return resp.devices ?? [];
  }

  /**
   * Delete every device the predicate selects.
   *
   * A device is what a session is: deleting it signs that client out and takes its tokens with it,
   * so the caller decides what may go.  The password is user-interactive auth — the server will not
   * delete a device on a bare access token — and the returned list is what was actually removed.
   *
   * Nothing matching sends no request, so a predicate that keeps everything costs nothing.
   */
  async purgeDevices(
    predicate: (device: DeviceInfo) => boolean,
    password: string,
  ): Promise<string[]> {
    const doomed = (await this.listDevices()).filter(predicate).map((d) => d.device_id);
    if (doomed.length === 0) return [];

    await request(
      'POST',
      `${this.#baseUrl}/_matrix/client/v3/delete_devices`,
      {
        devices: doomed,
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: this.#userId },
          password,
        },
      },
      this.#accessToken,
      this.#requestTimeout,
    );
    return doomed;
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function makeBody(method: string, body: unknown): string {
  // Serialize body to JSON string. GET requests have no body.
  if (method === 'GET' || body === undefined) return '';
  return JSON.stringify(body);
}

// ── JWT ────────────────────────────────────────────────────────────────────

/**
 * A JWT's `exp` claim, in seconds since the epoch, or undefined.
 *
 * Read, never verified: the signature belongs to the service that issued it,
 * and what a caller wants here is only when the credential stops working.
 */
function jwtExpiry(jwt: string): number | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    return typeof claims.exp === 'number' ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

function makeHeaders(token: string | undefined, bodyStr: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'matrix-connector/0.1',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (bodyStr.length > 0) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/** The signal for one request: the caller's, a deadline of ours, or both together. */
function signalFor(timeoutMs: number, caller?: AbortSignal): AbortSignal | undefined {
  const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (caller && deadline) return AbortSignal.any([caller, deadline]);
  return caller ?? deadline;
}

/**
 * Turn what fetch threw into the vocabulary this client has always used.
 *
 * Callers branch on `M_REQUEST_TIMEOUT` and `M_CONNECTION_ERROR`, and a caller's own abort keeps its
 * own name so it is not mistaken for a fault of the transport.
 */
function transportError(err: unknown): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new MatrixError(0, 'M_REQUEST_TIMEOUT', 'Request timed out', null);
  }
  if (err instanceof Error && err.name === 'AbortError') return err;
  return new MatrixError(
    0,
    'M_CONNECTION_ERROR',
    err instanceof Error ? err.message : String(err),
    null,
  );
}

async function request<T>(
  method: string,
  urlString: string,
  body: unknown,
  token: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const bodyStr = makeBody(method, body);
  const headers = makeHeaders(token, bodyStr);

  let res: Response;
  try {
    res = await fetch(urlString, {
      method,
      headers,
      ...(bodyStr.length > 0 ? { body: bodyStr } : {}),
      signal: signalFor(timeoutMs, signal),
    });
  } catch (err) {
    throw transportError(err);
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Matrix: invalid JSON response: ${raw.slice(0, 200)}`);
  }

  if (res.ok) return parsed as T;

  const err = parsed as Record<string, unknown>;
  throw new MatrixError(
    res.status,
    (err.errcode as string) ?? 'M_UNKNOWN',
    (err.error as string) ?? `HTTP ${res.status}`,
    parsed,
  );
}

/** What this client will hold in memory for one media download. */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

/**
 * GET a URL and answer with the body's bytes.
 *
 * A media download is not JSON and its size is the far side's, so it is read as a stream against a
 * cap.  The cap is a safety bound rather than a policy — what counts as too big to hand over is
 * decided where the file is shown.
 */
async function requestBytes(
  urlString: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(urlString, {
      method: 'GET',
      headers: makeHeaders(token, ''),
      signal: signalFor(timeoutMs),
    });
  } catch (err) {
    throw transportError(err);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MEDIA_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MatrixError(
          0,
          'M_MEDIA_TOO_LARGE',
          `media is larger than the ${MAX_MEDIA_BYTES / (1024 * 1024)} MB this client holds`,
          null,
        );
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  if (res.ok) return bytes;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not JSON: the status is what the caller has to read.
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  throw new MatrixError(
    res.status,
    (body.errcode as string) ?? 'M_UNKNOWN',
    (body.error as string) ?? `HTTP ${res.status}`,
    parsed,
  );
}
