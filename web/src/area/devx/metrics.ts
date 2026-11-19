import { Percentiles, MetricSample } from "./types";

export function computePercentiles(values: number[], points: number[]): Percentiles {
  if (values.length === 0) {
    const result: Record<string, number> = {};
    for (const p of points) result[`p${p}`] = 0;
    return result as Percentiles;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const result: Record<string, number> = {};

  for (const p of points) {
    const key = `p${p}`;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[key] = sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  return result as Percentiles;
}

export function computeMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeStddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function computeVariance(values: number[], mean: number): number {
  if (values.length === 0 || mean === 0) return 0;
  const stddev = computeStddev(values, mean);
  return stddev / mean;
}

export function extractDurations(samples: MetricSample[]): number[] {
  return samples.map((s) => s.durationMs);
}

export function extractMemory(samples: MetricSample[]): number[] {
  return samples.map((s) => s.memoryMb);
}

export function extractCpu(samples: MetricSample[]): number[] {
  return samples.map((s) => s.cpuPercent);
}

export function summarizeStats(values: number[]) {
  if (values.length === 0) {
    return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, variance: 0 };
  }
  const mean = computeMean(values);
  return {
    mean,
    median: computeMedian(values),
    stddev: computeStddev(values, mean),
    min: Math.min(...values),
    max: Math.max(...values),
    variance: computeVariance(values, mean),
  };
}