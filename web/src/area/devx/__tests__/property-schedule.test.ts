import { describe, it, expect, afterEach } from "vitest";
import {
  loadPropertyScheduleConfig,
  parseCronExpression,
  assertKnownSuites,
  resolvePropertySeed,
  shouldRunPropertySchedule,
  describePropertySchedule,
  PropertyScheduleError,
  DEFAULT_PROPERTY_CRON,
  KNOWN_PROPERTY_SUITES,
} from "../property-schedule";

describe("parseCronExpression", () => {
  it("parses the default nightly cron", () => {
    const parsed = parseCronExpression(DEFAULT_PROPERTY_CRON);
    expect(parsed).toEqual({
      minute: "27",
      hour: "5",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "*",
    });
  });

  it("fail-closed on empty / malformed cron", () => {
    for (const bad of ["", "  ", "* * *", "60 5 * * *", "27 24 * * *", "not-a-cron"]) {
      expect(() => parseCronExpression(bad)).toThrow(PropertyScheduleError);
    }
  });
});

describe("assertKnownSuites", () => {
  it("accepts the known suite list", () => {
    expect(assertKnownSuites([...KNOWN_PROPERTY_SUITES])).toEqual([...KNOWN_PROPERTY_SUITES]);
  });

  it("fail-closed on empty or unknown suites", () => {
    expect(() => assertKnownSuites([])).toThrow(PropertyScheduleError);
    expect(() => assertKnownSuites(["datasets", "nope"])).toThrow(PropertyScheduleError);
    expect(() => assertKnownSuites("datasets" as unknown as string[])).toThrow(PropertyScheduleError);
  });
});

describe("loadPropertyScheduleConfig", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("returns safe defaults", () => {
    delete process.env.PROPERTY_TEST_CRON;
    delete process.env.PROPERTY_TEST_ITERATIONS;
    delete process.env.PROPERTY_TEST_SUITES;
    const cfg = loadPropertyScheduleConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.cron).toBe(DEFAULT_PROPERTY_CRON);
    expect(cfg.iterations).toBe(100);
    expect(cfg.failClosed).toBe(true);
    expect(cfg.suites).toEqual([...KNOWN_PROPERTY_SUITES]);
  });

  it("merges valid env overrides", () => {
    process.env.PROPERTY_TEST_ITERATIONS = "25";
    process.env.PROPERTY_TEST_SUITES = "metrics,schedule";
    process.env.PROPERTY_TEST_SEED = "7";
    const cfg = loadPropertyScheduleConfig();
    expect(cfg.iterations).toBe(25);
    expect(cfg.suites).toEqual(["metrics", "schedule"]);
    expect(cfg.seed).toBe(7);
  });

  it("fail-closed on malformed iterations env", () => {
    process.env.PROPERTY_TEST_FAIL_CLOSED = "true";
    process.env.PROPERTY_TEST_ITERATIONS = "NaN";
    expect(() => loadPropertyScheduleConfig()).toThrow(PropertyScheduleError);
  });

  it("fail-closed on malformed cron env", () => {
    process.env.PROPERTY_TEST_FAIL_CLOSED = "true";
    process.env.PROPERTY_TEST_CRON = "bad cron";
    expect(() => loadPropertyScheduleConfig()).toThrow(PropertyScheduleError);
  });

  it("overrides win over env", () => {
    process.env.PROPERTY_TEST_ITERATIONS = "25";
    const cfg = loadPropertyScheduleConfig({ iterations: 9 });
    expect(cfg.iterations).toBe(9);
  });
});

describe("resolvePropertySeed / shouldRunPropertySchedule", () => {
  it("is stable for a UTC day and honors explicit seed", () => {
    const day = new Date(Date.UTC(2026, 8, 24));
    const cfg = loadPropertyScheduleConfig({ seed: null });
    expect(resolvePropertySeed(cfg, day)).toBe(resolvePropertySeed(cfg, day));
    expect(resolvePropertySeed(loadPropertyScheduleConfig({ seed: 99 }), day)).toBe(99);
  });

  it("runs for schedule / dispatch / pr / push when enabled", () => {
    const cfg = loadPropertyScheduleConfig({ enabled: true });
    expect(shouldRunPropertySchedule(cfg, "schedule")).toBe(true);
    expect(shouldRunPropertySchedule(cfg, "workflow_dispatch")).toBe(true);
    expect(shouldRunPropertySchedule(cfg, "pull_request")).toBe(true);
    expect(shouldRunPropertySchedule(cfg, "push")).toBe(true);
  });

  it("skips when disabled and fail-closed on empty event", () => {
    const cfg = loadPropertyScheduleConfig({ enabled: false });
    expect(shouldRunPropertySchedule(cfg, "schedule")).toBe(false);
    expect(() => shouldRunPropertySchedule(cfg, "")).toThrow(PropertyScheduleError);
  });

  it("describePropertySchedule is privacy-safe", () => {
    const desc = describePropertySchedule(loadPropertyScheduleConfig());
    expect(desc).toContain("cron=");
    expect(desc.toLowerCase()).not.toMatch(/ghp_|password|secret|authorization/);
  });
});
