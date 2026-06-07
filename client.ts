// ── Matrix CS API Client ───────────────────────────────────────────────────
//
// Zero-dependency Matrix Client-Server API client built on `node:http` /
// `node:https`.  Covers the small subset of the CS API needed for a
// stateless bot:
//
//   POST /login             — password login, get access_token
//   GET  /sync              — long-poll for new events
//   PUT  /send/{eventType}/{txnId} — send a message
//   POST /join/{roomIdOrAlias}     — join a room (accept invite)
//
// Design notes:
//   - Keeps no in-memory state except the access_token and homeserver URL.
//   - The `sync` method is a long-poll (30s default timeout).  The caller
//     is expected to loop, passing the `next_batch` token from each
//     response.
//   - All methods throw on non-2xx responses with the Matrix error body.
//   - Transaction IDs (`txnId`) are generated as a monotonic counter to
//     guarantee idempotency within a client session.

import * as https from "node:https";
import * as http from "node:http";

// ── types ──────────────────────────────────────────────────────────────────

export interface MatrixConfig {
  /** Homeserver base URL, e.g. "https://matrix.org".  Must include the
   *  scheme. */
  baseUrl: string;

  /** Matrix user ID for login, e.g. "@bot:matrix.org". */
  userId: string;

  /** Password for login. */
  password: string;

  /** Optional device ID.  If omitted, the server assigns one. */
  deviceId?: string;

  /** Initial device display name. */
  initialDeviceDisplayName?: string;

  /** Timeout for individual HTTP requests (ms). Default 30_000. */
  requestTimeout?: number;
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
    join?: Record<string, { timeline?: { events: MatrixEvent[] } }>;
    invite?: Record<string, { invite_state?: { events: MatrixEvent[] } }>;
    leave?: Record<string, unknown>;
  };
}

/** POST /login response. */
export interface LoginResponse {
  user_id: string;
  access_token: string;
  device_id: string;
  home_server: string;
}

/** Response from PUT /send. */
export interface SendResponse {
  event_id: string;
}

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
    this.name = "MatrixError";
  }
}

// ── client ─────────────────────────────────────────────────────────────────

export class MatrixClient {
  #baseUrl: string;
  #accessToken: string;
  #requestTimeout: number;
  #txnCounter: number;
  #userId: string;

  private constructor(
    baseUrl: string,
    accessToken: string,
    userId: string,
    requestTimeout: number,
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.#accessToken = accessToken;
    this.#userId = userId;
    this.#requestTimeout = requestTimeout;
    this.#txnCounter = 0;
  }

  // ── static factory: login ──────────────────────────────────────────────

  /**
   * Log in with password and return a ready-to-use MatrixClient.
   * Throws MatrixError on bad credentials.
   */
  static async login(config: MatrixConfig): Promise<MatrixClient> {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const timeout = config.requestTimeout ?? 30_000;

    const body: Record<string, unknown> = {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: config.userId },
      password: config.password,
    };
    if (config.deviceId) body.device_id = config.deviceId;
    if (config.initialDeviceDisplayName) {
      body.initial_device_display_name = config.initialDeviceDisplayName;
    }

    const resp = await request("POST", `${baseUrl}/_matrix/client/v3/login`, body, undefined, timeout) as LoginResponse;

