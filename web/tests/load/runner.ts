import { LoadScenario, LoadResult } from "./types";

/**
 * Send one HTTP request and measure how long it took.
 * Never throws — a failed request just gets recorded with its status.
 */
async function timedRequest(url: string): Promise<{ status: number; ms: number }> {
  const start = performance.now();

  try {
    const res = await fetch(url);
    const ms = performance.now() - start;
    return { status: res.status, ms };
  } catch {
    const ms = performance.now() - start;
    return { status: 0, ms }; // 0 = network-level failure, not an HTTP response at all
  }
}

/**
 * Run a scenario: fire `concurrency` requests at once, repeatedly,
 * until `durationMs` has elapsed. Collects everything into a LoadResult.
 */
export async function runScenario(scenario: LoadScenario, url: string): Promise<LoadResult> {
  const latenciesMs: number[] = [];
  let successCount = 0;
  let rateLimitedCount = 0;
  let failureCount = 0;

  const endTime = Date.now() + scenario.durationMs;

  while (Date.now() < endTime) {
    const batch = Array.from({ length: scenario.concurrency }, () => timedRequest(url));
    const results = await Promise.all(batch);

    for (const r of results) {
      latenciesMs.push(r.ms);

      if (r.status >= 200 && r.status < 300) {
        successCount++;
      } else if (r.status === 429) {
        rateLimitedCount++;
      } else {
        failureCount++;
      }
    }
  }

  return { scenarioName: scenario.name, successCount, rateLimitedCount, failureCount, latenciesMs };
}