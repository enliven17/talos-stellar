import { describe, it, expect } from "vitest";
import { computePercentiles, computeMean, computeMedian, computeStddev, computeVariance, summarizeStats } from "../metrics";

describe("computePercentiles", () => {
  it("returns correct percentiles for sorted values", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const result = computePercentiles(values, [50, 90, 99]);
    expect(result.p50).toBe(50);
    expect(result.p90).toBe(90);
    expect(result.p99).toBe(99);
  });

  it("handles empty array", () => {
    const result = computePercentiles([], [50, 90]);
    expect(result.p50).toBe(0);
    expect(result.p90).toBe(0);
  });

  it("handles single value", () => {
    const result = computePercentiles([42], [50, 99]);
    expect(result.p50).toBe(42);
    expect(result.p99).toBe(42);
  });
});

describe("computeMean", () => {
  it("returns correct mean", () => {
    expect(computeMean([1, 2, 3, 4, 5])).toBe(3);
  });

  it("returns 0 for empty array", () => {
    expect(computeMean([])).toBe(0);
  });
});

describe("computeMedian", () => {
  it("returns correct median for odd count", () => {
    expect(computeMedian([1, 3, 5])).toBe(3);
  });

  it("returns correct median for even count", () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });
});

describe("computeStddev", () => {
  it("returns correct standard deviation", () => {
    const values = [1, 2, 3, 4, 5];
    const mean = computeMean(values);
    const stddev = computeStddev(values, mean);
    expect(stddev).toBeCloseTo(1.581, 2);
  });

  it("returns 0 for single value", () => {
    expect(computeStddev([5], 5)).toBe(0);
  });
});

describe("computeVariance", () => {
  it("returns coefficient of variation", () => {
    const values = [10, 11, 10.5, 9.5, 10];
    const mean = computeMean(values);
    const variance = computeVariance(values, mean);
    expect(variance).toBeGreaterThan(0);
    expect(variance).toBeLessThan(0.1);
  });

  it("returns 0 when mean is 0", () => {
    expect(computeVariance([0, 0, 0], 0)).toBe(0);
  });
});

describe("summarizeStats", () => {
  it("returns all stats", () => {
    const values = [1, 2, 3, 4, 5];
    const stats = summarizeStats(values);
    expect(stats.mean).toBe(3);
    expect(stats.median).toBe(3);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.variance).toBeGreaterThan(0);
  });

  it("returns zeros for empty array", () => {
    const stats = summarizeStats([]);
    expect(stats.mean).toBe(0);
    expect(stats.median).toBe(0);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.variance).toBe(0);
  });
});