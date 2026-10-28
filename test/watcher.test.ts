// ── MatrixWatcher Unit Tests ───────────────────────────────────────────────
//
// Tests for src/watcher.ts.
// Mocks MatrixClient at the module level — no HTTP server needed.
// Covers resolveDm, findOrCreateRoom, and all catch{} paths.
//
// Run:  bun test test/watcher.test.ts
//       npx vitest run test/watcher.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.ts';

let mockClient: MockClient;
/** The mocked statics, kept by name so a case can reset or restate them without a cast. */
let loginMock: ReturnType<typeof vi.fn>;
let refreshMock: ReturnType<typeof vi.fn>;
let fromSessionMock: ReturnType<typeof vi.fn>;

vi.mock('../src/client.ts', () => ({
  MatrixClient: {
    login: (loginMock = vi.fn().mockImplementation(async () => {
      mockClient = freshMockClient();
      return mockClient;
    })),
    refresh: (refreshMock = vi.fn().mockImplementation(async () => ({
      access_token: 'refreshed-token',
      refresh_token: 'rotated-refresh',
    }))),
    fromSession: (fromSessionMock = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      mockClient = freshMockClient({ accessToken: String(opts.accessToken) });
      return mockClient;
    })),
  },
  MatrixError: class MatrixError extends Error {
    errcode: string;
    status: number;
    body: unknown;
    constructor(status: number, errcode: string, error: string, body: unknown) {
      super(error);
      this.status = status;
      this.errcode = errcode;
      this.body = body;
    }
  },
}));

const { MatrixWatcher: MatrixWatcherCtor } = await import('../src/watcher.ts');
import type { MatrixWatcher, WatcherConfig } from '../src/watcher.ts';

interface MockClient {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  deviceId: string;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedMembers: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  setPresence: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
  setAccessToken: ReturnType<typeof vi.fn>;
}

function tick<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(r, 0, value));
}

function freshMockClient(overrides: Partial<MockClient> = {}): MockClient {
  const client: MockClient = {
    userId: '@butler:muromec.nl',
    accessToken: 'tok-1',
    deviceId: 'DEV-1',
    getAccountData: vi.fn().mockResolvedValue({}),
    setAccountData: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockRejectedValue(new Error('createRoom not stubbed')),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    getJoinedMembers: vi.fn().mockRejectedValue(new Error('getJoinedMembers not stubbed')),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    setPresence: vi.fn().mockResolvedValue(undefined),
    setAccessToken: vi.fn(),
    sync: vi.fn().mockImplementation(() => tick({ next_batch: 's1', rooms: {} })),
    ...overrides,
  };
  // The real client carries the token it authenticates with; a stand-in that only recorded a call
  // would let a renewal look applied while the next request still used the old token.
  client.setAccessToken.mockImplementation((token: string) => {
    client.accessToken = token;
  });
  return client;
}

// ── helpers ───────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    baseUrl: 'https://matrix.example.com',
    userId: '@butler:muromec.nl',
    password: 'test-password',
    ...overrides,
  };
}

/** Seed a DM room into the watcher's memory cache layer. */
async function seedDm(watcher: MatrixWatcher, roomId: string, mxid: string): Promise<void> {
  const mem = watcher.dmMemory;
  if (!mem) throw new Error('dmMemory not initialised — did boot complete?');
  await mem.set({ tag: 'roomid', value: roomId }, mxid);
}

async function boot(): Promise<{
  watcher: MatrixWatcher;
  client: MockClient;
}> {
  mockClient = null!;

  const w = new MatrixWatcherCtor(makeConfig({ reconnectDelay: 1 }));
  const startPromise = w.start();

  const start = Date.now();
  // mockClient is assigned by the async MatrixClient.login mock; the loop
  // just waits for that to land.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!mockClient) {
    if (Date.now() - start > 2000) throw new Error('boot: login never completed');
    await new Promise((r) => setTimeout(r, 1));
  }

  await new Promise((r) => setTimeout(r, 5));
  w.stop();
  await startPromise;

  // Reset mock call history — boot calls fetchDirects + warmup which
  // touch getAccountData, getJoinedRooms, getJoinedMembers.
  // Tests should start with a clean slate.
  mockClient.getAccountData.mockClear();
  mockClient.setAccountData.mockClear();
  mockClient.createRoom.mockClear();
  mockClient.getJoinedRooms.mockClear();
  mockClient.getJoinedMembers.mockClear();

  return { watcher: w, client: mockClient };
}

