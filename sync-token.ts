// ── Sync token persistence ─────────────────────────────────────────────────
//
// Stores the Matrix /sync `next_batch` token to a filesystem path so the
// watcher can resume from where it left off across restarts, avoiding
// replay of already-processed events.
//
// Both functions are no-ops when `path` is undefined (caller opted out).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read a saved `next_batch` token from disk.
 *
 * Returns `undefined` if the file doesn't exist, the path is undefined,
 * or the file is empty.  Throws on other I/O errors.
 */
export async function loadSyncToken(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const raw = await readFile(path, "utf-8");
    return raw.trim() || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Write a `next_batch` token to disk.
 *
 * Creates parent directories as needed.  No-op when `path` is undefined.
 * Silently swallows mkdir EEXIST (directory already exists).
 */
export async function saveSyncToken(path: string | undefined, token: string): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch {
    // Directory already exists (or can't be created) — proceed anyway.
  }
  await writeFile(path, token, "utf-8");
}
