/**
 * Minimal Map-backed LRUCache, aliased over `lru-cache` via JITI_ALIAS when running the
 * events loader. @openpanel/common/server's UA parser does `new LRUCache({max})` at module
 * load, but lru-cache@11 is ESM-only and jiti's CJS interop can't construct it
 * (`_lruCache.LRUCache is not a constructor`). The cache is purely a perf optimization
 * (get/set/has on UA-parse results), so a simple bounded Map is behaviorally equivalent.
 *
 * Used only by the migration scripts under jiti:
 *   JITI_ALIAS='{"lru-cache":"<abs>/packages/db/scripts/lru-cache-shim.ts"}'
 */
export class LRUCache<K = unknown, V = unknown> {
  private max: number;
  private m = new Map<K, V>();
  constructor(opts?: { max?: number }) {
    this.max = opts?.max ?? 5000;
  }
  get(k: K): V | undefined {
    return this.m.get(k);
  }
  set(k: K, v: V): this {
    if (this.m.size >= this.max && !this.m.has(k)) {
      const oldest = this.m.keys().next().value as K | undefined;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(k, v);
    return this;
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  delete(k: K): boolean {
    return this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  get size(): number {
    return this.m.size;
  }
}

export default LRUCache;
