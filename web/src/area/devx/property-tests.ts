/**
 * Lightweight property-based suites over existing devx primitives
 * (datasets, metrics, thresholds, schedule). No new dependency —
 * seeded LCG generation keeps nightly runs reproducible.
 */

import {
  generateTalosIds,
  generatePayloads,
  generateActivityEntries,
  generateTransferPayloads,
} from "./datasets";
import {
  computePercentiles,
  computeMean,
  computeMedian,
  summarizeStats,
} from "./metrics";
import { checkThresholds, type ThresholdRule } from "./thresholds";
import {
  loadPropertyScheduleConfig,
  parseCronExpression,
  resolvePropertySeed,
  PropertyScheduleError,
  describePropertySchedule,
} from "./property-schedule";
import { sanitizeForLogging, logger } from "./logger";
import type {
  PropertyScheduleConfig,
  PropertySuiteName,
  PropertySuiteResult,
  PropertyRunSummary,
  PropertyCounterexample,
} from "./types";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface PropertyDefinition {
  name: string;
  suite: PropertySuiteName;
  /** Return a counterexample detail string on failure, or null on success. */
  check: (rng: () => number, iteration: number) => string | null;
}

function datasetsProperties(): PropertyDefinition[] {
  return [
    {
      name: "talos-ids-length-and-charset",
      suite: "datasets",
      check: (rng) => {
        const size = 1 + Math.floor(rng() * 40);
        const seed = Math.floor(rng() * 1e9);
        const ids = generateTalosIds(size, seed);
        if (ids.length !== size) return `length ${ids.length} != ${size}`;
        for (const id of ids) {
          if (!/^[a-z0-9]{24}$/.test(id)) return `bad id shape: ${id.slice(0, 32)}`;
        }
        const again = generateTalosIds(size, seed);
        if (JSON.stringify(ids) !== JSON.stringify(again)) return "non-deterministic for same seed";
        return null;
      },
    },
    {
      name: "payloads-shape-and-determinism",
      suite: "datasets",
      check: (rng) => {
        const size = 1 + Math.floor(rng() * 30);
        const seed = Math.floor(rng() * 1e9);
        const a = generatePayloads(size, seed);
        const b = generatePayloads(size, seed);
        if (JSON.stringify(a) !== JSON.stringify(b)) return "non-deterministic payloads";
        for (const p of a) {
          if (typeof p.index !== "number" || typeof p.value !== "number") return "missing fields";
          if (!Array.isArray(p.tags)) return "tags not array";
        }
        return null;
      },
    },
    {
      name: "activity-entries-valid-enums",
      suite: "datasets",
      check: (rng) => {
        const size = 1 + Math.floor(rng() * 40);
        const seed = Math.floor(rng() * 1e9);
        const types = new Set(["post", "research", "reply", "engagement", "commerce", "approval"]);
        const channels = new Set(["twitter", "discord", "telegram", "email", "web"]);
        for (const e of generateActivityEntries(size, seed)) {
          if (!types.has(e.type)) return `invalid type ${e.type}`;
          if (!channels.has(e.channel)) return `invalid channel ${e.channel}`;
          if (!e.content) return "empty content";
        }
        return null;
      },
    },
    {
      name: "transfer-payloads-stellar-shape",
      suite: "datasets",
      check: (rng) => {
        const size = 1 + Math.floor(rng() * 20);
        const seed = Math.floor(rng() * 1e9);
        for (const p of generateTransferPayloads(size, seed)) {
          if (p.asset !== "USDC") return "asset";
          if (!/^\d+\.\d{2}$/.test(p.amount)) return `amount ${p.amount}`;
          if (!/^[0-9a-f]{64}$/.test(p.nonce)) return "nonce";
          if (!/^G[A-Z2-7]{55}$/.test(p.destination)) return "destination";
        }
        return null;
      },
    },
  ];
}

