/**
 * Nightly / local property-test runner.
 *
 *   pnpm --dir web property:nightly
 *   PROPERTY_TEST_SUITES=metrics,schedule PROPERTY_TEST_ITERATIONS=50 pnpm --dir web property:nightly
 */

import {
  loadPropertyScheduleConfig,
  shouldRunPropertySchedule,
  PropertyScheduleError,
} from "./property-schedule";
import { runPropertyTests, writePropertyArtifact } from "./property-tests";

function main(): void {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch";

  let config;
  try {
    config = loadPropertyScheduleConfig();
  } catch (err) {
    const msg = err instanceof PropertyScheduleError ? `${err.code}: ${err.message}` : String(err);
    console.error(`Property schedule config error (fail-closed): ${msg}`);
    process.exit(1);
    return;
  }

  try {
    if (!shouldRunPropertySchedule(config, eventName)) {
      console.log(`Skipping property tests for event=${eventName} enabled=${config.enabled}`);
      process.exit(0);
      return;
    }
  } catch (err) {
    const msg = err instanceof PropertyScheduleError ? `${err.code}: ${err.message}` : String(err);
    console.error(`Property schedule event error (fail-closed): ${msg}`);
    process.exit(1);
    return;
  }

  console.log(`Running property tests (cron=${config.cron}, suites=${config.suites.join(",")})…`);
  const summary = runPropertyTests(config);
  const artifact = writePropertyArtifact(summary, config.artifactDir);
  console.log(`Artifact: ${artifact}`);
  console.log(
    JSON.stringify(
      {
        ok: summary.ok,
        skipped: summary.skipped,
        seed: summary.seed,
        suites: summary.suites.map((s) => ({
          suite: s.suite,
          passed: s.passed,
          failed: s.failed,
          ok: s.ok,
        })),
      },
      null,
      2,
    ),
  );

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main();
