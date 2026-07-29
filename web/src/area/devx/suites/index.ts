import { runSuite, BenchmarkOptions } from "../runner";
import { loadConfig } from "../config";
import { writeArtifact } from "../artifacts";
import { buildTrendReport, formatTrendReport } from "../trend";
import { logBenchmarkRun, logBenchmarkResult, logFailure } from "../logger";

export async function runBenchmarkSuite(name: string, benchmarks: BenchmarkOptions[]): Promise<void> {
  const config = loadConfig();

  try {
    const run = await runSuite(name, benchmarks, config);

    for (const result of run.results) {
      logBenchmarkResult(result);
    }

    logBenchmarkRun(run);

    const artifactPath = writeArtifact(run, config.artifactDir);
    console.log(`\nArtifact: ${artifactPath}`);

    const report = buildTrendReport(name, config.artifactDir, config.trendWindow);
    console.log(formatTrendReport(report));

    if (run.summary.failed > 0) {
      console.error(`\nFAILED: ${run.summary.failed}/${run.summary.total} benchmarks failed thresholds`);
      process.exitCode = 1;
    }
  } catch (err) {
    logFailure(name, err);
    process.exitCode = 1;
  }
}