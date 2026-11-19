/**
 * A single load-test scenario — one thing we're hammering with traffic.
 */
export interface LoadScenario {
  name: string;
  concurrency: number;
  durationMs: number;
}

/**
 * What we get back after actually running a LoadScenario.
 */
export interface LoadResult {
  scenarioName: string;
  successCount: number;
  rateLimitedCount: number;
  failureCount: number;
  latenciesMs: number[];
}

/**
 * Sort latencies and find the value at a given percentile.
 */
export function percentile(latenciesMs: number[], p: number): number {
  if (latenciesMs.length === 0) return 0;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}