function metricsProperties(): PropertyDefinition[] {
  return [
    {
      name: "percentiles-ordered-and-in-range",
      suite: "metrics",
      check: (rng) => {
        const n = 1 + Math.floor(rng() * 200);
        const values = Array.from({ length: n }, () => rng() * 10_000);
        const points = [50, 75, 90, 95, 99];
        const p = computePercentiles(values, points);
        const min = Math.min(...values);
        const max = Math.max(...values);
        let prev = -Infinity;
        for (const pt of points) {
          const v = p[`p${pt}`];
          if (!Number.isFinite(v)) return `non-finite p${pt}`;
          if (v < min - 1e-9 || v > max + 1e-9) return `p${pt}=${v} outside [${min},${max}]`;
          if (v + 1e-9 < prev) return `percentile order broken at p${pt}`;
          prev = v;
        }
        return null;
      },
    },
    {
      name: "mean-median-within-minmax",
      suite: "metrics",
      check: (rng) => {
        const n = 1 + Math.floor(rng() * 150);
        const values = Array.from({ length: n }, () => (rng() - 0.5) * 1000);
        const stats = summarizeStats(values);
        if (stats.mean < stats.min - 1e-9 || stats.mean > stats.max + 1e-9) {
          return `mean ${stats.mean} outside [${stats.min},${stats.max}]`;
        }
        if (stats.median < stats.min - 1e-9 || stats.median > stats.max + 1e-9) {
          return `median ${stats.median} outside [${stats.min},${stats.max}]`;
        }
        if (Math.abs(stats.mean - computeMean(values)) > 1e-9) return "mean mismatch";
        if (Math.abs(stats.median - computeMedian(values)) > 1e-9) return "median mismatch";
        return null;
      },
    },
    {
      name: "empty-values-are-zero-safe",
      suite: "metrics",
      check: () => {
        const p = computePercentiles([], [50, 99]);
        if (p.p50 !== 0 || p.p99 !== 0) return "empty percentiles should be 0";
        const s = summarizeStats([]);
        if (s.mean !== 0 || s.median !== 0 || s.min !== 0 || s.max !== 0) {
          return "empty summarizeStats should be zeros";
        }
        return null;
      },
    },
  ];
}

function thresholdsProperties(): PropertyDefinition[] {
  return [
    {
      name: "fail-severity-blocks-pass",
      suite: "thresholds",
      check: (rng) => {
        const peakMemoryMb = 100 + Math.floor(rng() * 900);
        const threshold = peakMemoryMb - 1;
        const rules: ThresholdRule[] = [
          { metric: "peakMemoryMb", threshold, severity: "fail", comparator: "gt" },
        ];
        const violations = checkThresholds(
          {
            variance: 0,
            meanMs: 1,
            p99: 1,
            peakMemoryMb,
            peakCpuPercent: 1,
            failureRate: 0,
          },
          rules,
        );
        const hasFail = violations.some((v) => v.severity === "fail");
        if (!hasFail) return "expected fail violation when peakMemoryMb > threshold";
        return null;
      },
    },
    {
      name: "unknown-metric-ignored-not-thrown",
      suite: "thresholds",
      check: () => {
        const rules: ThresholdRule[] = [
          { metric: "notARealMetric", threshold: 1, severity: "fail", comparator: "gt" },
        ];
        const violations = checkThresholds(
          {
            variance: 0,
            meanMs: 1,
            p99: 1,
            peakMemoryMb: 1,
            peakCpuPercent: 1,
            failureRate: 0,
          },
          rules,
        );
        if (violations.length !== 0) return "unknown metric should be skipped";
        return null;
      },
    },
  ];
}

function scheduleProperties(): PropertyDefinition[] {
  return [
    {
      name: "default-cron-parses",
      suite: "schedule",
      check: () => {
        const cfg = loadPropertyScheduleConfig();
        const parsed = parseCronExpression(cfg.cron);
        if (parsed.hour !== "5" || parsed.minute !== "27") {
          return `unexpected default cron parse ${JSON.stringify(parsed)}`;
        }
        if (!cfg.enabled) return "default should be enabled";
        return null;
      },
    },
    {
      name: "malformed-cron-fail-closed",
      suite: "schedule",
      check: (rng) => {
        const bad = ["", "not-cron", "* * *", "60 5 * * *", "27 25 * * *", "a b c d e"][
          Math.floor(rng() * 6)
        ];
        try {
          parseCronExpression(bad);
          return `expected throw for ${JSON.stringify(bad)}`;
        } catch (err) {
          if (!(err instanceof PropertyScheduleError) || err.code !== "invalid_cron") {
            return `wrong error for ${JSON.stringify(bad)}: ${String(err)}`;
          }
          return null;
        }
      },
    },
    {
      name: "seed-resolution-stable-per-day",
      suite: "schedule",
      check: (rng) => {
        const day = new Date(Date.UTC(2026, 8, 1 + Math.floor(rng() * 27)));
        const cfg = loadPropertyScheduleConfig({ seed: null });
        const a = resolvePropertySeed(cfg, day);
        const b = resolvePropertySeed(cfg, day);
        if (a !== b) return "seed not stable for same UTC day";
        const fixed = loadPropertyScheduleConfig({ seed: 42 });
        if (resolvePropertySeed(fixed, day) !== 42) return "explicit seed not honored";
        return null;
      },
    },
    {
      name: "describe-omits-secrets",
      suite: "schedule",
      check: () => {
        const cfg = loadPropertyScheduleConfig();
        const desc = describePropertySchedule(cfg);
        const lower = desc.toLowerCase();
        for (const needle of ["ghp_", "password", "secret", "token=", "authorization"]) {
          if (lower.includes(needle)) return `leaked sensitive token in describe: ${needle}`;
        }
        return null;
      },
    },
  ];
}

