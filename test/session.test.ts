// ── Session persistence ───────────────────────────────────────────────────
//
// The file is what stops a restart from costing a password login, so what it holds, what it does
// with a broken file and how it is written are all worth pinning.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession, saveSession } from '../src/session.ts';

async function tempPath(name = 'session.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'mx-session-')), name);
}

describe('session file', () => {
  it('round-trips the tokens, the device and the sync position', async () => {
    const path = await tempPath();
    await saveSession(path, {
      userId: '@butler:muromec.nl',
      deviceId: 'dopje/delulu',
      accessToken: 'tok-1',
      refreshToken: 'r1',
      syncToken: 's-42',
    });

    expect(await loadSession(path)).toEqual({
      userId: '@butler:muromec.nl',
      deviceId: 'dopje/delulu',
      accessToken: 'tok-1',
      refreshToken: 'r1',
      syncToken: 's-42',
    });
  });

  it('answers null when there is nothing usable, so the caller logs in', async () => {
    expect(await loadSession(await tempPath('missing.json'))).toBeNull();

    const broken = await tempPath('broken.json');
    await writeFile(broken, 'not json at all', 'utf-8');
    expect(await loadSession(broken)).toBeNull();

    // A file that parses but has no token is as good as absent.
    const empty = await tempPath('empty.json');
    await writeFile(empty, JSON.stringify({ userId: '@butler:muromec.nl' }), 'utf-8');
    expect(await loadSession(empty)).toBeNull();

    expect(await loadSession(undefined)).toBeNull();
  });

  it('writes a private file and leaves no temporary behind', async () => {
    const path = await tempPath();
    await saveSession(path, { userId: '@b:x', deviceId: 'DEV', accessToken: 'tok' });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(path, '..'))).toEqual(['session.json']);
    expect(JSON.parse(await readFile(path, 'utf-8')).accessToken).toBe('tok');
  });
});
