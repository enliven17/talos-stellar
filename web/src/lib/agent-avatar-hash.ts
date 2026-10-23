/**
 * Pure, deterministic hash helper used by the pixel avatar
 * component. Extracted from `agent-avatar.tsx` so it can be tested in
 * isolation and so the memoisation cache can be bounded.
 */

/**
 * Maximum number of entries kept in the hash cache. The hash itself is a
 * cheap loop over the name, so the cache only needs to be small. This cap
 * prevents the module-level map from growing for the lifetime of the tab.
 */
export const HASH_CACHE_LIMIT = 512;

const hashCache = new Map<string, number>();

/**
 * Compute a deterministic 32-bit unsigned integer hash for `str` seeded by
 * `seed`. The algorithm is unchanged from the original implementation so
 * avatar output stays identical for every name.
 */
export function hash(str: string, seed: number): number {
  const key = `${seed}:${str}`;
  const cached = hashCache.get(key);
  if (cached !== undefined) {
    // Refresh recently-used keys for LRU eviction.
    hashCache.delete(key);
    hashCache.set(key, cached);
    return cached;
  }

  let h = seed | 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 5);
    h = (h << 7) | (h >>> 25);
  }
  const result = h >>> 0;

  hashCache.set(key, result);
  if (hashCache.size > HASH_CACHE_LIMIT) {
    // Map preserves insertion order, so the first key is the least recently
    // used after the refresh above.
    const oldestKey = hashCache.keys().next().value;
    if (oldestKey !== undefined) {
      hashCache.delete(oldestKey);
    }
  }

  return result;
}

/**
 * Returns the current number of entries in the hash cache. Exposed primarily
 * for tests to assert the cap is enforced.
 */
export function getHashCacheSize(): number {
  return hashCache.size;
}

/**
 * Clears the hash cache. Exposed for tests to avoid cross-test pollution.
 */
export function clearHashCache(): void {
  hashCache.clear();
}
