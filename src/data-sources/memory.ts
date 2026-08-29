import type { DataSource } from './types.ts';

/** In-memory DataSource backed by a Map. */
export class MemorySource<K, V> implements DataSource<K, V> {
  readonly #map = new Map<K, V>();

  async get(key: K): Promise<V | null> {
    return this.#map.get(key) ?? null;
  }

  async set(key: K, value: V): Promise<void> {
    this.#map.set(key, value);
  }

  invalidate(key: K): void {
    this.#map.delete(key);
  }
}
