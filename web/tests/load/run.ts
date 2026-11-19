import { runScenario } from "./runner";
import { percentile } from "./types";

async function main() {
  const scenario = {
    name: "liveness-smoke",
    concurrency: 5,
    durationMs: 3000,
  };

  const url = "http://localhost:3000/api/health/live";

  console.log(`Running "${scenario.name}" — ${scenario.concurrency} concurrent, ${scenario.durationMs}ms...`);

  const result = await runScenario(scenario, url);

  console.log({
    scenario: result.scenarioName,
    successCount: result.successCount,
    rateLimitedCount: result.rateLimitedCount,
    failureCount: result.failureCount,
    p50: percentile(result.latenciesMs, 0.5),
    p95: percentile(result.latenciesMs, 0.95),
    p99: percentile(result.latenciesMs, 0.99),
  });
}

main();