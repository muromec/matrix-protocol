// Unit tests for MatrixClient — uses a mock HTTP server, no real Matrix
// homeserver needed.
//
// Covers:
//   POST /login       — password login, auth token returned
//   GET  /sync        — initial sync, incremental sync with since
//   PUT  /send        — send message, idempotent txnId
//   POST /join        — join room, accept invite
//   Error handling    — 401, 403, 5xx, network errors, timeouts

import { describe, it, expect, afterAll } from 'vitest';
import { MatrixClient, MatrixError } from '../src/client.ts';
import { createServer, type Server } from 'node:http';

// ── mock Matrix homeserver ─────────────────────────────────────────────────
//
// Uses a queue of canned responses.  Each call to `enqueue()` pushes a
// (status, body) pair onto the queue.  Incoming requests are served
// from the queue in FIFO order.  The last request details are captured
// for assertions.

interface CannedResponse {
  status: number;
  body: unknown;
}

type LastRequest = { method: string; path: string; body: string } | null;

class MockMatrixServer {
  #server: Server;
  #queue: CannedResponse[] = [];
  #lastRequest: LastRequest = null;
  /** When set, requests are accepted and never answered. */
  #silent = false;

  port!: number;
  readonly listening: Promise<number>;

  constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        this.#lastRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          body,
        };

        // A silent server takes the request and never answers it.
        if (this.#silent) return;

        // Pop the oldest queued response, or default to 200 {}.
        const canned = this.#queue.shift() ?? { status: 200, body: {} };

        res.writeHead(canned.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(canned.body));
      });
    });

    this.#server.on('error', () => {});

    this.listening = new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.port = (this.#server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  /** Enqueue a response for a future request.  FIFO order. */
  enqueue(status: number, body: unknown): void {
    this.#queue.push({ status, body });
  }

  /** Returns the last request received (method, path, body). */
  get lastRequest(): LastRequest {
    return this.#lastRequest;
  }

  /** Accept requests and never answer them — for the timeout test. */
  silent(): void {
    this.#silent = true;
  }

  /** Shut down the server. */
  close(): void {
    this.#server.close();
  }
}

// ── setup / teardown ───────────────────────────────────────────────────────

const cleanup: MockMatrixServer[] = [];

afterAll(() => {
  for (const srv of cleanup) srv.close();
});

async function newServer(): Promise<MockMatrixServer> {
  const srv = new MockMatrixServer();
  await srv.listening;
  cleanup.push(srv);
  return srv;
}

function baseUrl(srv: MockMatrixServer): string {
  return `http://127.0.0.1:${srv.port}`;
}

// ── helper ─────────────────────────────────────────────────────────────────

/**
 * Pre-enqueues a 200 login response, logs in, and returns the client.
 * The caller must enqueue additional responses for subsequent API calls.
 */
async function loginAndGetClient(srv: MockMatrixServer): Promise<MatrixClient> {
  srv.enqueue(200, {
    user_id: '@bot:matrix.org',
    access_token: 'tok_test',
    device_id: 'DEVICE_1',
    home_server: 'test.local',
  });
  return MatrixClient.login({
    baseUrl: baseUrl(srv),
    userId: '@bot:matrix.org',
    password: 'secret',
  });
}

// ── login ──────────────────────────────────────────────────────────────────

