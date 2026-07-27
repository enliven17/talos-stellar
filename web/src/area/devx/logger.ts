import pino from "pino";
import { BenchmarkRun, BenchmarkResult } from "./types";

const isCI = !!process.env.CI;

export const logger = pino({
  level: process.env.BENCHMARK_LOG_LEVEL ?? (isCI ? "info" : "debug"),
  ...(process.env.NODE_ENV === "production" || isCI
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
});

const sensitivePatterns = [
  /api[Kk]ey/i,
  /secret/i,
  /password/i,
  /token/i,
  /auth/i,
  /signature/i,
  /stellar.*secret/i,
];

export function sanitizeForLogging(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (sensitivePatterns.some((p) => p.test(key))) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function logBenchmarkRun(run: BenchmarkRun): void {
  const safe = sanitizeForLogging({
    id: run.id,
    suite: run.suite,
    summary: run.summary,
    ciRun: run.ciRun,
    commitSha: run.commitSha,
    branch: run.branch,
  });
  logger.info(safe, "Benchmark run completed");
}

export function logBenchmarkResult(result: BenchmarkResult): void {
  const safe = sanitizeForLogging({
    label: result.label,
    passed: result.passed,
    meanMs: Math.round(result.meanMs),
    p99: result.percentiles.p99,
    variance: Math.round(result.variance * 10000) / 10000,
    peakMemoryMb: Math.round(result.peakMemoryMb),
    violations: result.thresholdViolations.length,
  });
  if (result.passed) {
    logger.info(safe, "Benchmark passed");
  } else {
    logger.warn(safe, "Benchmark failed threshold check");
  }
}

export function logFailure(mode: string, error: unknown): void {
  logger.error(
    { mode, error: error instanceof Error ? error.message : String(error) },
    "Benchmark failure",
  );
}