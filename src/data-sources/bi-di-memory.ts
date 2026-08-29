import type { DataSource } from './types.ts';

/** A bi-directional key for DM room lookups. */
export type DmKey = { tag: 'mxid'; value: string } | { tag: 'roomid'; value: string };

function keyString(k: DmKey): string {
  return `${k.tag}:${k.value}`;
}

/** Memory-backed DataSource that maintains both MXID→roomId and roomId→MXID
 *  directions.  `set` writes both.  `invalidate` removes both. */
export class BiDiMemorySource implements DataSource<DmKey, string> {
  readonly #map: Map<string, string>;

  constructor(map?: Map<string, string>) {
    this.#map = map ?? new Map();
  }

  async get(key: DmKey): Promise<string | null> {
    return this.#map.get(keyString(key)) ?? null;
  }

  async set(key: DmKey, value: string): Promise<void> {
    // Clean up old reverse mapping if overwriting.
    const old = this.#map.get(keyString(key));
    if (old && old !== value) {
      this.#map.delete(key.tag === 'mxid' ? `roomid:${old}` : `mxid:${old}`);
    }
    // Write both directions.
    const k = keyString(key);
    this.#map.set(k, value);
    if (key.tag === 'mxid') {
      this.#map.set(`roomid:${value}`, key.value);
    } else {
      this.#map.set(`mxid:${value}`, key.value);
    }
  }

  invalidate(key: DmKey): void {
    const k = keyString(key);
    const other = this.#map.get(k);
    this.#map.delete(k);
    if (other) {
      this.#map.delete(key.tag === 'mxid' ? `roomid:${other}` : `mxid:${other}`);
    }
  }
}