describe('login', () => {
  it('logs in with password and returns a client', async () => {
    const srv = await newServer();
    srv.enqueue(200, {
      user_id: '@bot:matrix.org',
      access_token: 'tok_abc123',
      device_id: 'DEVICE_1',
      home_server: 'matrix.org',
    });

    const client = await MatrixClient.login({
      baseUrl: baseUrl(srv),
      userId: '@bot:matrix.org',
      password: 'secret',
      deviceId: 'my-device',
      initialDeviceDisplayName: 'Test Bot',
    });

    expect(client.userId).toBe('@bot:matrix.org');

    const req = srv.lastRequest;
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/_matrix/client/v3/login');

    const parsed = JSON.parse(req?.body ?? '{}');
    expect(parsed.type).toBe('m.login.password');
    expect(parsed.identifier.user).toBe('@bot:matrix.org');
    expect(parsed.password).toBe('secret');
    expect(parsed.device_id).toBe('my-device');
    expect(parsed.initial_device_display_name).toBe('Test Bot');
  });

  it('throws MatrixError on bad credentials (403)', async () => {
    const srv = await newServer();
    srv.enqueue(403, { errcode: 'M_FORBIDDEN', error: 'Invalid password' });

    let err: unknown;
    try {
      await MatrixClient.login({
        baseUrl: baseUrl(srv),
        userId: '@bot:matrix.org',
        password: 'wrong',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).status).toBe(403);
  });

  it('throws MatrixError on 401 with soft_logout', async () => {
    const srv = await newServer();
    srv.enqueue(401, {
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Soft logout',
      soft_logout: true,
    });

    let err: unknown;
    try {
      await MatrixClient.login({
        baseUrl: baseUrl(srv),
        userId: '@bot:matrix.org',
        password: 'secret',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).status).toBe(401);
  });
});

// ── sync ───────────────────────────────────────────────────────────────────

describe('sync', () => {
  it('performs initial sync without since token', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, {
      next_batch: 's12345',
      rooms: {
        join: {
          '!room1:matrix.org': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@user:matrix.org',
                  event_id: '$evt1',
                  origin_server_ts: 1700000000000,
                  room_id: '!room1:matrix.org',
                  content: { msgtype: 'm.text', body: 'hello world' },
                },
              ],
            },
          },
        },
      },
    });

    const resp = await client.sync();

    expect(resp.next_batch).toBe('s12345');
    expect(resp.rooms?.join).toBeDefined();

    const req = srv.lastRequest;
    expect(req?.method).toBe('GET');
    expect(req?.path).toContain('/_matrix/client/v3/sync');
    expect(req?.path).toContain('timeout=30000');
    expect(req?.path).not.toContain('since=');
  });

  it('performs incremental sync with since token', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { next_batch: 's99999', rooms: {} });

    const resp = await client.sync('s12345');

    expect(resp.next_batch).toBe('s99999');
    expect(srv.lastRequest?.path).toContain('since=s12345');
  });

  it('coerces numeric next_batch to string', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { next_batch: 42, rooms: {} });

    const resp = await client.sync();
    expect(resp.next_batch).toBe('42');
  });

  it('throws MatrixError on 500', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(500, { errcode: 'M_UNKNOWN', error: 'boom' });

    let err: unknown;
    try {
      await client.sync();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).status).toBe(500);
  });

  it('aborts an in-flight sync when the signal fires', async () => {
    let syncReceived: (() => void) | undefined;
    const syncReceivedP = new Promise<void>((r) => {
      syncReceived = r;
    });

    // Homeserver that answers /login but holds the /sync long-poll open
    // forever (mimics an idle long-poll mid-request).
    const held = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/login')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              user_id: '@bot:matrix.org',
              access_token: 'tok_test',
              device_id: 'DEVICE_1',
              home_server: 'test.local',
            }),
          );
        });
        return;
      }
      // /sync: never respond.
      syncReceived?.();
    });
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', () => resolve()));
    const port = (held.address() as { port: number }).port;

    const client = await MatrixClient.login({
      baseUrl: `http://127.0.0.1:${port}`,
      userId: '@bot:matrix.org',
      password: 'secret',
    });

    const controller = new AbortController();
    const syncPromise = client.sync(undefined, 30_000, controller.signal);

    // Wait until the sync request is actually in flight before aborting.
    await syncReceivedP;
    controller.abort();

    await expect(syncPromise).rejects.toMatchObject({ name: 'AbortError' });

    held.close();
  });
});

// ── send ───────────────────────────────────────────────────────────────────

describe('send', () => {
  it('sends a message event to a room', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { event_id: '$evt999' });

    const eventId = await client.send('!room1:matrix.org', 'm.room.message', {
      msgtype: 'm.text',
      body: 'hi there',
    });

    expect(eventId).toBe('$evt999');

    const req = srv.lastRequest;
    expect(req?.method).toBe('PUT');
    expect(req?.path).toContain('/rooms/!room1%3Amatrix.org/send/m.room.message/0');
    expect(JSON.parse(req?.body ?? '{}').body).toBe('hi there');
  });

  it('increments txnId on each send (idempotency)', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);

    srv.enqueue(200, { event_id: '$evt1' });
    await client.send('!room1:matrix.org', 'm.room.message', { body: 'a' });
    expect(srv.lastRequest?.path).toContain('/0');

    srv.enqueue(200, { event_id: '$evt2' });
    await client.send('!room1:matrix.org', 'm.room.message', { body: 'b' });
    expect(srv.lastRequest?.path).toContain('/1');

    srv.enqueue(200, { event_id: '$evt3' });
    await client.send('!room1:matrix.org', 'm.room.message', { body: 'c' });
    expect(srv.lastRequest?.path).toContain('/2');
  });

  it('sendText is a convenience wrapper', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { event_id: '$evt42' });

    await client.sendText('!room1:matrix.org', 'plain text');

    const body = JSON.parse(srv.lastRequest?.body ?? '{}');
    expect(body.msgtype).toBe('m.text');
    expect(body.body).toBe('plain text');
  });
});