    return new MatrixClient(baseUrl, resp.access_token, resp.user_id, timeout);
  }

  // ── accessors ──────────────────────────────────────────────────────────

  get userId(): string {
    return this.#userId;
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
  async sync(since?: string, timeoutMs = 30_000): Promise<SyncResponse> {
    const params = new URLSearchParams();
    params.set("timeout", String(timeoutMs));
    if (since) params.set("since", since);
    // Filter out presence and typing notifications — we only care
    // about room events.
    params.set("filter", JSON.stringify({
      presence: { types: [] },
      account_data: { types: [] },
      room: { timeline: { types: ["m.room.message", "m.room.member"] } },
    }));

    const url = `${this.#baseUrl}/_matrix/client/v3/sync?${params.toString()}`;
    const resp = await request("GET", url, undefined, this.#accessToken, this.#requestTimeout) as SyncResponse;

    // The Matrix spec says next_batch is always a string.
    // Some servers are broken and return it as a number — coerce.
    if (typeof resp.next_batch !== "string") {
      resp.next_batch = String(resp.next_batch);
    }
    return resp;
  }

  // ── send ───────────────────────────────────────────────────────────────

  /**
   * Send a message event to a room.  `txnId` is auto-generated as a
   * monotonic counter (idempotent within this client instance).
   *
   * `eventType` is typically `"m.room.message"`.  `content` is the
   * event content dict.
   *
   * Returns the assigned `event_id`.
   */
  async send(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const txnId = `${this.#txnCounter++}`;
    const url =
      `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${txnId}`;
    const resp = await request("PUT", url, content, this.#accessToken, this.#requestTimeout) as SendResponse;
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
    return this.send(roomId, "m.room.message", {
      msgtype: "m.text",
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
    return this.send(roomId, "m.room.message", {
      msgtype: "m.text",
      body,
      format: "org.matrix.custom.html",
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
    const url =
      `${this.#baseUrl}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`;
    const resp = await request("POST", url, {}, this.#accessToken, this.#requestTimeout) as { room_id: string };
    return resp.room_id;
  }

  /**
   * Get the display name for a user in a room.  Returns undefined if
   * not set.
   */
  async getDisplayName(userId: string): Promise<string | undefined> {
    const url =
      `${this.#baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`;
    try {
      const resp = await request("GET", url, undefined, this.#accessToken, this.#requestTimeout) as { displayname?: string };
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
    const url =
      `${this.#baseUrl}/_matrix/client/v3/presence/${encodeURIComponent(this.#userId)}/status`;
    await request("PUT", url, { presence }, this.#accessToken, this.#requestTimeout);
  }

  /**
   * Leave a room.
   */
  async leave(roomId: string): Promise<void> {
    const url =
      `${this.#baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`;
    await request("POST", url, {}, this.#accessToken, this.#requestTimeout);
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function makeBody(
  method: string,
  url: string,
  body: unknown,
  token: string | undefined,
): string {
  // Serialize body to JSON string. GET requests have no body.
  if (method === "GET" || body === undefined) return "";
  return JSON.stringify(body);
}

function makeHeaders(
  method: string,
  url: string,
  token: string | undefined,
  bodyStr: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "matrix-connector/0.1",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (bodyStr.length > 0) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
  }
  return headers;
}

async function request<T>(
  method: string,
  urlString: string,
  body: unknown,
  token: string | undefined,
  timeoutMs: number,
): Promise<T> {
  const bodyStr = makeBody(method, urlString, body, token);
  const url = new URL(urlString);
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  const headers = makeHeaders(method, urlString, token, bodyStr);

  const options: http.RequestOptions & https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers,
    timeout: timeoutMs,
  };

  return new Promise<T>((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed: unknown;
        try {
          parsed = raw.length > 0 ? JSON.parse(raw) : {};
        } catch {
          reject(new Error(`Matrix: invalid JSON response: ${raw.slice(0, 200)}`));
          return;
        }

        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed as T);
          return;
        }

        const err = parsed as Record<string, unknown>;
        reject(
          new MatrixError(
            res.statusCode ?? 0,
            (err.errcode as string) ?? "M_UNKNOWN",
            (err.error as string) ?? `HTTP ${res.statusCode}`,
            parsed,
          ),
        );
      });
    });

    req.on("error", (err) => {
      reject(
        new MatrixError(0, "M_CONNECTION_ERROR", err.message, null),
      );
    });

    req.on("timeout", () => {
      req.destroy();
      reject(
        new MatrixError(0, "M_REQUEST_TIMEOUT", "Request timed out", null),
      );
    });

    if (bodyStr.length > 0) req.write(bodyStr);
    req.end();
  });
}
