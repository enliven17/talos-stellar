/**
 * Benchmark runner CLI — invoked via `pnpm bench:suite [name]`.
 *
 * Usage:
 *   pnpm bench:suite           # Run all suites
 *   pnpm bench:suite api       # Run API route benchmarks
 *   pnpm bench:suite scheduler # Run scheduler loop benchmarks
 *   pnpm bench:suite sdk       # Run SDK call benchmarks
 *   pnpm bench:suite contract  # Run contract workflow benchmarks
 */

import { runBenchmarkSuite } from "./suites/index";
import { apiRouteSuites } from "./suites/api-routes";
import { schedulerSuites } from "./suites/scheduler";
import { sdkSuites } from "./suites/sdk-client";
import { contractWorkflowSuites } from "./suites/contract-workflows";

async function main() {
  const suiteName = process.argv[2];

  const suites: Record<string, { name: string; benchmarks: ReturnType<typeof apiRouteSuites> }> = {
    api: { name: "api-routes", benchmarks: apiRouteSuites() },
    scheduler: { name: "scheduler-loops", benchmarks: schedulerSuites() },
    sdk: { name: "sdk-client", benchmarks: sdkSuites() },
    contract: { name: "contract-workflows", benchmarks: contractWorkflowSuites() },
  };

  if (suiteName && suiteName !== "all") {
    const suite = suites[suiteName];
    if (!suite) {
      console.error(`Unknown suite: ${suiteName}`);
      console.error(`Available: ${Object.keys(suites).join(", ")}`);
      process.exit(1);
    }
    console.log(`Running suite: ${suite.name}`);
    await runBenchmarkSuite(suite.name, suite.benchmarks);
    return;
  }

  for (const [, suite] of Object.entries(suites)) {
    console.log(`\n=== ${suite.name} ===`);
    await runBenchmarkSuite(suite.name, suite.benchmarks);
  }
}

main().catch((err) => {
  console.error("Benchmark runner failed:", err);
  process.exit(1);
});