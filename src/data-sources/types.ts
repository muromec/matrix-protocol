// ── Generic multi-level cache types ───────────────────────────────────────
//
// DataSource<K, V>  –  a single cache layer (memory, API, scan).
// Warmable          –  optional warmup hook for a cache layer.

/** A single key-value cache layer. */
export interface DataSource<K, V> {
  /** Return the value for `key`, or null if not present. */
  get(key: K): Promise<V | null>;

  /** Store `value` under `key`.  Always overwrites. */
  set(key: K, value: V): Promise<void>;

  /** Remove all knowledge of `key` from this source.  Best-effort. */
  invalidate(key: K): void;
}

/** Optional: pre-populate and validate this cache layer.
 *  Called in reverse chain order (slowest first) so each layer
 *  can seed itself from the more authoritative layer below. */
export interface Warmable {
  warmup(): Promise<void>;
}
