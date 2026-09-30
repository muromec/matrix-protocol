// ── MatrixWatcher Unit Tests ───────────────────────────────────────────────
//
// Tests for src/watcher.ts.
// Mocks MatrixClient at the module level — no HTTP server needed.
// Covers resolveDm, findOrCreateRoom, and all catch{} paths.
//
// Run:  bun test test/watcher.test.ts
//       npx vitest run test/watcher.test.ts

import { describe, it, expect, vi } from 'vitest';

// ── mock the client module ────────────────────────────────────────────────

let mockClient: MockClient;

vi.mock('../src/client.ts', () => ({
  MatrixClient: {
    login: vi.fn().mockImplementation(async () => {
      mockClient = freshMockClient();
      return mockClient;
    }),
  },
  MatrixError: class MatrixError extends Error {
    errcode: string;
    status: number;
    constructor(msg: string, errcode: string, status: number) {
      super(msg);
      this.errcode = errcode;
      this.status = status;
    }
  },
}));

const { MatrixWatcher: MatrixWatcherCtor } = await import('../src/watcher.ts');
import type { MatrixWatcher, WatcherConfig } from '../src/watcher.ts';

interface MockClient {
  userId: string;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedMembers: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  setPresence: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
}

function tick<T>(value: T): Promise<T> {
  return new Promise((r) => setTimeout(r, 0, value));
}

function freshMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    userId: '@butler:muromec.nl',
    getAccountData: vi.fn().mockResolvedValue({}),
    setAccountData: vi.fn().mockResolvedValue(undefined),
    createRoom: vi.fn().mockRejectedValue(new Error('createRoom not stubbed')),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    getJoinedMembers: vi.fn().mockRejectedValue(new Error('getJoinedMembers not stubbed')),
    join: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
    setPresence: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockImplementation(() => tick({ next_batch: 's1', rooms: {} })),
    ...overrides,
  };
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

import { membershipEventFor, leaveEventFor } from '../src/rtc.ts';
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
): Promise<{ watcher: MatrixWatcher; events: WatcherEvent[]; stop: () => Promise<void> }> {
  mockClient = null!;

  const w = new MatrixWatcherCtor(makeConfig({ reconnectDelay: 1 }));
  const events: WatcherEvent[] = [];
  w.on('call', (e) => events.push(e));
  w.on('ring', (e) => events.push(e));

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
