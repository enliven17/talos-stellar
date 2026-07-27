import { BenchmarkConfig } from "./types";

const DEFAULTS: BenchmarkConfig = {
  runs: 100,
  warmupRuns: 10,
  concurrency: 1,
  timeoutMs: 30_000,
  datasetSize: 1000,
  percentiles: [50, 75, 90, 95, 99],
  varianceThreshold: 0.15,
  memoryThresholdMb: 512,
  cpuThresholdPercent: 80,
  artifactDir: process.env.BENCHMARK_ARTIFACT_DIR ?? ".benchmarks",
  trendWindow: 10,
};

export function loadConfig(overrides?: Partial<BenchmarkConfig>): BenchmarkConfig {
  const env: Partial<BenchmarkConfig> = {};

  if (process.env.BENCHMARK_RUNS) env.runs = Number(process.env.BENCHMARK_RUNS);
  if (process.env.BENCHMARK_WARMUP_RUNS) env.warmupRuns = Number(process.env.BENCHMARK_WARMUP_RUNS);
  if (process.env.BENCHMARK_CONCURRENCY) env.concurrency = Number(process.env.BENCHMARK_CONCURRENCY);
  if (process.env.BENCHMARK_TIMEOUT_MS) env.timeoutMs = Number(process.env.BENCHMARK_TIMEOUT_MS);
  if (process.env.BENCHMARK_DATASET_SIZE) env.datasetSize = Number(process.env.BENCHMARK_DATASET_SIZE);
  if (process.env.BENCHMARK_VARIANCE_THRESHOLD) env.varianceThreshold = Number(process.env.BENCHMARK_VARIANCE_THRESHOLD);
  if (process.env.BENCHMARK_MEMORY_THRESHOLD_MB) env.memoryThresholdMb = Number(process.env.BENCHMARK_MEMORY_THRESHOLD_MB);
  if (process.env.BENCHMARK_CPU_THRESHOLD_PCT) env.cpuThresholdPercent = Number(process.env.BENCHMARK_CPU_THRESHOLD_PCT);
  if (process.env.BENCHMARK_ARTIFACT_DIR) env.artifactDir = process.env.BENCHMARK_ARTIFACT_DIR;
  if (process.env.BENCHMARK_TREND_WINDOW) env.trendWindow = Number(process.env.BENCHMARK_TREND_WINDOW);

  return { ...DEFAULTS, ...env, ...overrides };
}