// ── join ───────────────────────────────────────────────────────────────────

describe('join', () => {
  it('joins a room by alias', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { room_id: '!room1:matrix.org' });

    const roomId = await client.join('#general:matrix.org');

    expect(roomId).toBe('!room1:matrix.org');

    const req = srv.lastRequest;
    expect(req?.method).toBe('POST');
    expect(req?.path).toContain('/join/%23general%3Amatrix.org');
  });

  it('joins a room by ID', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { room_id: '!room1:matrix.org' });

    const roomId = await client.join('!room1:matrix.org');

    expect(roomId).toBe('!room1:matrix.org');
    expect(srv.lastRequest?.path).toContain('/join/!room1%3Amatrix.org');
  });

  it('throws MatrixError when room not found', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(404, { errcode: 'M_NOT_FOUND', error: 'Room not found' });

    let err: unknown;
    try {
      await client.join('#nope:matrix.org');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).status).toBe(404);
  });
});

// ── profile ────────────────────────────────────────────────────────────────

describe('getDisplayName', () => {
  it('returns display name when set', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { displayname: 'Alice' });

    const name = await client.getDisplayName('@alice:matrix.org');
    expect(name).toBe('Alice');
  });

  it('returns undefined on 404', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(404, { errcode: 'M_NOT_FOUND', error: 'No profile' });

    // getDisplayName catches 404 and returns undefined.
    const name = await client.getDisplayName('@alice:matrix.org');
    expect(name).toBeUndefined();
  });
});

// ── account data ───────────────────────────────────────────────────────────

describe('getAccountData', () => {
  it('fetches m.direct account data', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, {
      '@alice:matrix.org': ['!dm1:matrix.org'],
      '@bob:matrix.org': ['!dm2:matrix.org'],
    });

    const data = await client.getAccountData('m.direct');
    expect(data).toEqual({
      '@alice:matrix.org': ['!dm1:matrix.org'],
      '@bob:matrix.org': ['!dm2:matrix.org'],
    });

    const req = srv.lastRequest;
    expect(req?.method).toBe('GET');
    expect(req?.path).toContain('/user/%40bot%3Amatrix.org/account_data/m.direct');
  });

  it('returns empty object for missing account data (404)', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(404, { errcode: 'M_NOT_FOUND', error: 'Not found' });

    await expect(client.getAccountData('m.direct')).rejects.toThrow(MatrixError);
  });
});

describe('setAccountData', () => {
  it('sets m.direct account data', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, {});

    await client.setAccountData('m.direct', {
      '@alice:matrix.org': ['!dm1:matrix.org'],
    });

    const req = srv.lastRequest;
    expect(req?.method).toBe('PUT');
    expect(req?.path).toContain('/user/%40bot%3Amatrix.org/account_data/m.direct');
    const body = JSON.parse(req?.body ?? '{}');
    expect(body['@alice:matrix.org']).toEqual(['!dm1:matrix.org']);
  });
});

// ── room management ───────────────────────────────────────────────────────

describe('createRoom', () => {
  it('creates a DM room with invite', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { room_id: '!newdm:matrix.org' });

    const roomId = await client.createRoom({
      is_direct: true,
      invite: ['@alice:matrix.org'],
      preset: 'trusted_private_chat',
    });

    expect(roomId).toBe('!newdm:matrix.org');

    const req = srv.lastRequest;
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/_matrix/client/v3/createRoom');
    const body = JSON.parse(req?.body ?? '{}');
    expect(body.is_direct).toBe(true);
    expect(body.invite).toEqual(['@alice:matrix.org']);
    expect(body.preset).toBe('trusted_private_chat');
  });

  it('creates a named room', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { room_id: '!named:matrix.org' });

    const roomId = await client.createRoom({ name: 'Test Room' });
    expect(roomId).toBe('!named:matrix.org');

    const body = JSON.parse(srv.lastRequest?.body ?? '{}');
    expect(body.name).toBe('Test Room');
  });

  it('throws MatrixError on failure', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(403, { errcode: 'M_FORBIDDEN', error: 'Not allowed' });

    await expect(client.createRoom({})).rejects.toThrow(MatrixError);
  });
});

