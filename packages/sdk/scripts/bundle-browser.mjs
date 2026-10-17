#!/usr/bin/env node
/**
 * Browser bundle script — `npm run build:browser`.
 *
 * Bundles the built ESM output (`dist/esm/index.js`) plus its dependencies
 * into a single minified IIFE that exposes the SDK on `globalThis.TalosSDK`,
 * so the package can be used from a plain `<script>` tag (the `browser`
 * condition in the export map).
 *
 * esbuild is a devDependency of this package and is the only supported
 * bundler here. Earlier versions fell back to concatenating the ESM output,
 * but that produced a syntactically invalid bundle (raw `export` statements
 * inside an IIFE) whenever esbuild was not installed — so the fallback was
 * removed rather than repaired. If esbuild cannot be loaded, this script
 * fails with an actionable message instead of emitting a broken artifact.
 *
 * A `process` shim is injected and `process.env.NODE_ENV` is defined to
 * `"production"`: the SDK's dependencies (e.g. the Stellar SDK's browser
 * polyfills) reference Node globals at import time, and browsers have no
 * `process`. The shim is scoped to the bundle and never logs anything.
 *
 * After writing the bundle, the raw and gzip sizes are reported and checked
 * against the budget in `bundle-size.config.json` (rules in
 * scripts/bundle-size-lib.mjs). An over-budget build fails here and again in
 * `npm run check:bundle-size`, so regressions cannot slip into dist quietly.
 */

import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeViolation,
  evaluateBundleSize,
  validateBudgetConfig,
} from "./bundle-size-lib.mjs";

const gzip = promisify(gzipCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ESM_DIR = join(ROOT, "dist", "esm");
const BROWSER_DIR = join(ROOT, "dist", "browser");
const BUNDLE_OUT = join(BROWSER_DIR, "sdk.bundle.js");
const CONFIG_PATH = join(ROOT, "bundle-size.config.json");

const PROCESS_SHIM =
  'var process = typeof process !== "undefined" ? process : { env: {} };';

function log(message) {
  console.log(`[build:browser] ${message}`);
}

function loadBudget() {
  if (!existsSync(CONFIG_PATH)) {
    return null; // No config — skip enforcement, keep building.
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error(`[build:browser] FAIL: could not read bundle size config: ${err?.message ?? err}`);
    process.exit(1);
  }
  const validated = validateBudgetConfig(parsed);
  if (!validated.ok) {
    for (const error of validated.errors) {
      console.error(`[build:browser] FAIL: ${error}`);
    }
    process.exit(1);
  }
  return validated.budget;
}

async function bundleWithEsbuild() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (err) {
    console.error(
      "[build:browser] FAIL: esbuild is required to build the browser bundle but could not be loaded " +
        `(${err?.message ?? err}). ` +
        "Install the package's devDependencies (pnpm install --frozen-lockfile, or npm install in packages/sdk) " +
        "and re-run `npm run build:browser`.",
    );
    process.exit(1);
  }

  if (!existsSync(join(ESM_DIR, "index.js"))) {
    throw new Error(`ESM dist not found at ${ESM_DIR}. Run build:esm first.`);
  }

  await esbuild.build({
    entryPoints: [join(ESM_DIR, "index.js")],
    bundle: true,
    format: "iife",
    globalName: "TalosSDK",
    platform: "browser",
    target: "es2020",
    outfile: BUNDLE_OUT,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    allowOverwrite: true,
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: PROCESS_SHIM },
  });
  log("bundled via esbuild ->", "dist/browser/sdk.bundle.js");
}

async function main() {
  mkdirSync(BROWSER_DIR, { recursive: true });
  await bundleWithEsbuild();

  const rawBytes = statSync(BUNDLE_OUT).size;
  const gzipped = await gzip(readFileSync(BUNDLE_OUT));
  const gzipBytes = gzipped.length;
  log(`bundle size: ${rawBytes} bytes raw, ${gzipBytes} bytes gzip`);

  const budget = loadBudget();
  if (budget) {
    const { ok, violations } = evaluateBundleSize(
      { rawBytes, gzipBytes },
      budget,
    );
    if (!ok) {
      for (const violation of violations) {
        console.error(`[build:browser]   x ${describeViolation(violation)}`);
      }
      console.error(
        "[build:browser] FAIL: browser bundle exceeds its size budget — shrink the bundle " +
          "or raise bundle-size.config.json deliberately.",
      );
      process.exit(1);
    }
    log("bundle is within budget");
  }

  log(`OK (${rawBytes} bytes)`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
