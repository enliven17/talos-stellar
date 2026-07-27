import { BenchmarkRun, BenchmarkResult, TrendPoint, TrendReport } from "./types";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

export function writeArtifact(run: BenchmarkRun, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `benchmark-${run.suite}-${run.id.slice(0, 8)}.json`;
  const filepath = path.join(dir, filename);
  const artifact = serializeArtifact(run);
  fs.writeFileSync(filepath, JSON.stringify(artifact, null, 2));
  logger.info({ filepath, suite: run.suite }, "Benchmark artifact written");
  return filepath;
}

function serializeArtifact(run: BenchmarkRun): Record<string, unknown> {
  return {
    id: run.id,
    suite: run.suite,
    config: {
      runs: run.config.runs,
      warmupRuns: run.config.warmupRuns,
      concurrency: run.config.concurrency,
      timeoutMs: run.config.timeoutMs,
      datasetSize: run.config.datasetSize,
    },
    summary: run.summary,
    results: run.results.map(serializeResult),
    ciRun: run.ciRun,
    commitSha: run.commitSha,
    branch: run.branch,
    startedAt: new Date(run.startedAt).toISOString(),
    completedAt: new Date(run.completedAt).toISOString(),
  };
}

function serializeResult(r: BenchmarkResult): Record<string, unknown> {
  return {
    label: r.label,
    passed: r.passed,
    meanMs: Math.round(r.meanMs * 100) / 100,
    medianMs: Math.round(r.medianMs * 100) / 100,
    stddevMs: Math.round(r.stddevMs * 100) / 100,
    minMs: Math.round(r.minMs * 100) / 100,
    maxMs: Math.round(r.maxMs * 100) / 100,
    variance: Math.round(r.variance * 10000) / 10000,
    percentiles: r.percentiles,
    warmPercentiles: r.warmPercentiles,
    coldPercentiles: r.coldPercentiles,
    meanMemoryMb: Math.round(r.meanMemoryMb * 100) / 100,
    peakMemoryMb: Math.round(r.peakMemoryMb * 100) / 100,
    meanCpuPercent: Math.round(r.meanCpuPercent * 100) / 100,
    peakCpuPercent: Math.round(r.peakCpuPercent * 100) / 100,
    thresholdViolations: r.thresholdViolations,
    sampleCount: r.samples.length,
    durationMs: r.durationMs,
  };
}

export function loadArtifact(filepath: string): BenchmarkRun | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    return raw as BenchmarkRun;
  } catch {
    logger.error({ filepath }, "Failed to load benchmark artifact");
    return null;
  }
}

export function listArtifacts(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}