// ── resolveDm ─────────────────────────────────────────────────────────────

describe('resolveDm', () => {
  it('returns isDm=false when no client', async () => {
    const w = new MatrixWatcherCtor(makeConfig());
    const result = await w.resolveDm('!unknown:example.com');
    expect(result.isDm).toBe(false);
    expect(result.members).toEqual([]);
  });

  it('returns isDm=true from cached memory layer', async () => {
    const { watcher } = await boot();
    await seedDm(watcher, '!dm:ex.com', '@alice:ex.com');

    const result = await watcher.resolveDm('!dm:ex.com');
    expect(result.isDm).toBe(true);
    expect(result.members).toEqual(['@butler:muromec.nl', '@alice:ex.com']);
  });

  it('lazy-queries joined_members (2 members → DM)', async () => {
    const { watcher, client } = await boot();
    client.getJoinedMembers.mockResolvedValue({
      '@butler:muromec.nl': {},
      '@bob:ex.com': {},
    });

    const result = await watcher.resolveDm('!dm-bob:ex.com');
    expect(result.isDm).toBe(true);
    expect(result.members).toEqual(['@butler:muromec.nl', '@bob:ex.com']);
    expect(client.getJoinedMembers).toHaveBeenCalledWith('!dm-bob:ex.com');

    // Second call hits cache.
    client.getJoinedMembers.mockClear();
    const r2 = await watcher.resolveDm('!dm-bob:ex.com');
    expect(r2.isDm).toBe(true);
    expect(client.getJoinedMembers).not.toHaveBeenCalled();
  });

  it('lazy-queries joined_members (3+ members → not DM)', async () => {
    const { watcher, client } = await boot();
    client.getJoinedMembers.mockResolvedValue({
      '@butler:muromec.nl': {},
      '@bob:ex.com': {},
      '@carol:ex.com': {},
    });

    const result = await watcher.resolveDm('!group:ex.com');
    expect(result.isDm).toBe(false);
    expect(result.members).toEqual([]);
  });

  it('handles getJoinedMembers error — returns isDm=false', async () => {
    const { watcher, client } = await boot();
    client.getJoinedMembers.mockRejectedValue(new Error('network failure'));

    const result = await watcher.resolveDm('!dead:ex.com');
    expect(result.isDm).toBe(false);
    expect(result.members).toEqual([]);
  });
});

// ── findOrCreateRoom ──────────────────────────────────────────────────────

