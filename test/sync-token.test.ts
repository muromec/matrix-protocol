import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSyncToken, saveSyncToken } from '../src/sync-token.ts';

const cleanup: string[] = [];

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'matrix-sync-token-'));
  cleanup.push(d);
  return d;
}

afterAll(async () => {
  await Promise.all(cleanup.map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadSyncToken', () => {
  it('returns undefined for no path', async () => {
    expect(await loadSyncToken(undefined)).toBeUndefined();
  });

  it('returns undefined for a missing file', async () => {
    const d = await tempDir();
    expect(await loadSyncToken(join(d, 'nope'))).toBeUndefined();
  });

  it('reads and trims a saved token', async () => {
    const d = await tempDir();
    const p = join(d, 'token');
    await writeFile(p, '  s12345\n', 'utf-8');
    expect(await loadSyncToken(p)).toBe('s12345');
  });

  it('returns undefined for whitespace-only content', async () => {
    const d = await tempDir();
    const p = join(d, 'token');
    await writeFile(p, '   \n', 'utf-8');
    expect(await loadSyncToken(p)).toBeUndefined();
  });
});

describe('saveSyncToken', () => {
  it('is a no-op for no path', async () => {
    await expect(saveSyncToken(undefined, 'x')).resolves.toBeUndefined();
  });

  it('writes a token readable by loadSyncToken', async () => {
    const d = await tempDir();
    const p = join(d, 'token');
    await saveSyncToken(p, 's999');
    expect(await loadSyncToken(p)).toBe('s999');
  });

  it('creates parent directories as needed', async () => {
    const d = await tempDir();
    const p = join(d, 'a', 'b', 'token');
    await saveSyncToken(p, 'nested');
    expect(await loadSyncToken(p)).toBe('nested');
  });
});
