// ── Session persistence ────────────────────────────────────────────────────
//
// One file per account holds what a client cannot recover by asking again: the access token it was
// given, the refresh token that replaces it, and where the last sync ended.  A login that is not
// needed costs a password round trip and counts against the homeserver's login rate limit.
//
// Both functions are no-ops when `path` is undefined (caller opted out of persistence).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MatrixSession {
  /** The account this session belongs to. */
  userId: string;
  /** The device the tokens were issued to. */
  deviceId: string;
  accessToken: string;
  /** Present when the login asked for one.  A refresh replaces both tokens. */
  refreshToken?: string;
  /** The `next_batch` the last sync ended on, so a restart does not replay events. */
  syncToken?: string;
}

/**
 * Read the saved session.
 *
 * `null` when the path is unset, the file is absent, or it does not parse as a session: each of
 * those means the same thing to the caller, which is "log in".
 */
export async function loadSession(path: string | undefined): Promise<MatrixSession | null> {
  if (!path) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: Partial<MatrixSession>;
  try {
    parsed = JSON.parse(raw) as Partial<MatrixSession>;
  } catch {
    return null;
  }
  if (typeof parsed.accessToken !== 'string' || typeof parsed.deviceId !== 'string') return null;

  return {
    userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    deviceId: parsed.deviceId,
    accessToken: parsed.accessToken,
    ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}),
    ...(typeof parsed.syncToken === 'string' ? { syncToken: parsed.syncToken } : {}),
  };
}

/**
 * Write the session whole: a temporary file, then a rename over the old one.
 *
 * A torn write would cost a password login, and the file holds an access token, so it is created
 * 0600 and replaced rather than rewritten in place.
 */
export async function saveSession(path: string | undefined, session: MatrixSession): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, path);
}
