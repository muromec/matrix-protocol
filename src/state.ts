// ── Client state persistence ───────────────────────────────────────────────
//
// One file per account holds what a client cannot recover by asking the homeserver again, in two
// parts that do not depend on each other: the credentials a login or a refresh handed out, and
// where the last sync ended.
//
// Keeping the two parts apart is the whole point.  A position in the account's stream does not
// belong to a device or to a token, so replacing the credentials — a re-login after a refused
// refresh, say — must leave it where it was.  Written as one record, that is a property of the
// type: no code path builds a session out of a login response and persists it whole.
//
// Both functions are no-ops when `path` is undefined (caller opted out of persistence).
//
// On disk the record is nested — `{ session: { userId, deviceId, accessToken, refreshToken? },
// syncToken? }` — so the two parts are two parts there as well, and a reader cannot mistake one
// for the other.  A file written before this shape is not migrated: it holds no `session`, so it
// reads as an empty record and the account logs in again.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What a login or a refresh hands out: who the device is, and the tokens that speak for it. */
export interface SessionCredentials {
  /** The account this session belongs to. */
  userId: string;
  /** The device the tokens were issued to. */
  deviceId: string;
  accessToken: string;
  /** Present when the login asked for one.  A refresh replaces both tokens. */
  refreshToken?: string;
  /**
   * When the access token stops being accepted, as an absolute time in ms — the server's
   * `expires_in_ms` added to the moment it answered.  Absent means the server said nothing, and
   * then only a refused request can tell us the token is spent.
   */
  expiresAtMs?: number;
}

/** Everything a watcher carries between starts. */
export interface ClientState {
  /** The credentials the next request speaks with.  Absent means "log in with the password". */
  session?: SessionCredentials;
  /** The `next_batch` the last sync ended on, so a start resumes instead of replaying events. */
  syncToken?: string;
}

/**
 * Read the saved record.
 *
 * An absent or unreadable file is an empty record, not an error: every caller treats "nothing
 * stored" as "log in", and a torn file is the same answer.
 */
export async function loadState(path: string | undefined): Promise<ClientState> {
  if (!path) return {};
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }

  const state: ClientState = {};
  const stored = parsed.session;
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    const s = stored as Record<string, unknown>;
    if (typeof s.accessToken === 'string' && typeof s.deviceId === 'string') {
      state.session = {
        userId: typeof s.userId === 'string' ? s.userId : '',
        deviceId: s.deviceId,
        accessToken: s.accessToken,
        ...(typeof s.refreshToken === 'string' ? { refreshToken: s.refreshToken } : {}),
        ...(typeof s.expiresAtMs === 'number' ? { expiresAtMs: s.expiresAtMs } : {}),
      };
    }
  }
  if (typeof parsed.syncToken === 'string') state.syncToken = parsed.syncToken;
  return state;
}

/**
 * Write the record whole: a temporary file, then a rename over the old one.
 *
 * A torn write would cost a password login, and the file holds an access token, so it is created
 * 0600 and replaced rather than rewritten in place.
 */
export async function saveState(path: string | undefined, state: ClientState): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const record: Record<string, unknown> = {};
  if (state.session) record.session = state.session;
  if (state.syncToken !== undefined) record.syncToken = state.syncToken;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, path);
}
