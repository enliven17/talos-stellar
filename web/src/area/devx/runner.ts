import { BenchmarkConfig, BenchmarkResult, MetricSample, BenchmarkRun, BenchmarkSummary, BenchmarkStatus } from "./types";
import { ResourceTracker } from "./tracker";
import { computePercentiles, summarizeStats, extractDurations, extractMemory, extractCpu } from "./metrics";
import { evaluateThresholds } from "./thresholds";
import { createId } from "@paralleldrive/cuid2";
import { logger } from "./logger";

export type BenchmarkFn = () => Promise<void> | void;

export interface BenchmarkOptions {
  label: string;
  fn: BenchmarkFn;
  config: BenchmarkConfig;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const { label, fn, config } = opts;
  const coldSamples: MetricSample[] = [];
  const warmSamples: MetricSample[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < config.warmupRuns; i++) {
    const tracker = new ResourceTracker();
    tracker.start();
    const sampleStart = Date.now();
    try {
      await fn();
    } catch {
      // warmup errors are tolerated
    }
    const durationMs = Date.now() - sampleStart;
    tracker.stop();
    coldSamples.push({
      label,
      durationMs,
      memoryMb: tracker.getMeanMemory(),
      cpuPercent: tracker.getMeanCpu(),
      timestamp: Date.now(),
      warm: false,
    });
  }

  const failureCount = { value: 0 };
  for (let i = 0; i < config.runs; i++) {
    const tracker = new ResourceTracker();
    tracker.start();
    const sampleStart = Date.now();
    try {
      await fn();
    } catch {
      failureCount.value++;
    }
    const durationMs = Date.now() - sampleStart;
    tracker.stop();
    warmSamples.push({
      label,
      durationMs,
      memoryMb: tracker.getMeanMemory(),
      cpuPercent: tracker.getMeanCpu(),
      timestamp: Date.now(),
      warm: true,
    });
  }

  const allSamples = [...coldSamples, ...warmSamples];
  const durations = extractDurations(warmSamples);
  const allDurations = extractDurations(allSamples);
  const coldDurations = extractDurations(coldSamples);
  const memValues = extractMemory(warmSamples);
  const cpuValues = extractCpu(warmSamples);
  const stats = summarizeStats(durations);
  const coldStats = summarizeStats(coldDurations);
  const allStats = summarizeStats(allDurations);
  const warmPercentiles = computePercentiles(durations, config.percentiles);
  const coldPercentiles = computePercentiles(coldDurations, config.percentiles);
  const allPercentiles = computePercentiles(allDurations, config.percentiles);

  const { passed, violations } = evaluateThresholds(
    warmSamples,
    {
      variance: stats.variance,
      meanMs: stats.mean,
      p99: warmPercentiles.p99,
      peakMemoryMb: Math.max(...memValues),
      peakCpuPercent: Math.max(...cpuValues),
      failureRate: failureCount.value / Math.max(1, config.runs),
    },
    config,
  );

  return {
    label,
    samples: allSamples,
    coldSamples,
    warmSamples,
    percentiles: allPercentiles,
    coldPercentiles,
    warmPercentiles,
    meanMs: stats.mean,
    medianMs: stats.median,
    stddevMs: stats.stddev,
    minMs: stats.min,
    maxMs: stats.max,
    meanMemoryMb: memValues.reduce((a, b) => a + b, 0) / Math.max(1, memValues.length),
    peakMemoryMb: Math.max(...memValues),
    meanCpuPercent: cpuValues.reduce((a, b) => a + b, 0) / Math.max(1, cpuValues.length),
    peakCpuPercent: Math.max(...cpuValues),
    variance: stats.variance,
    passed,
    thresholdViolations: violations,
    timestamp: startedAt,
    durationMs: Date.now() - startedAt,
  };
}

export async function runSuite(
  suite: string,
  benchmarks: BenchmarkOptions[],
  config: BenchmarkConfig,
): Promise<BenchmarkRun> {
  const startedAt = Date.now();
  const results: BenchmarkResult[] = [];

  for (const opts of benchmarks) {
    logger.info({ label: opts.label }, "Running benchmark");
    const result = await runBenchmark(opts);
    results.push(result);
    logger.info({
      label: result.label,
      passed: result.passed,
      meanMs: Math.round(result.meanMs),
      p99: result.percentiles.p99,
    }, "Benchmark complete");
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const totalDurationMs = Date.now() - startedAt;

  const run: BenchmarkRun = {
    id: createId(),
    suite,
    config,
    results,
    summary: { total, passed, failed, totalDurationMs, meanDurationMs: totalDurationMs / Math.max(1, total) },
    startedAt,
    completedAt: Date.now(),
    ciRun: !!process.env.CI,
    commitSha: process.env.GITHUB_SHA ?? null,
    branch: process.env.GITHUB_REF_NAME ?? null,
  };

  return run;
}

export function parseBenchmarkStatus(run: Partial<BenchmarkRun>): BenchmarkStatus {
  if (!run.completedAt) return "running";
  if (run.summary && run.summary.failed === 0) return "completed";
  if (run.summary && run.summary.failed > 0) return "failed";
  return "cancelled";
}