export function allPropertyDefinitions(): PropertyDefinition[] {
  return [
    ...datasetsProperties(),
    ...metricsProperties(),
    ...thresholdsProperties(),
    ...scheduleProperties(),
  ];
}

export function runPropertySuite(
  suite: PropertySuiteName,
  config: PropertyScheduleConfig,
  seed: number,
): PropertySuiteResult {
  const defs = allPropertyDefinitions().filter((d) => d.suite === suite);
  const rng = seededRandom(seed ^ suite.length * 2654435761);
  const counterexamples: PropertyCounterexample[] = [];
  let passed = 0;
  let failed = 0;

  for (const def of defs) {
    let propertyFailed = false;
    for (let i = 0; i < config.iterations; i++) {
      const detail = def.check(rng, i);
      if (detail) {
        propertyFailed = true;
        if (counterexamples.length < config.maxCounterexamples) {
          counterexamples.push({
            property: def.name,
            suite,
            iteration: i,
            seed,
            detail,
          });
        }
        break;
      }
    }
    if (propertyFailed) failed += 1;
    else passed += 1;
  }

  return {
    suite,
    properties: defs.length,
    passed,
    failed,
    iterations: config.iterations,
    seed,
    counterexamples,
    ok: failed === 0,
  };
}

export function runPropertyTests(
  config: PropertyScheduleConfig = loadPropertyScheduleConfig(),
  now = new Date(),
): PropertyRunSummary {
  if (!config.enabled) {
    return {
      ok: true,
      skipped: true,
      reason: "property schedule disabled",
      seed: resolvePropertySeed(config, now),
      suites: [],
      startedAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      schedule: describePropertySchedule(config),
    };
  }

  const seed = resolvePropertySeed(config, now);
  const startedAt = new Date().toISOString();
  const suites: PropertySuiteResult[] = [];

  for (const suite of config.suites) {
    suites.push(runPropertySuite(suite, config, seed));
  }

  const summary: PropertyRunSummary = {
    ok: suites.every((s) => s.ok),
    skipped: false,
    seed,
    suites,
    startedAt,
    completedAt: new Date().toISOString(),
    schedule: describePropertySchedule(config),
  };

  // Privacy-safe log: never include secrets, signatures, or raw env.
  const safe = sanitizeForLogging({
    ok: summary.ok,
    seed: summary.seed,
    schedule: summary.schedule,
    suites: summary.suites.map((s) => ({
      suite: s.suite,
      passed: s.passed,
      failed: s.failed,
      ok: s.ok,
      counterexampleCount: s.counterexamples.length,
    })),
  });
  if (summary.ok) {
    logger.info(safe, "Property test run completed");
  } else {
    logger.warn(safe, "Property test run failed");
  }

  return summary;
}

export function writePropertyArtifact(summary: PropertyRunSummary, artifactDir: string): string {
  mkdirSync(artifactDir, { recursive: true });
  const name = `property-run-${summary.seed}-${Date.now()}.json`;
  const path = join(artifactDir, name);
  // Strip potential sensitive fields if ever present in counterexample detail.
  const safe = {
    ...summary,
    suites: summary.suites.map((s) => ({
      ...s,
      counterexamples: s.counterexamples.map((c) => ({
        ...c,
        detail: c.detail.slice(0, 500),
      })),
    })),
  };
  writeFileSync(path, JSON.stringify(safe, null, 2));
  return path;
}