describe('findOrCreateRoom', () => {
  it('throws when no client (not booted)', async () => {
    const w = new MatrixWatcherCtor(makeConfig());
    await expect(w.findOrCreateRoom('@alice:ex.com')).rejects.toThrow(
      'MatrixWatcher: not connected',
    );
  });

  it('returns cached DM room from memory layer (chain hit)', async () => {
    const { watcher, client } = await boot();
    await seedDm(watcher, '!dm:ex.com', '@alice:ex.com');

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
    // Chain hit at memory layer — no API calls needed.
    expect(client.getAccountData).not.toHaveBeenCalled();
    expect(client.getJoinedRooms).not.toHaveBeenCalled();
  });

  it('returns cached room without any API verification (trusts warmup)', async () => {
    const { watcher, client } = await boot();
    await seedDm(watcher, '!dm:ex.com', '@alice:ex.com');
    // Network is broken but we trust the cache.
    client.getAccountData.mockRejectedValue(new Error('network error'));
    client.getJoinedRooms.mockRejectedValue(new Error('network error'));

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm:ex.com');
  });

  it('falls back to m.direct when not in memory', async () => {
    const { watcher, client } = await boot();
    // Memory is empty — chain proceeds to MDirectSource.
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!dm-found:ex.com'],
    });

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm-found:ex.com');
    expect(client.getAccountData).toHaveBeenCalledWith('m.direct');
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('creates a new DM room when m.direct fetch throws (404 path)', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockRejectedValue(new Error('404 not found'));
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
    expect(client.createRoom).toHaveBeenCalledWith({
      is_direct: true,
      invite: ['@bob:ex.com'],
      preset: 'trusted_private_chat',
    });
  });

  it('returns room even when chain.set fails for some layers', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockRejectedValue(new Error('404'));
    client.createRoom.mockResolvedValue('!new-dm:ex.com');
    // setAccountData will fail — but the room was created.
    client.setAccountData.mockRejectedValue(new Error('setAccountData failed'));

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
  });

  it('returns m.direct entry even if stale (trusting warmup)', async () => {
    const { watcher, client } = await boot();
    // m.direct has an entry, but warmup would have cleaned it if stale.
    // During runtime we trust it — no per-lookup membership verification.
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!may-be-stale:ex.com'],
    });

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!may-be-stale:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
    // No membership check — we trust the chain.
    expect(client.getJoinedRooms).not.toHaveBeenCalled();
  });

  it('handles getAccountData error during chain.set after create', async () => {
    const { watcher, client } = await boot();
    client.getAccountData
      .mockRejectedValueOnce(new Error('404'))
      .mockRejectedValueOnce(new Error('network'));
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
  });

  it('returns first m.direct room when multiple exist (no membership check)', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!dm-old:ex.com', '!dm-current:ex.com'],
    });

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    // MDirectSource returns the first room from the array.
    expect(roomId).toBe('!dm-old:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
    // No membership verification per-lookup — warmup handles staleness.
    expect(client.getJoinedMembers).not.toHaveBeenCalled();
  });

  it('finds room via joined-room scan when cache and m.direct miss', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({});
    client.getJoinedRooms.mockResolvedValue(['!other:ex.com', '!real-dm:ex.com']);
    client.getJoinedMembers
      .mockResolvedValueOnce({ '@other:ex.com': {} })
      .mockResolvedValueOnce({ '@butler:ex.com': {}, '@alice:ex.com': {} });

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!real-dm:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('creates room when scan also finds nothing', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({});
    client.getJoinedRooms.mockResolvedValue(['!other:ex.com']);
    client.getJoinedMembers.mockResolvedValue({ '@other:ex.com': {} });
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
    expect(client.createRoom).toHaveBeenCalled();
  });

  it('writes created room back through the chain (memory + m.direct)', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({});
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    await watcher.findOrCreateRoom('@alice:ex.com');

    // Chain.set writes to all layers, including m.direct.
    expect(client.setAccountData).toHaveBeenCalled();
    // Second lookup hits memory cache.
    client.getAccountData.mockClear();
    client.createRoom.mockClear();
    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
    // No API call needed — memory layer hit.
    expect(client.getAccountData).not.toHaveBeenCalled();
  });
});

// ── sync loop / abort wiring ────────────────────────────────────────────────

