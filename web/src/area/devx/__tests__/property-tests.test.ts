import { describe, it, expect } from "vitest";
import { loadPropertyScheduleConfig } from "../property-schedule";
import {
  allPropertyDefinitions,
  runPropertySuite,
  runPropertyTests,
} from "../property-tests";

describe("property definitions", () => {
  it("registers all four suites", () => {
    const suites = new Set(allPropertyDefinitions().map((d) => d.suite));
    expect(suites).toEqual(new Set(["datasets", "metrics", "thresholds", "schedule"]));
    expect(allPropertyDefinitions().length).toBeGreaterThanOrEqual(10);
  });
});

describe("runPropertySuite", () => {
  it("passes datasets suite with modest iterations", () => {
    const cfg = loadPropertyScheduleConfig({
      iterations: 20,
      seed: 42,
      suites: ["datasets"],
    });
    const result = runPropertySuite("datasets", cfg, 42);
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.counterexamples).toEqual([]);
  });

  it("passes metrics suite", () => {
    const cfg = loadPropertyScheduleConfig({
      iterations: 20,
      seed: 7,
      suites: ["metrics"],
    });
    expect(runPropertySuite("metrics", cfg, 7).ok).toBe(true);
  });

  it("passes thresholds and schedule suites", () => {
    const cfg = loadPropertyScheduleConfig({
      iterations: 15,
      seed: 3,
      suites: ["thresholds", "schedule"],
    });
    expect(runPropertySuite("thresholds", cfg, 3).ok).toBe(true);
    expect(runPropertySuite("schedule", cfg, 3).ok).toBe(true);
  });
});

describe("runPropertyTests", () => {
  it("runs the full nightly matrix successfully", () => {
    const summary = runPropertyTests(
      loadPropertyScheduleConfig({
        iterations: 12,
        seed: 640,
        suites: ["datasets", "metrics", "thresholds", "schedule"],
      }),
    );
    expect(summary.skipped).toBe(false);
    expect(summary.ok).toBe(true);
    expect(summary.seed).toBe(640);
    expect(summary.suites).toHaveLength(4);
  });

  it("skips cleanly when disabled", () => {
    const summary = runPropertyTests(
      loadPropertyScheduleConfig({ enabled: false, seed: 1 }),
    );
    expect(summary.skipped).toBe(true);
    expect(summary.ok).toBe(true);
  });
});
