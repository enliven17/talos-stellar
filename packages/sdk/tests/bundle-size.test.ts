/**
 * Bundle size budget — rules for the browser bundle of `@talos-protocol/sdk`.
 *
 * These tests run without a build. They exercise the shared rules in
 * scripts/bundle-size-lib.mjs: config validation (missing, malformed, and
 * boundary inputs), size evaluation (pass, fail, boundary), and the
 * human-readable violation description. The runtime half of the same
 * contract — measuring the real artifact in CI — lives in
 * scripts/check-browser-bundle-size.mjs (`npm run check:bundle-size`), and
 * the build itself re-checks in scripts/bundle-browser.mjs.
 *
 * The config file and these rules must stay coherent: a test below parses
 * bundle-size.config.json and asserts it passes validation, so a hand-edit
 * that drifts from the rules fails here before it reaches CI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGET,
  SIZE_METRICS,
  describeViolation,
  evaluateBundleSize,
  isPlainObject,
  validateBudgetConfig,
} from "../scripts/bundle-size-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A valid config used as a mutation base for negative cases. */
function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    maxRawBytes: 1_100_000,
    maxGzipBytes: 310_000,
    ...overrides,
  };
}

describe("bundle size budget config validation", () => {
  it("accepts the committed bundle-size.config.json", () => {
    const config = JSON.parse(
      readFileSync(resolve(__dirname, "../bundle-size.config.json"), "utf8"),
    );
    const result = validateBudgetConfig(config);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.budget).not.toBeNull();
  });

  it("accepts a well-formed config and echoes its ceilings", () => {
    const result = validateBudgetConfig(baseConfig({ maxRawBytes: 42, maxGzipBytes: 7 }));
    expect(result.ok).toBe(true);
    expect(result.budget).toEqual({ maxRawBytes: 42, maxGzipBytes: 7 });
  });

  it("rejects non-object configs (missing or malformed input)", () => {
    for (const bad of [undefined, null, "1100000", 42, []]) {
      const result = validateBudgetConfig(bad);
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("must be a JSON object");
      expect(result.budget).toBeNull();
    }
  });

  it("rejects a config with missing ceilings", () => {
    const result = validateBudgetConfig({ maxRawBytes: 1_100_000 });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('missing "maxGzipBytes"');
  });

  it("rejects non-integer, zero, and negative ceilings", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "1100000", null]) {
      const result = validateBudgetConfig({ ...baseConfig(), maxRawBytes: bad });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain('"maxRawBytes" must be a positive integer byte count');
    }
  });

  it("rejects unknown keys so a renamed metric cannot go silently unenforced", () => {
    const result = validateBudgetConfig(baseConfig({ maxSizeBytes: 1 }));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('unrecognised bundle size config key "maxSizeBytes"');
  });

  it("reports every bad key at once instead of failing on the first", () => {
    const result = validateBudgetConfig({ maxGzip: -5 });
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain('missing "maxRawBytes"');
    expect(joined).toContain('missing "maxGzipBytes"');
    expect(joined).toContain('unrecognised bundle size config key "maxGzip"');
  });
});

describe("bundle size evaluation", () => {
  it("passes when both metrics are within budget", () => {
    const { ok, violations } = evaluateBundleSize(
      { rawBytes: 1_034_698, gzipBytes: 285_110 },
      { maxRawBytes: 1_100_000, maxGzipBytes: 310_000 },
    );
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it("treats the budget as an inclusive upper bound (boundary values pass)", () => {
    const { ok, violations } = evaluateBundleSize(
      { rawBytes: 1_100_000, gzipBytes: 310_000 },
      { maxRawBytes: 1_100_000, maxGzipBytes: 310_000 },
    );
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it("fails when a single metric is one byte over", () => {
    const { ok, violations } = evaluateBundleSize(
      { rawBytes: 1_100_001, gzipBytes: 310_000 },
      { maxRawBytes: 1_100_000, maxGzipBytes: 310_000 },
    );
    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      metric: "raw",
      label: "maxRawBytes",
      actual: 1_100_001,
      max: 1_100_000,
      overBy: 1,
    });
  });

  it("reports both metrics when both are over budget", () => {
    const { ok, violations } = evaluateBundleSize(
      { rawBytes: 2_000_000, gzipBytes: 400_000 },
      { maxRawBytes: 1_100_000, maxGzipBytes: 310_000 },
    );
    expect(ok).toBe(false);
    expect(violations.map((v) => v.metric).sort()).toEqual(["gzip", "raw"]);
  });

  it("rejects malformed measurements instead of silently passing them", () => {
    for (const bad of [undefined, null, -1, 1.5, Number.NaN]) {
      const { ok, violations } = evaluateBundleSize(
        { rawBytes: bad as unknown as number, gzipBytes: 0 },
        { maxRawBytes: 1_100_000, maxGzipBytes: 310_000 },
      );
      expect(ok).toBe(false);
      expect(violations[0].metric).toBe("raw");
    }
  });
});

describe("violation descriptions", () => {
  it("describes an over-budget metric with actual, ceiling, and overshoot", () => {
    const text = describeViolation({
      metric: "gzip",
      label: "maxGzipBytes",
      actual: 400_000,
      max: 310_000,
      overBy: 90_000,
    });
    expect(text).toContain("maxGzipBytes: 400000 bytes exceeds the budget of 310000 bytes");
    expect(text).toContain("by 90000 bytes");
  });

  it("describes a malformed measurement without crashing", () => {
    const text = describeViolation({
      metric: "raw",
      label: "maxRawBytes",
      actual: undefined as unknown as number,
      max: 1_100_000,
      overBy: Number.NaN,
    });
    expect(text).toContain("maxRawBytes: measured size is not an integer byte count");
  });
});

describe("module invariants", () => {
  it("covers exactly the raw and gzip metrics", () => {
    expect([...SIZE_METRICS].sort()).toEqual(["gzip", "raw"]);
  });

  it("keeps the default budget aligned with the committed config", () => {
    const config = JSON.parse(
      readFileSync(resolve(__dirname, "../bundle-size.config.json"), "utf8"),
    );
    expect(config).toEqual({
      maxRawBytes: DEFAULT_BUDGET.maxRawBytes,
      maxGzipBytes: DEFAULT_BUDGET.maxGzipBytes,
    });
  });

  it("exports a plain-object predicate used by the rules", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([1])).toBe(false);
  });
});
