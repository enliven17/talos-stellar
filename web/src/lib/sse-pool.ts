/**
 * Per-process SSE connection pool.
 *
 * On multi-instance deployments (e.g. Vercel lambda containers) each container
 * enforces its own cap independently. Total max connections across the fleet is
 * therefore: cap × running_container_count.
 *
 * Tune the cap via SSE_MAX_CONNECTIONS env var (default 200). An optional
 * per-client cap can be set via SSE_MAX_CONNECTIONS_PER_KEY so that a single
 * wallet cannot exhaust the whole pool. When a key is supplied to
 * acquireConnection/releaseConnection the per-key counter is enforced in
 * addition to the global cap; callers that omit the key get the original
 * global-only behaviour (backward compatible).
 */

let _cap = Number(process.env.SSE_MAX_CONNECTIONS ?? 200);
let _perKeyCap = Number(process.env.SSE_MAX_CONNECTIONS_PER_KEY ?? Infinity);
let _count = 0;
let _queries = 0;
const _byKey = new Map<string, number>();

/**
 * Atomically reserve a connection slot.
 *
 * @param key - Optional client identifier (e.g. wallet address). When
 *              provided, the per-key cap is enforced on top of the global cap.
 *              When omitted, only the global cap applies (legacy behaviour).
 * @returns false when the pool (or the per-key cap) is full. On rejection no
 *          counters are mutated, so a failed acquire never leaks a slot.
 */
export function acquireConnection(key?: string): boolean {
  if (_count >= _cap) return false;
  if (key !== undefined) {
    const cur = _byKey.get(key) ?? 0;
    if (cur >= _perKeyCap) return false;
    _byKey.set(key, cur + 1);
  }
  _count++;
  return true;
}

/**
 * Release a previously acquired connection slot.
 *
 * @param key - Optional client identifier. When provided, the matching
 *              per-key counter is decremented (and its tracking entry removed
 *              once it reaches zero). The global count is always decremented
 *              but never drops below zero.
 */
export function releaseConnection(key?: string): void {
  _count = Math.max(0, _count - 1);
  if (key !== undefined) {
    const cur = _byKey.get(key) ?? 0;
    if (cur <= 1) _byKey.delete(key);
    else _byKey.set(key, cur - 1);
  }
}

/** Record n DB queries against the running total (for monitoring). */
export function recordDbQueries(n: number): void {
  _queries += n;
}

/** Read-only snapshot of pool metrics. */
export function getSseMetrics() {
  return {
    activeConnections: _count,
    totalDbQueries: _queries,
    keysTracked: _byKey.size,
  };
}

/**
 * Reset pool state for unit tests.
 * @param cap - Override the global connection cap (default 200).
 * @param perKeyCap - Override the per-key connection cap (default Infinity,
 *                   i.e. no per-key limit). Must not be called from production
 *                   code paths.
 */
export function __resetPool(cap = 200, perKeyCap = Infinity): void {
  _count = 0;
  _queries = 0;
  _cap = cap;
  _perKeyCap = perKeyCap;
  _byKey.clear();
}