describe('sync loop', () => {
  it('passes an AbortSignal to client.sync', async () => {
    const { client } = await boot();
    expect(client.sync).toHaveBeenCalled();
    const signal = client.sync.mock.calls[0]?.[2];
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

// ── call events ────────────────────────────────────────────────────────────

import { membershipEventFor } from '../src/rtc.ts';
import { MatrixError } from '../src/client.ts';
import type { MatrixEvent } from '../src/client.ts';
import type { WatcherEvent } from '../src/watcher.ts';

const OURS = membershipEventFor({
  userId: '@butler:muromec.nl',
  deviceId: 'DEV',
  roomId: '!r:ex.com',
  serviceUrl: 'https://sfu.example',
});
const OURS_EVENT = {
  type: OURS.type,
  state_key: OURS.stateKey,
  sender: '@butler:muromec.nl',
  content: { ...OURS.content } as Record<string, unknown>,
  event_id: '$join-ours',
  room_id: '!r:ex.com',
  origin_server_ts: 1,
} as MatrixEvent;

const OTHER = membershipEventFor({
  userId: '@alice:ex.com',
  deviceId: 'AT',
  roomId: '!r:ex.com',
  serviceUrl: 'https://sfu.example',
});
const OTHER_EVENT = {
  type: OTHER.type,
  state_key: OTHER.stateKey,
  sender: '@alice:ex.com',
  content: { ...OTHER.content } as Record<string, unknown>,
  event_id: '$join-alice',
  room_id: '!r:ex.com',
  origin_server_ts: 2,
} as MatrixEvent;

const LEFT_EVENT = {
  ...OURS_EVENT,
  content: {},
  event_id: '$leave-ours',
  unsigned: { prev_content: { ...OURS.content } as Record<string, unknown> },
} as MatrixEvent;

/** Boot with a scripted sync stream: each call returns the next response, and
 *  once the script is spent the loop gets empty syncs. */
async function bootWithSync(
  responses: unknown[],
  setup?: (watcher: MatrixWatcher) => Promise<void>,
  config: Partial<WatcherConfig> = {},
  capture: Array<WatcherEvent['type']> = ['call', 'ring'],
): Promise<{ watcher: MatrixWatcher; events: WatcherEvent[]; stop: () => Promise<void> }> {
  mockClient = null!;

  const w = new MatrixWatcherCtor(makeConfig({ reconnectDelay: 1, ...config }));
  const events: WatcherEvent[] = [];
  for (const kind of capture) w.on(kind, (e) => events.push(e));

  const startPromise = w.start();
  // Not the watcher's ready promise: the loop replaces it before resolving, so
  // a read this early would hold the one it threw away.  The DM cache is what
  // the tests below need, and it is built during the same boot.
  const booted = Date.now();
  while (!w.dmMemory) {
    if (Date.now() - booted > 2000) throw new Error('bootWithSync: the DM cache was never built');
    await new Promise((r) => setTimeout(r, 1));
  }

  if (setup) await setup(w);

  let i = 0;
  mockClient.sync.mockImplementation(() => tick(responses[i++] ?? { next_batch: 'sN', rooms: {} }));

  await new Promise((r) => setTimeout(r, 30));

  return {
    watcher: w,
    events,
    stop: async () => {
      w.stop();
      await startPromise;
    },
  };
}

function joinSync(stateEvents: MatrixEvent[], timelineEvents: MatrixEvent[] = []): unknown {
  return {
    next_batch: 's1',
    rooms: {
      join: {
        '!r:ex.com': { state: { events: stateEvents }, timeline: { events: timelineEvents } },
      },
    },
  };
}

describe('call events', () => {
  it('reports a call that is already up, in the state block', async () => {
    const { events, stop } = await bootWithSync([joinSync([OURS_EVENT])]);

    const call = events.find((e) => e.type === 'call')?.call;
    expect(call?.slot).toBe('m.call#ROOM');
    expect(call?.change).toBe('joined');
    expect(call?.mine).toBe(true);
    expect(call?.member.memberId).toBe('@butler:muromec.nl:DEV');
    expect(call?.call.members).toHaveLength(1);

    await stop();
  });

  it('counts the members that are in the call', async () => {
    const { events, stop } = await bootWithSync([joinSync([OURS_EVENT, OTHER_EVENT])]);

    const calls = events.filter((e) => e.type === 'call');
    expect(calls).toHaveLength(2);
    expect(calls[0].call?.mine).toBe(true);
    expect(calls[1].call?.mine).toBe(false);
    expect(calls[1].call?.call.members).toHaveLength(2);

    await stop();
  });

  it('reports a leave, with the call it left', async () => {
    const { events, stop } = await bootWithSync([
      joinSync([OURS_EVENT]),
      joinSync([], [LEFT_EVENT]),
    ]);

    const calls = events.filter((e) => e.type === 'call');
    expect(calls.map((e) => e.call?.change)).toEqual(['joined', 'left']);
    expect(calls[1].call?.call.members).toHaveLength(0);

    await stop();
  });

  it('emits each changed membership once', async () => {
    const { events, stop } = await bootWithSync([
      joinSync([OURS_EVENT, OTHER_EVENT]),
      joinSync([OURS_EVENT, OTHER_EVENT]),
    ]);

    expect(events.filter((e) => e.type === 'call')).toHaveLength(2);

    await stop();
  });

  it('turns a ring into a room: the DM with the user who rang', async () => {
    const ringSync = {
      next_batch: 's1',
      to_device: {
        events: [
          {
            type: 'm.call.notify',
            sender: '@alice:ex.com',
            content: { notification_type: 'ring', slot_id: 'm.call#ROOM', lifetime: 30_000 },
          },
        ],
      },
    };

    const { events, stop } = await bootWithSync([ringSync], async (watcher) => {
      await seedDm(watcher, '!dm-alice:ex.com', '@alice:ex.com');
    });

    const ring = events.find((e) => e.type === 'ring');
    expect(ring?.roomId).toBe('!dm-alice:ex.com');
    expect(ring?.ring?.sender).toBe('@alice:ex.com');
    expect(ring?.ring?.slot).toBe('m.call#ROOM');
    expect(ring?.ring?.lifetimeMs).toBe(30_000);

    await stop();
  });

  it('ignores a call that is announced without ringing', async () => {
    const notifySync = {
      next_batch: 's1',
      to_device: {
        events: [
          {
            type: 'm.call.notify',
            sender: '@alice:ex.com',
            content: { notification_type: 'notify', slot_id: 'm.call#ROOM' },
          },
        ],
      },
    };

    const { events, stop } = await bootWithSync([notifySync]);

    expect(events.filter((e) => e.type === 'ring')).toHaveLength(0);

    await stop();
  });
});

// ── media messages ─────────────────────────────────────────────────────────

describe('media messages', () => {
  const IMAGE = {
    type: 'm.room.message',
    sender: '@alice:ex.com',
    event_id: '$img1',
    origin_server_ts: 1_700_000_000_000,
    room_id: '!r:ex.com',
    content: {
      msgtype: 'm.image',
      body: 'shot.png',
      url: 'mxc://muromec.nl/abc123',
      info: { mimetype: 'image/png', size: 12 },
    },
  };

  /** Collect what the watcher hands on, out of a scripted sync stream. */
  async function messagesFrom(
    responses: unknown[],
  ): Promise<{ seen: WatcherEvent[]; stop: () => Promise<void> }> {
    const seen: WatcherEvent[] = [];
    const { stop } = await bootWithSync(responses, async (w) => {
      w.on('message', (e) => seen.push(e));
    });
    return { seen, stop };
  }

  it('hands a file on instead of dropping it', async () => {
    const { seen, stop } = await messagesFrom([joinSync([], [IMAGE])]);

    expect(seen).toHaveLength(1);
    expect(seen[0].message?.media?.url).toBe('mxc://muromec.nl/abc123');
    expect(seen[0].message?.media?.name).toBe('shot.png');
    expect(seen[0].message?.text).toBe('shot.png');
    expect(seen[0].roomId).toBe('!r:ex.com');

    await stop();
  });

  it('still says nothing when a message has neither text nor a file', async () => {
    const empty = {
      type: 'm.room.message',
      sender: '@alice:ex.com',
      event_id: '$empty1',
      origin_server_ts: 1,
      room_id: '!r:ex.com',
      content: { msgtype: 'm.text', body: '   ' },
    };
    const { seen, stop } = await messagesFrom([joinSync([], [empty])]);

    expect(seen).toHaveLength(0);

    await stop();
  });
});

// ── session ───────────────────────────────────────────────────────────────

describe('session', () => {
  // Every case states the mocks it needs from a known baseline: a case that replaces one leaves it
  // for the next otherwise, and a leaked refusal reads as a defect in the case after it.
  beforeEach(() => {
    loginMock.mockReset();
    loginMock.mockImplementation(async () => {
      mockClient = freshMockClient();
      return mockClient;
    });
    refreshMock.mockReset();
    refreshMock.mockImplementation(async () => ({
      access_token: 'refreshed-token',
      refresh_token: 'rotated-refresh',
    }));
    fromSessionMock.mockReset();
    fromSessionMock.mockImplementation((opts: Record<string, unknown>) => {
      mockClient = freshMockClient({ accessToken: String(opts.accessToken) });
      return mockClient;
    });
  });
  /** Boot on a state file and answer once the watcher is up. */
  async function bootOn(statePath: string): Promise<{
    watcher: MatrixWatcher;
    connected: Promise<void>;
    stop: () => Promise<void>;
  }> {
    mockClient = null!;
    const w = new MatrixWatcherCtor(makeConfig({ statePath, reconnectDelay: 1 }));
    let resolveFirst!: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    w.addEventListener('connected', () => resolveFirst());
    const running = w.start();
    return {
      watcher: w,
      connected,
      stop: async () => {
        w.stop();
        await running;
      },
    };
  }

  it('runs on a stored session instead of logging in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mw-session-'));
    const statePath = join(dir, 'session.json');
    await saveState(statePath, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'DEV-9',
        accessToken: 'tok-9',
      },
      syncToken: 's9',
    });

    loginMock.mock.calls.length = 0;
    fromSessionMock.mock.calls.length = 0;

    const booted = await bootOn(statePath);
    await booted.connected;
    await tick(undefined);
    await booted.stop();

    expect(loginMock.mock.calls.length).toBe(0);
    expect(fromSessionMock.mock.calls.length).toBe(1);
    expect(fromSessionMock.mock.calls[0]?.[0]).toMatchObject({
      accessToken: 'tok-9',
      deviceId: 'DEV-9',
    });
    expect(mockClient.sync).toHaveBeenCalledWith('s9', undefined, expect.anything());
  });

  it('refreshes a refused token and stores the rotated pair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mw-refresh-'));
    const statePath = join(dir, 'session.json');
    await saveState(statePath, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'DEV-9',
        accessToken: 'spent-token',
        refreshToken: 'r1',
      },
      syncToken: 's1',
    });

    loginMock.mock.calls.length = 0;
    refreshMock.mock.calls.length = 0;

    // The stored token is refused and the refreshed one works: the refusal has to be the client's,
    // not the first sync's, or the test is a race against which call runs first.
    fromSessionMock.mockImplementation((opts: Record<string, unknown>) => {
      const token = String(opts.accessToken);
      mockClient = freshMockClient({ accessToken: token });
      if (token === 'spent-token') {
        mockClient.sync = vi
          .fn()
          .mockRejectedValue(new MatrixError(401, 'M_UNKNOWN_TOKEN', 'refused', null));
      }
      return mockClient;
    });

    mockClient = null!;
    const w = new MatrixWatcherCtor(makeConfig({ statePath, reconnectDelay: 1 }));
    const errors: Array<Error> = [];
    w.addEventListener('error', (e) =>
      errors.push((e as CustomEvent<{ error: Error }>).detail.error),
    );
    let opens = 0;
    let resolveSecond!: () => void;
    const reconnected = new Promise<void>((r) => {
      resolveSecond = r;
    });
    w.addEventListener('connected', () => {
      opens += 1;
      if (opens === 2) resolveSecond();
    });
    const running = w.start();
    await reconnected;
    w.stop();
    await running;

    expect(refreshMock.mock.calls.length).toBe(1);
    expect(refreshMock.mock.calls[0]?.[1]).toBe('r1');
    expect(loginMock.mock.calls.length).toBe(0);

    // A renewal is not a failure.  A caller that treats an error as fatal would kill the transport
    // for a token the watcher had already replaced.
    expect(errors).toHaveLength(0);

    const stored = await loadState(statePath);
    expect(stored.session?.accessToken).toBe('refreshed-token');
    expect(stored.session?.refreshToken).toBe('rotated-refresh');
    expect(stored.syncToken).toBe('s1');
  });

  it('logs in again when the refresh is spent, and resumes where the stream ended', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mw-relogin-'));
    const statePath = join(dir, 'session.json');
    await saveState(statePath, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'DEV-9',
        accessToken: 'spent-token',
        refreshToken: 'spent-refresh',
      },
      syncToken: 's7',
    });

    loginMock.mock.calls.length = 0;
    refreshMock.mock.calls.length = 0;
    refreshMock.mockRejectedValue(new MatrixError(401, 'M_UNKNOWN_TOKEN', 'refresh refused', null));

    // The stored token is refused and the refresh is spent, so the password is the only door left.
    fromSessionMock.mockImplementation((opts: Record<string, unknown>) => {
      mockClient = freshMockClient({ accessToken: String(opts.accessToken) });
      mockClient.sync = vi
        .fn()
        .mockRejectedValue(new MatrixError(401, 'M_UNKNOWN_TOKEN', 'refused', null));
      return mockClient;
    });

    // The login is the trigger: whatever the fresh client then syncs with is the answer.
    let resumedWith: string | undefined;
    const resumed = new Promise<void>((resolve) => {
      loginMock.mockImplementationOnce(async () => {
        mockClient = freshMockClient();
        mockClient.sync = vi.fn().mockImplementation(async (since?: string) => {
          resumedWith = since;
          resolve();
          return await tick({ next_batch: 's8', rooms: {} });
        });
        return mockClient;
      });
    });

    mockClient = null!;
    const w = new MatrixWatcherCtor(makeConfig({ statePath, reconnectDelay: 1 }));
    const running = w.start();
    await resumed;
    w.stop();
    await running;

    expect(refreshMock.mock.calls.length).toBe(1);
    expect(loginMock.mock.calls.length).toBe(1);
    // The position belongs to the account's stream, not to the credentials that just died.
    expect(resumedWith).toBe('s7');
    expect(typeof (await loadState(statePath)).syncToken).toBe('string');
  });

  it('renews a token that is about to expire before the next request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mw-proactive-'));
    const statePath = join(dir, 'session.json');
    await saveState(statePath, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'DEV-9',
        accessToken: 'old-token',
        refreshToken: 'r1',
        expiresAtMs: Date.now() + 5_000,
      },
      syncToken: 's3',
    });

    refreshMock.mock.calls.length = 0;
    const errors: Array<Error> = [];

    // What the client walks in with, and where it resumes, as the first sync sees them.
    let tokenAtFirstSync: string | undefined;
    let sinceAtFirstSync: string | undefined;
    const synced = new Promise<void>((resolve) => {
      fromSessionMock.mockImplementation((opts: Record<string, unknown>) => {
        mockClient = freshMockClient({ accessToken: String(opts.accessToken) });
        mockClient.sync = vi.fn().mockImplementation(async (since?: string) => {
          tokenAtFirstSync = mockClient.accessToken;
          sinceAtFirstSync = since;
          resolve();
          return await tick({ next_batch: 's4', rooms: {} });
        });
        return mockClient;
      });
    });

    mockClient = null!;
    const w = new MatrixWatcherCtor(makeConfig({ statePath, reconnectDelay: 1 }));
    w.addEventListener('error', (e) =>
      errors.push((e as CustomEvent<{ error: Error }>).detail.error),
    );
    const running = w.start();
    await synced;
    w.stop();
    await running;

    // No request was refused: the renewal happened on the way in, because there was less than a
    // margin of life left.
    expect(refreshMock.mock.calls.length).toBe(1);
    expect(refreshMock.mock.calls[0]?.[1]).toBe('r1');
    expect(tokenAtFirstSync).toBe('refreshed-token');
    expect(sinceAtFirstSync).toBe('s3');
    expect(errors).toHaveLength(0);
  });

  it('leaves a token with life in it alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mw-fresh-'));
    const statePath = join(dir, 'session.json');
    await saveState(statePath, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'DEV-9',
        accessToken: 'good-token',
        refreshToken: 'r1',
        expiresAtMs: Date.now() + 3_600_000,
      },
      syncToken: 's5',
    });

    refreshMock.mock.calls.length = 0;

    let tokenAtFirstSync: string | undefined;
    const synced = new Promise<void>((resolve) => {
      fromSessionMock.mockImplementation((opts: Record<string, unknown>) => {
        mockClient = freshMockClient({ accessToken: String(opts.accessToken) });
        mockClient.sync = vi.fn().mockImplementation(async () => {
          tokenAtFirstSync = mockClient.accessToken;
          resolve();
          return await tick({ next_batch: 's6', rooms: {} });
        });
        return mockClient;
      });
    });

    mockClient = null!;
    const w = new MatrixWatcherCtor(makeConfig({ statePath, reconnectDelay: 1 }));
    const running = w.start();
    await synced;
    w.stop();
    await running;

    expect(refreshMock.mock.calls.length).toBe(0);
    expect(tokenAtFirstSync).toBe('good-token');
  });
});

