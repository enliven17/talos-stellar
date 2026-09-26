/**
 * Nightly property-test schedule — single source of truth for when and how
 * property suites run in CI and local tooling.
 *
 * Local:
 *   pnpm --dir web property:nightly
 *   PROPERTY_TEST_ITERATIONS=200 PROPERTY_TEST_SEED=7 pnpm --dir web property:nightly
 *
 * Fail-closed: malformed cron, empty suite lists, non-finite iterations/seeds,
 * and unknown suite names throw explicit PropertyScheduleError (no silent skip).
 */

import type { PropertyScheduleConfig, PropertySuiteName } from "./types";

export class PropertyScheduleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PropertyScheduleError";
    this.code = code;
  }
}

export const DEFAULT_PROPERTY_CRON = "27 5 * * *";
export const DEFAULT_PROPERTY_TIMEZONE = "UTC";
export const KNOWN_PROPERTY_SUITES: readonly PropertySuiteName[] = [
  "datasets",
  "metrics",
  "thresholds",
  "schedule",
] as const;

const DEFAULTS: PropertyScheduleConfig = {
  enabled: true,
  cron: DEFAULT_PROPERTY_CRON,
  timezone: DEFAULT_PROPERTY_TIMEZONE,
  iterations: 100,
  seed: null,
  suites: [...KNOWN_PROPERTY_SUITES],
  timeoutMs: 120_000,
  failClosed: true,
  artifactDir: process.env.PROPERTY_ARTIFACT_DIR ?? ".property-artifacts",
  maxCounterexamples: 5,
};

/** Five-field cron: minute hour day-of-month month day-of-week */
const CRON_RE =
  /^(\*|[0-5]?\d)\s+(\*|[01]?\d|2[0-3])\s+(\*|[12]?\d|3[01])\s+(\*|[01]?\d)\s+(\*|[0-6])$/;

export function parseCronExpression(cron: string): {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
} {
  if (typeof cron !== "string" || !cron.trim()) {
    throw new PropertyScheduleError("invalid_cron", "cron expression is required");
  }
  const trimmed = cron.trim();
  const m = CRON_RE.exec(trimmed);
  if (!m) {
    throw new PropertyScheduleError(
      "invalid_cron",
      `malformed cron expression (expected 5 fields minute-hour-dom-month-dow): ${trimmed.slice(0, 64)}`,
    );
  }
  return {
    minute: m[1],
    hour: m[2],
    dayOfMonth: m[3],
    month: m[4],
    dayOfWeek: m[5],
  };
}

export function assertKnownSuites(suites: unknown): PropertySuiteName[] {
  if (!Array.isArray(suites)) {
    throw new PropertyScheduleError("invalid_suites", "suites must be a non-empty array");
  }
  if (suites.length === 0) {
    throw new PropertyScheduleError("invalid_suites", "suites must not be empty");
  }
  const out: PropertySuiteName[] = [];
  for (const s of suites) {
    if (typeof s !== "string" || !(KNOWN_PROPERTY_SUITES as readonly string[]).includes(s)) {
      throw new PropertyScheduleError(
        "unknown_suite",
        `unknown property suite: ${String(s)}. known: ${KNOWN_PROPERTY_SUITES.join(", ")}`,
      );
    }
    out.push(s as PropertySuiteName);
  }
  return out;
}

