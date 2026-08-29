// ── Generic multi-level cache ──────────────────────────────────────────────
//
// DataSource<K, V>  –  a single cache layer (memory, API, scan).
// chain()           –  walks sources left→right, populates misses upward.

/** A single key-value cache layer. */
export interface DataSource<K, V> {
  /** Return the value for `key`, or null if not present. */
  get(key: K): Promise<V | null>;

  /** Store `value` under `key`.  Always overwrites. */
  set(key: K, value: V): Promise<void>;

  /** Remove all knowledge of `key` from this source.  Best-effort. */
  invalidate(key: K): void;
}

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

/** Optional: pre-populate and validate this cache layer.
 *  Called in reverse chain order (slowest first) so each layer
 *  can seed itself from the more authoritative layer below. */
export interface Warmable {
  warmup(): Promise<void>;
}

/** Check if a DataSource supports warmup. */
export function isWarmable<K, V>(source: DataSource<K, V>): source is DataSource<K, V> & Warmable {
  return 'warmup' in source && typeof (source as Record<string, unknown>).warmup === 'function';
}
