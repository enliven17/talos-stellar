/**
 * Browser bundle size budget — shared rules for `@talos-protocol/sdk`.
 *
 * Single source of truth for the "is the browser bundle within its size
 * budget?" check. It is shared by:
 *
 *   • scripts/bundle-browser.mjs             — reports sizes after the build
 *   • scripts/check-browser-bundle-size.mjs  — enforces the budget (CI, `compat`)
 *   • tests/bundle-size.test.ts              — unit tests that need no build
 *
 * Everything here is pure: it never touches the filesystem, the network, or
 * `process`. Callers pass an already-parsed config object and measured byte
 * counts, so the same rules apply to the real inputs and to negative
 * fixtures. Error strings only ever contain metric names and byte counts —
 * never secrets, tokens, or absolute host paths.
 */

/** Default budget, kept in sync with bundle-size.config.json. */
export const DEFAULT_BUDGET = Object.freeze({
  maxRawBytes: 1_110_000,
  maxGzipBytes: 310_000,
});

export const SIZE_METRICS = Object.freeze(["raw", "gzip"]);

/** @returns {boolean} true for non-null, non-array objects. */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed budget config.
 *
 * The config must be an object with integer byte ceilings > 0 for every
 * metric, and no unknown keys (so a renamed metric fails loudly instead of
 * being silently unenforced).
 *
 * @param {unknown} config parsed bundle-size.config.json
 * @returns {{ ok: boolean, errors: string[], budget: { maxRawBytes: number, maxGzipBytes: number } | null }}
 */
export function validateBudgetConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    errors.push("bundle size config must be a JSON object");
    return { ok: false, errors, budget: null };
  }

  const budget = {};
  for (const metric of SIZE_METRICS) {
    const key = `max${metric[0].toUpperCase()}${metric.slice(1)}Bytes`;
    const value = config[key];
    if (value === undefined) {
      errors.push(`bundle size config is missing "${key}"`);
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`"${key}" must be a positive integer byte count, got ${JSON.stringify(value)}`);
      continue;
    }
    budget[key] = value;
  }

  const known = new Set(SIZE_METRICS.map((m) => `max${m[0].toUpperCase()}${m.slice(1)}Bytes`));
  for (const key of Object.keys(config)) {
    if (!known.has(key)) {
      errors.push(`unrecognised bundle size config key "${key}" — remove it or add it to the rules`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, budget: null };
  return { ok: true, errors, budget };
}

/**
 * Compare measured bundle sizes against the budget.
 *
 * A metric passes when its measured size is at or below the ceiling; the
 * boundary itself is allowed so budgets are inclusive upper limits.
 *
 * @param {{ rawBytes: number, gzipBytes: number }} measured
 * @param {{ maxRawBytes: number, maxGzipBytes: number }} budget
 * @returns {{ ok: boolean, violations: Array<{ metric: string, label: string, actual: number, max: number, overBy: number }> }}
 */
export function evaluateBundleSize(measured, budget) {
  const violations = [];
  for (const metric of SIZE_METRICS) {
    const key = `max${metric[0].toUpperCase()}${metric.slice(1)}Bytes`;
    const actual = measured[`${metric}Bytes`];
    const max = budget[key];
    if (typeof actual !== "number" || !Number.isInteger(actual) || actual < 0) {
      violations.push({
        metric,
        label: key,
        actual,
        max,
        overBy: NaN,
      });
      continue;
    }
    if (actual > max) {
      violations.push({
        metric,
        label: key,
        actual,
        max,
        overBy: actual - max,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Human-readable one-line description of a violation (privacy-safe). */
export function describeViolation(violation) {
  if (!Number.isInteger(violation.actual)) {
    return `${violation.label}: measured size is not an integer byte count (got ${JSON.stringify(violation.actual)})`;
  }
  return (
    `${violation.label}: ${violation.actual} bytes exceeds the budget of ` +
    `${violation.max} bytes by ${violation.overBy} bytes`
  );
}