describe('getJoinedRooms', () => {
  it('returns list of joined room IDs', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { joined_rooms: ['!room1:matrix.org', '!room2:matrix.org'] });

    const rooms = await client.getJoinedRooms();
    expect(rooms).toEqual(['!room1:matrix.org', '!room2:matrix.org']);

    const req = srv.lastRequest;
    expect(req?.method).toBe('GET');
    expect(req?.path).toBe('/_matrix/client/v3/joined_rooms');
  });

  it('returns empty array when no rooms joined', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { joined_rooms: [] });

    const rooms = await client.getJoinedRooms();
    expect(rooms).toEqual([]);
  });
});

describe('getJoinedMembers', () => {
  it('returns member list for a room', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, {
      joined: {
        '@butler:matrix.org': { display_name: 'Butler' },
        '@alice:matrix.org': { display_name: 'Alice' },
      },
    });

    const members = await client.getJoinedMembers('!room1:matrix.org');
    expect(Object.keys(members)).toEqual(['@butler:matrix.org', '@alice:matrix.org']);
    expect(members['@alice:matrix.org'].display_name).toBe('Alice');

    const req = srv.lastRequest;
    expect(req?.method).toBe('GET');
    expect(req?.path).toContain('/rooms/!room1%3Amatrix.org/joined_members');
  });

  it('detects this as a DM (exactly 2 members)', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, {
      joined: {
        '@bot:matrix.org': {},
        '@alice:matrix.org': {},
      },
    });

    const members = await client.getJoinedMembers('!dm:matrix.org');
    expect(Object.keys(members).length).toBe(2);
    // The caller (watcher) uses this to detect DMs.
  });
});

// ── connection errors ──────────────────────────────────────────────────────

describe('connection errors', () => {
  it('throws MatrixError with M_CONNECTION_ERROR on refused connection', async () => {
    let err: unknown;
    try {
      await MatrixClient.login({
        baseUrl: 'http://127.0.0.1:1',
        userId: '@bot:matrix.org',
        password: 'secret',
        requestTimeout: 1000,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).errcode).toBe('M_CONNECTION_ERROR');
  });

  it('throws MatrixError with M_REQUEST_TIMEOUT on timeout', async () => {
    // A server that takes the request and answers nothing: the client's own
    // timeout is the only way out.  Loopback only — this used to aim at
    // 192.0.2.1 and depend on the network rather than on the client.
    const srv = await newServer();
    srv.silent();

    let err: unknown;
    try {
      await MatrixClient.login({
        baseUrl: baseUrl(srv),
        userId: '@bot:matrix.org',
        password: 'secret',
        requestTimeout: 500,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).errcode).toBe('M_REQUEST_TIMEOUT');
  });
});

// ── sendTyping ───────────────────────────────────────────────────────────────

describe('sendTyping', () => {
  it('sends typing=true with correct URL and body', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);

    srv.enqueue(200, {});
    await client.sendTyping('!room1:matrix.org', true);

    const req = srv.lastRequest;
    expect(req?.method).toBe('PUT');
    expect(req?.path).toContain('/typing/');
    expect(req?.path).toContain('!room1%3Amatrix.org');
    const body = JSON.parse(req?.body ?? '{}');
    expect(body.typing).toBe(true);
    expect(body.timeout).toBe(15_000);
  });

  it('sends typing=false to stop typing', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);

    srv.enqueue(200, {});
    await client.sendTyping('!room1:matrix.org', false, 30_000);

    const body = JSON.parse(srv.lastRequest?.body ?? '{}');
    expect(body.typing).toBe(false);
    expect(body.timeout).toBe(30_000);
  });

  it('throws MatrixError on server error', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);

    srv.enqueue(500, { errcode: 'M_UNKNOWN', error: 'boom' });
    await expect(client.sendTyping('!room1:matrix.org', true)).rejects.toThrow(MatrixError);
  });
});

// ── MatrixRTC client surface ─────────────────────────────────────────────────

