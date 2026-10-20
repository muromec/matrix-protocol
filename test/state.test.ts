// ── Client state persistence ───────────────────────────────────────────────
//
// The file is what stops a restart from costing a password login, and it holds two things that do
// not belong to each other: the credentials, and the position of the last sync.  What it holds,
// what it does with a file it cannot use, and how it is written are all worth pinning.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/state.ts';

async function tempPath(name = 'state.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'mx-state-')), name);
}

describe('state file', () => {
  it('round-trips the credentials and the sync position as two parts', async () => {
    const path = await tempPath();
    await saveState(path, {
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'dopje/delulu',
        accessToken: 'tok-1',
        refreshToken: 'r1',
      },
      syncToken: 's-42',
    });

    expect(await loadState(path)).toEqual({
      session: {
        userId: '@butler:muromec.nl',
        deviceId: 'dopje/delulu',
        accessToken: 'tok-1',
        refreshToken: 'r1',
      },
      syncToken: 's-42',
    });
  });

  it('keeps the position when the credentials are gone, and the credentials when it is', async () => {
    const withoutSession = await tempPath();
    await saveState(withoutSession, { syncToken: 's-1' });
    expect(await loadState(withoutSession)).toEqual({ syncToken: 's-1' });

    const withoutPosition = await tempPath();
    await saveState(withoutPosition, {
      session: { userId: '@b:x', deviceId: 'DEV', accessToken: 'tok' },
    });
    expect(await loadState(withoutPosition)).toEqual({
      session: { userId: '@b:x', deviceId: 'DEV', accessToken: 'tok' },
    });
  });

  it('answers an empty record when there is nothing usable, so the caller logs in', async () => {
    expect(await loadState(await tempPath('missing.json'))).toEqual({});

    const broken = await tempPath('broken.json');
    await writeFile(broken, 'not json at all', 'utf-8');
    expect(await loadState(broken)).toEqual({});

    // A file that parses but holds no session is an empty record, not a half one.
    const empty = await tempPath('empty.json');
    await writeFile(empty, JSON.stringify({ userId: '@butler:muromec.nl' }), 'utf-8');
    expect(await loadState(empty)).toEqual({});

    expect(await loadState(undefined)).toEqual({});
  });

  it('keeps a flat file’s position and nothing else', async () => {
    // The shape released before this one wrote the credentials at the top level.  They are not
    // taken — the account logs in again — but the position is, because a position in the account's
    // stream does not depend on the credentials that wrote it.
    const path = await tempPath('legacy.json');
    await writeFile(
      path,
      JSON.stringify({ userId: '@b:x', deviceId: 'DEV', accessToken: 'tok', syncToken: 's-old' }),
      'utf-8',
    );
    expect(await loadState(path)).toEqual({ syncToken: 's-old' });
  });

  it('writes a private file and leaves no temporary behind', async () => {
    const path = await tempPath();
    await saveState(path, { session: { userId: '@b:x', deviceId: 'DEV', accessToken: 'tok' } });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(path, '..'))).toEqual(['state.json']);
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({
      session: { userId: '@b:x', deviceId: 'DEV', accessToken: 'tok' },
    });
  });
});
