// ── MatrixWatcher Unit Tests ───────────────────────────────────────────────
//
// Tests for vendored/matrix-connector/watcher.ts.
// Mocks MatrixClient at the module level — no HTTP server needed.
// Covers resolveDm, findOrCreateRoom, and all catch{} paths.
//
// Run:  npx vitest run vendored/matrix-connector/watcher.test.ts
//       bun test vendored/matrix-connector/watcher.test.ts

import { describe, it, expect, vi } from 'vitest';

// ── mock the client module ────────────────────────────────────────────────

let mockClient: MockClient;

vi.mock('./client.ts', () => ({
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

const { MatrixWatcher } = await import('./watcher.ts');
import type { WatcherConfig } from './watcher.ts';

interface MockClient {
  userId: string;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedMembers: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
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

/** Seed a DM room entry.  directs is a ReadonlyMap getter, but the map
 *  itself is mutable. */
function seedDm(watcher: MatrixWatcher, roomId: string, mxid: string): void {
  (watcher.directs as Map<string, string>).set(roomId, mxid);
}

async function boot(): Promise<{
  watcher: MatrixWatcher;
  client: MockClient;
}> {
  mockClient = null!;

  const w = new MatrixWatcher(makeConfig({ reconnectDelay: 1 }));
  const startPromise = w.start();

  const start = Date.now();
  while (!mockClient) {
    if (Date.now() - start > 2000) throw new Error('boot: login never completed');
    await new Promise((r) => setTimeout(r, 1));
  }

  await new Promise((r) => setTimeout(r, 5));
  w.stop();
  await startPromise;

  return { watcher: w, client: mockClient };
}

// ── resolveDm ─────────────────────────────────────────────────────────────

describe('resolveDm', () => {
  it('returns isDm=false when no client', async () => {
    const w = new MatrixWatcher(makeConfig());
    const result = await w.resolveDm('!unknown:example.com');
    expect(result.isDm).toBe(false);
    expect(result.members).toEqual([]);
  });

  it('returns isDm=true from cached #directs map', async () => {
    const { watcher } = await boot();
    seedDm(watcher, '!dm:ex.com', '@alice:ex.com');

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
    const w = new MatrixWatcher(makeConfig());
    await expect(w.findOrCreateRoom('@alice:ex.com')).rejects.toThrow(
      'MatrixWatcher: not connected',
    );
  });

  it('returns cached DM room from #directs (verified joined)', async () => {
    const { watcher, client } = await boot();
    seedDm(watcher, '!dm:ex.com', '@alice:ex.com');
    client.getJoinedRooms.mockResolvedValue(['!dm:ex.com']);

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('returns cached room when getJoinedRooms fails (trusts map)', async () => {
    const { watcher, client } = await boot();
    seedDm(watcher, '!dm:ex.com', '@alice:ex.com');
    client.getJoinedRooms.mockRejectedValue(new Error('network error'));

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm:ex.com');
  });

  it('falls back to m.direct fetch when not in cache', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!dm-found:ex.com'],
    });
    client.getJoinedRooms.mockResolvedValue(['!dm-found:ex.com']);

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

  it('returns room even when m.direct update after create fails', async () => {
    const { watcher, client } = await boot();
    client.getAccountData
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ '@other:ex.com': ['!x:ex'] });
    client.createRoom.mockResolvedValue('!new-dm:ex.com');
    client.setAccountData.mockRejectedValue(new Error('setAccountData failed'));

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
  });

  it('creates room when m.direct has entry but not joined anymore', async () => {
    const { watcher, client } = await boot();
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!stale:ex.com'],
    });
    client.getJoinedRooms.mockResolvedValue([]);
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
    expect(client.createRoom).toHaveBeenCalled();
  });

  it('handles inner getAccountData error during create path', async () => {
    const { watcher, client } = await boot();
    client.getAccountData
      .mockRejectedValueOnce(new Error('404'))
      .mockRejectedValueOnce(new Error('network'));
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
  });

  it('falls back to m.direct when cached room is stale (left room)', async () => {
    const { watcher, client } = await boot();
    seedDm(watcher, '!stale-cached:ex.com', '@alice:ex.com');
    // First getJoinedRooms call (cached path): not joined.
    // Second call (m.direct path): joined to the real room.
    client.getJoinedRooms
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['!dm-real:ex.com']);
    client.getAccountData.mockResolvedValue({
      '@alice:ex.com': ['!dm-real:ex.com'],
    });

    const roomId = await watcher.findOrCreateRoom('@alice:ex.com');
    expect(roomId).toBe('!dm-real:ex.com');
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it('creates room when both cached and m.direct rooms are stale', async () => {
    const { watcher, client } = await boot();
    seedDm(watcher, '!stale:ex.com', '@bob:ex.com');
    client.getJoinedRooms.mockResolvedValue([]);
    client.getAccountData.mockResolvedValue({
      '@bob:ex.com': ['!also-stale:ex.com'],
    });
    client.createRoom.mockResolvedValue('!new-dm:ex.com');

    const roomId = await watcher.findOrCreateRoom('@bob:ex.com');
    expect(roomId).toBe('!new-dm:ex.com');
    expect(client.createRoom).toHaveBeenCalled();
  });
});
