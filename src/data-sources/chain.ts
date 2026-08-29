// ── DataSource chain ───────────────────────────────────────────────────────
//
// chain()  –  walks sources left→right, populates misses upward.

import type { DataSource, Warmable } from './types.ts';

/** Compose multiple DataSources into a single layered cache.
 *
 *  - `get` walks left→right.  The first hit populates all sources to its
 *    left (warming the faster layers).
 *  - `set` writes to every source.
 *  - `invalidate` clears every source.
 */
export function chain<K, V>(...sources: DataSource<K, V>[]): DataSource<K, V> {
  return {
    async get(key: K): Promise<V | null> {
      for (let i = 0; i < sources.length; i++) {
        const value = await sources[i].get(key);
        if (value !== null) {
          // Populate faster layers that missed.
          for (let j = 0; j < i; j++) {
            sources[j].set(key, value).catch(() => {});
          }
          return value;
        }
      }
      return null;
    },

    async set(key: K, value: V): Promise<void> {
      await Promise.all(sources.map((s) => s.set(key, value).catch(() => {})));
    },

    invalidate(key: K): void {
      for (const s of sources) s.invalidate(key);
    },

    async warmup(): Promise<void> {
      // Walk in reverse: slowest (most authoritative) first.
      for (let i = sources.length - 1; i >= 0; i--) {
        const s = sources[i];
        if (isWarmable(s)) await s.warmup();
      }
    },
  } as DataSource<K, V> & Warmable;
}

/** Check if a DataSource supports warmup. */
export function isWarmable<K, V>(source: DataSource<K, V>): source is DataSource<K, V> & Warmable {
  return 'warmup' in source && typeof (source as Record<string, unknown>).warmup === 'function';
}