// ── what the watcher hands over ────────────────────────────────────────────
//
// The caller names the room event types it wants; everything else is dropped as it always was.
// Two read-outs depend on this: a widget's own events, and a poll's answers.

function textEvent(id: string, sender: string, body = 'hello'): MatrixEvent {
  return {
    type: 'm.room.message',
    sender,
    content: { msgtype: 'm.text', body },
    event_id: id,
    room_id: '!r:ex.com',
    origin_server_ts: 3,
  } as MatrixEvent;
}

const POLL_START = {
  type: 'm.poll.start',
  sender: '@alice:ex.com',
  content: {
    'm.text': 'Lunch?\n1. Pizza\n2. Soup',
    'm.poll.start': { question: { 'm.text': 'Lunch?' }, answers: [] },
  },
  event_id: '$poll',
  room_id: '!r:ex.com',
  origin_server_ts: 4,
} as MatrixEvent;

const POLL_VOTE = {
  type: 'm.poll.response',
  sender: '@alice:ex.com',
  content: {
    'm.poll.response': { answers: ['a1'] },
    'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
  },
  event_id: '$vote',
  room_id: '!r:ex.com',
  origin_server_ts: 5,
} as MatrixEvent;

describe('the events a watcher hands over', () => {
  it('is m.room.message alone unless the caller names more', async () => {
    const { events, stop } = await bootWithSync(
      [joinSync([], [textEvent('$text', '@alice:ex.com'), POLL_START, POLL_VOTE])],
      undefined,
      {},
      ['message'],
    );

    expect(events.map((e) => e.message?.event?.type)).toEqual(['m.room.message']);
    await stop();
  });

  it('delivers a type the caller named, with the whole event on it', async () => {
    const { events, stop } = await bootWithSync(
      [joinSync([], [textEvent('$text', '@alice:ex.com'), POLL_VOTE])],
      undefined,
      { eventTypes: ['m.room.message', 'm.poll.response'] },
      ['message'],
    );

    const votes = events.filter((e) => e.message?.event?.type === 'm.poll.response');
    expect(votes).toHaveLength(1);
    // A poll answer has no body at all: the content travels on the event, and the empty text is
    // not a reason to drop it.
    expect(votes[0].message?.event?.content).toMatchObject({
      'm.poll.response': { answers: ['a1'] },
    });
    await stop();
  });

  it('skips this account\u2019s own events unless it is asked not to', async () => {
    const ours = textEvent('$mine', '@butler:muromec.nl', 'my own words');
    const quiet = await bootWithSync([joinSync([], [ours])], undefined, {}, ['message']);
    expect(quiet.events).toHaveLength(0);
    await quiet.stop();

    const loud = await bootWithSync([joinSync([], [ours])], undefined, { ignoreOwn: false }, [
      'message',
    ]);
    expect(loud.events).toHaveLength(1);
    expect(loud.events[0].message?.text).toBe('my own words');
    await loud.stop();
  });
});

describe('an event already seen', () => {
  it('is dropped with a warning, so the set can be judged rather than assumed', async () => {
    const lines: string[] = [];
    const event = textEvent('$repeat', '@alice:ex.com', 'said once');

    const { events, stop } = await bootWithSync(
      [joinSync([], [event]), joinSync([], [event])],
      undefined,
      { debugSink: (line) => lines.push(line) },
      ['message'],
    );

    expect(events).toHaveLength(1);
    expect(lines.some((line) => line.includes('$repeat') && line.includes('already seen'))).toBe(
      true,
    );

    await stop();
  });
});