function parsePositiveInt(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new PropertyScheduleError(
      "invalid_number",
      `${field} must be a positive finite integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

function parseNonNegativeInt(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new PropertyScheduleError(
      "invalid_number",
      `${field} must be a non-negative finite integer (got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}

function parseBool(raw: string, field: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new PropertyScheduleError(
    "invalid_bool",
    `${field} must be true/false (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Load schedule config from defaults + env + optional overrides.
 * Ambiguous / malformed inputs fail closed (throw) when failClosed is true
 * (the default). When failClosed is explicitly false, invalid optional env
 * keys are ignored but required structural validation still applies to the
 * merged result.
 */
export function loadPropertyScheduleConfig(
  overrides?: Partial<PropertyScheduleConfig>,
): PropertyScheduleConfig {
  const env: Partial<PropertyScheduleConfig> = {};
  const failClosedHint =
    process.env.PROPERTY_TEST_FAIL_CLOSED !== undefined
      ? parseBool(process.env.PROPERTY_TEST_FAIL_CLOSED, "PROPERTY_TEST_FAIL_CLOSED")
      : DEFAULTS.failClosed;

  const absorb = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (failClosedHint) throw err;
      // soft mode: skip bad optional env
    }
  };

  if (process.env.PROPERTY_TEST_ENABLED !== undefined) {
    absorb(() => {
      env.enabled = parseBool(process.env.PROPERTY_TEST_ENABLED!, "PROPERTY_TEST_ENABLED");
    });
  }
  if (process.env.PROPERTY_TEST_CRON) {
    absorb(() => {
      parseCronExpression(process.env.PROPERTY_TEST_CRON!);
      env.cron = process.env.PROPERTY_TEST_CRON!.trim();
    });
  }
  if (process.env.PROPERTY_TEST_TIMEZONE) {
    env.timezone = process.env.PROPERTY_TEST_TIMEZONE.trim() || DEFAULT_PROPERTY_TIMEZONE;
  }
  if (process.env.PROPERTY_TEST_ITERATIONS) {
    absorb(() => {
      env.iterations = parsePositiveInt(
        process.env.PROPERTY_TEST_ITERATIONS!,
        "PROPERTY_TEST_ITERATIONS",
      );
    });
  }
  if (process.env.PROPERTY_TEST_SEED !== undefined && process.env.PROPERTY_TEST_SEED !== "") {
    absorb(() => {
      env.seed = parseNonNegativeInt(process.env.PROPERTY_TEST_SEED!, "PROPERTY_TEST_SEED");
    });
  }
  if (process.env.PROPERTY_TEST_SUITES) {
    absorb(() => {
      const parts = process.env.PROPERTY_TEST_SUITES!.split(",").map((s) => s.trim()).filter(Boolean);
      env.suites = assertKnownSuites(parts);
    });
  }
  if (process.env.PROPERTY_TEST_TIMEOUT_MS) {
    absorb(() => {
      env.timeoutMs = parsePositiveInt(
        process.env.PROPERTY_TEST_TIMEOUT_MS!,
        "PROPERTY_TEST_TIMEOUT_MS",
      );
    });
  }
  if (process.env.PROPERTY_TEST_FAIL_CLOSED !== undefined) {
    env.failClosed = failClosedHint;
  }
  if (process.env.PROPERTY_ARTIFACT_DIR) {
    env.artifactDir = process.env.PROPERTY_ARTIFACT_DIR;
  }
  if (process.env.PROPERTY_TEST_MAX_COUNTEREXAMPLES) {
    absorb(() => {
      env.maxCounterexamples = parsePositiveInt(
        process.env.PROPERTY_TEST_MAX_COUNTEREXAMPLES!,
        "PROPERTY_TEST_MAX_COUNTEREXAMPLES",
      );
    });
  }

  const merged: PropertyScheduleConfig = {
    ...DEFAULTS,
    ...env,
    ...overrides,
  };

  // Structural validation always runs (fail closed on bad merged config).
  parseCronExpression(merged.cron);
  merged.suites = assertKnownSuites(merged.suites);
  if (!Number.isFinite(merged.iterations) || merged.iterations <= 0) {
    throw new PropertyScheduleError("invalid_number", "iterations must be a positive finite integer");
  }
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) {
    throw new PropertyScheduleError("invalid_number", "timeoutMs must be a positive finite integer");
  }
  if (merged.seed !== null && (!Number.isFinite(merged.seed) || merged.seed < 0)) {
    throw new PropertyScheduleError("invalid_number", "seed must be null or a non-negative finite integer");
  }
  if (!merged.timezone || typeof merged.timezone !== "string") {
    throw new PropertyScheduleError("invalid_timezone", "timezone is required");
  }

  return merged;
}

/** Derive a stable nightly seed from a UTC calendar day when no seed is set. */
export function resolvePropertySeed(config: PropertyScheduleConfig, now = new Date()): number {
  if (config.seed !== null) return config.seed;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  // Simple deterministic mix — not cryptographic; safe to log.
  return ((y * 10000 + m * 100 + d) ^ 0x5f3759df) >>> 0;
}

export function describePropertySchedule(config: PropertyScheduleConfig): string {
  const parsed = parseCronExpression(config.cron);
  return [
    `enabled=${config.enabled}`,
    `cron="${config.cron}" (${config.timezone})`,
    `hourUTC=${parsed.hour} minute=${parsed.minute}`,
    `iterations=${config.iterations}`,
    `suites=${config.suites.join(",")}`,
    `failClosed=${config.failClosed}`,
    `timeoutMs=${config.timeoutMs}`,
  ].join(" ");
}

/** True when the schedule should execute for this GitHub event name. */
export function shouldRunPropertySchedule(
  config: PropertyScheduleConfig,
  eventName: string,
): boolean {
  if (!config.enabled) return false;
  if (!eventName || typeof eventName !== "string") {
    throw new PropertyScheduleError("invalid_event", "eventName is required");
  }
  const e = eventName.trim().toLowerCase();
  if (!e) {
    throw new PropertyScheduleError("invalid_event", "eventName must not be empty");
  }
  // Nightly cron + manual + PR/push verification of the property suites.
  return e === "schedule" || e === "workflow_dispatch" || e === "pull_request" || e === "push";
}
