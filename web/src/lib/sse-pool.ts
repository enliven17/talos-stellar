/**
 * Per-process SSE connection pool.
 *
 * On multi-instance deployments (e.g. Vercel lambda containers) each container
 * enforces its own cap independently. Total max connections across the fleet is
 * therefore: cap × running_container_count.
 *
 * Tune the cap via SSE_MAX_CONNECTIONS env var (default 200).
 */

let _cap = Number(process.env.SSE_MAX_CONNECTIONS ?? 200);
let _count = 0;
let _queries = 0;

/** Atomically reserve a connection slot. Returns false when the pool is full. */
export function acquireConnection(): boolean {
  if (_count >= _cap) return false;
  _count++;
  return true;
}

/** Release a previously acquired connection slot. */
export function releaseConnection(): void {
  _count = Math.max(0, _count - 1);
}

/** Record n DB queries against the running total (for monitoring). */
export function recordDbQueries(n: number): void {
  _queries += n;
}

/** Read-only snapshot of pool metrics. */
export function getSseMetrics() {
  return { activeConnections: _count, totalDbQueries: _queries };
}

/**
 * Reset pool state for unit tests.
 * @param cap - Override the connection cap (default 200). Must not be called from
 *              production code paths.
 */
export function __resetPool(cap = 200): void {
  _count = 0;
  _queries = 0;
  _cap = cap;
}