describe('room state', () => {
  it('reads the room state', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, [{ type: 'm.room.create', state_key: '', content: {} }]);

    const state = await client.getRoomState('!r:hs');

    expect(state).toHaveLength(1);
    expect(srv.lastRequest?.method).toBe('GET');
    expect(srv.lastRequest?.path).toContain('/rooms/!r%3Ahs/state');
  });

  it('writes a state event at the type and key it is given', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, { event_id: '$state' });

    const id = await client.sendStateEvent('!r:hs', 'm.rtc.member', '_@bot:matrix.org_DEV_m.call', {
      application: 'm.call',
    });

    expect(id).toBe('$state');
    expect(srv.lastRequest?.method).toBe('PUT');
    expect(srv.lastRequest?.path).toContain(
      '/rooms/!r%3Ahs/state/m.rtc.member/_%40bot%3Amatrix.org_DEV_m.call',
    );
    expect(JSON.parse(srv.lastRequest?.body ?? '{}')).toEqual({ application: 'm.call' });
  });
});

describe('MatrixRTC token exchange', () => {
  const openIdBody = {
    access_token: 'openid-token',
    token_type: 'Bearer',
    matrix_server_name: 'hs.example',
    expires_in: 3600,
  };

  it('asks the homeserver for an OpenID token for this session', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, openIdBody);

    const token = await client.openIdToken();

    expect(token.matrix_server_name).toBe('hs.example');
    expect(srv.lastRequest?.method).toBe('POST');
    expect(srv.lastRequest?.path).toContain('/user/%40bot%3Amatrix.org/openid/request_token');
  });

  it('exchanges it for a LiveKit JWT and reads the expiry', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    const exp = 1790776225;
    const payload = Buffer.from(JSON.stringify({ exp, sub: '@bot:matrix.org:DEVICE_1' })).toString(
      'base64url',
    );
    const jwt = `header.${payload}.signature`;

    srv.enqueue(200, openIdBody);
    srv.enqueue(200, { url: 'wss://sfu.example', jwt });

    const token = await client.getLivekitToken({
      serviceUrl: baseUrl(srv),
      roomId: '!r:hs',
      slot: 'm.call#ROOM',
      memberId: '@bot:matrix.org:DEVICE_1',
    });

    expect(token.url).toBe('wss://sfu.example');
    expect(token.expiresAtSec).toBe(exp);
    expect(srv.lastRequest?.method).toBe('POST');
    expect(srv.lastRequest?.path).toBe('/get_token');

    const body = JSON.parse(srv.lastRequest?.body ?? '{}') as {
      room_id: string;
      slot_id: string;
      member: { id: string; claimed_user_id: string; claimed_device_id: string };
      openid_token: { matrix_server_name: string };
    };
    expect(body.room_id).toBe('!r:hs');
    expect(body.slot_id).toBe('m.call#ROOM');
    expect(body.member.id).toBe('@bot:matrix.org:DEVICE_1');
    expect(body.member.claimed_user_id).toBe('@bot:matrix.org');
    expect(body.member.claimed_device_id).toBe('DEVICE_1');
    expect(body.openid_token.matrix_server_name).toBe('hs.example');
  });
  it('asks the older dialect as /sfu/get, with the device claimed', async () => {
    const srv = await newServer();
    const client = await loginAndGetClient(srv);
    srv.enqueue(200, openIdBody);
    srv.enqueue(200, { url: 'wss://sfu.example', jwt: 'header.payload.signature' });

    const token = await client.getLivekitToken({
      serviceUrl: baseUrl(srv),
      roomId: '!r:hs',
      slot: 'm.call#ROOM',
      memberId: '@bot:matrix.org:DEVICE_1',
      dialect: 'legacy',
    });

    expect(token.url).toBe('wss://sfu.example');
    expect(srv.lastRequest?.method).toBe('POST');
    expect(srv.lastRequest?.path).toBe('/sfu/get');

    const body = JSON.parse(srv.lastRequest?.body ?? '{}') as {
      room: string;
      device_id: string;
      room_id?: string;
      slot_id?: string;
      openid_token: { matrix_server_name: string };
    };
    expect(body.room).toBe('!r:hs');
    expect(body.device_id).toBe('DEVICE_1');
    expect(body.room_id).toBeUndefined();
    expect(body.slot_id).toBeUndefined();
    expect(body.openid_token.matrix_server_name).toBe('hs.example');
  });
});
