#!/usr/bin/env node
/**
 * Browser bundle size budget check — `npm run check:bundle-size`.
 *
 * Verifies that the built browser bundle respects the size budget declared in
 * `bundle-size.config.json`:
 *
 *   1. The config parses and passes the shared rules (scripts/bundle-size-lib.mjs).
 *   2. The bundle file exists and is non-empty.
 *   3. Raw and gzip byte sizes are at or below the configured ceilings.
 *   4. Testing utilities (`@talos-protocol/sdk/testing`) are not bundled into the
 *      browser bundle — they must not leak into production bundles.
 *
 * gzip is measured with Node's built-in zlib, so no external tools are needed.
 *
 * Failures are explicit and privacy-safe: messages contain metric names and
 * byte counts only — never secrets, tokens, or absolute host paths.
 *
 * This is a post-build check — run `npm run build` first. CI wires it up in
 * .github/workflows/sdk-compatibility.yml (`browser-bundle` job); `npm test`
 * covers the rules without a build via tests/bundle-size.test.ts.
 */

import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeViolation,
  evaluateBundleSize,
  validateBudgetConfig,
} from "./bundle-size-lib.mjs";

const gzip = promisify(gzipCallback);

const here = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(here, "..");
const CONFIG_PATH = join(SDK_ROOT, "bundle-size.config.json");

/**
 * Markers that must not appear in the browser bundle. The testing subpath is
 * developer-only; if any of these leak into the bundle, consumers would ship
 * mocking helpers to production.
 */
const TESTING_BANNED_MARKERS = [
  // Public subpath identifier.
  "@talos-protocol/sdk/testing",
  // Source module path fragments that would only appear if testing code was
  // bundled.
  "src/testing/",
  "/testing/index",
  // Exported factory names from the testing subpath.
  "createMockFetch",
  // Preset builders exported from the testing subpath.
  "createX402ChallengeResponse",
  "createJobLifecycleResponses",
  "createPaginatedResponse",
  "createErrorEnvelope",
];

function log(message) {
  console.log(`[check:bundle-size] ${message}`);
}
function pass(message) {
  console.log(`[check:bundle-size]   + ${message}`);
}
function fail(message) {
  console.error(`[check:bundle-size] FAIL: ${message}`);
  process.exit(1);
}

/**
 * Parse CLI flags. The only supported flag is `--allow-over-budget=<n>`, an
 * explicit escape hatch that tolerates violations by at most <n> bytes while
 * still warning — so an intentional, temporary over-budget state is visible.
 */
function parseAllowOverBudget(argv) {
  let allowed = 0;
  for (const arg of argv) {
    const match = /^--allow-over-budget=(\d+)$/.exec(arg);
    if (match) {
      allowed = Number.parseInt(match[1], 10);
      if (!Number.isInteger(allowed) || allowed < 0) {
        fail(`invalid --allow-over-budget value in "${arg}"`);
      }
    } else {
      fail(`unrecognised argument "${arg}" (supported: --allow-over-budget=<n>)`);
    }
  }
  return allowed;
}

/** Report one violation, honoring the explicit tolerance flag. */
function reportViolation(violation, allowOverBudget) {
  const described = describeViolation(violation);
  if (allowOverBudget > 0 && Number.isInteger(violation.overBy) && allowOverBudget >= violation.overBy) {
    console.warn(
      `[check:bundle-size]   ! over budget but within --allow-over-budget=${allowOverBudget}: ${described}`,
    );
  } else {
    console.error(`[check:bundle-size]   x ${described}`);
  }
}

/**
 * Scan the built browser bundle for testing-utility markers. Returns the
 * markers that were found so the caller can report them as violations.
 */
function findTestingLeaks(source) {
  const text = source.toString("utf8");
  const leaks = [];
  for (const marker of TESTING_BANNED_MARKERS) {
    if (text.includes(marker)) {
      leaks.push(marker);
    }
  }
  return leaks;
}

async function main() {
  const allowOverBudget = parseAllowOverBudget(process.argv.slice(2));

  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    fail(`could not read bundle size config: ${err?.message ?? err}`);
  }
  const validated = validateBudgetConfig(config);
  if (!validated.ok) {
    for (const error of validated.errors) fail(error);
  }
  const { maxRawBytes, maxGzipBytes } = validated.budget;
  log(`budget: raw <= ${maxRawBytes} bytes, gzip <= ${maxGzipBytes} bytes`);

  const bundlePath = join(SDK_ROOT, "dist", "browser", "sdk.bundle.js");
  if (!existsSync(bundlePath)) {
    fail(`browser bundle not found at dist/browser/sdk.bundle.js — run "npm run build" first`);
  }
  const rawBytes = statSync(bundlePath).size;
  if (rawBytes === 0) {
    fail("browser bundle is empty");
  }
  const source = readFileSync(bundlePath);

  const gzipped = await gzip(source);
  const gzipBytes = gzipped.length;
  log(`bundle: ${rawBytes} bytes raw, ${gzipBytes} bytes gzip`);

  const { ok, violations } = evaluateBundleSize(
    { rawBytes, gzipBytes },
    { maxRawBytes, maxGzipBytes },
  );

  for (const violation of violations) {
    reportViolation(violation, allowOverBudget);
  }

  // Testing utilities must never be bundled into the browser bundle. This is
  // always a hard failure — no tolerance flag applies.
  const leaks = findTestingLeaks(source);
  if (leaks.length > 0) {
    fail(
      `browser bundle includes testing utilities (${leaks.join(", ")}) — the ` +
        `@talos-protocol/sdk/testing subpath must be excluded from main and browser bundles`,
    );
  }
  pass("testing utilities are excluded from the browser bundle");

  if (!ok) {
    const withinTolerance =
      allowOverBudget > 0 && violations.every((v) => Number.isInteger(v.overBy) && allowOverBudget >= v.overBy);
    if (withinTolerance) {
      log("bundle is over budget but within --allow-over-budget tolerance");
      process.exit(0);
    }
    fail(
      "browser bundle exceeds its size budget — shrink the bundle or raise " +
        "bundle-size.config.json deliberately",
    );
  }

  pass("bundle is within budget");
  log("OK");
}

main().catch((err) => {
  console.error("[check:bundle-size] FATAL:", err);
  process.exit(1);
});
