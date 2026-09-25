#!/usr/bin/env node
/**
 * Browser bundle smoke test.
 *
 * 1. Confirms the browser bundle file exists.
 * 2. Loads it inside a clean `vm` context (emulating a browser-like global
 *    object with only `globalThis`, no Node globals), which is close to
 *    what happens inside a browser `<script>` tag.
 * 3. Asserts `globalThis.TalosSDK` (or `window.TalosSDK`) exposes all
 *    public classes and helpers we expect from the SDK — confirming the
 *    bundle both executes without syntax errors AND exports the right
 *    surface to the global scope.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const BUNDLE_PATH = resolve(SDK_ROOT, "dist", "browser", "sdk.bundle.js");

console.log("[compat:browser-bundle] loading bundle:", BUNDLE_PATH);
assert.ok(existsSync(BUNDLE_PATH), `browser bundle missing at ${BUNDLE_PATH}`);
const bytes = statSync(BUNDLE_PATH).size;
console.log(`[compat:browser-bundle] bundle size: ${bytes} bytes`);

const source = readFileSync(BUNDLE_PATH, "utf8");

// Emulate a minimal browser global: only the things the bundle should use.
const windowLike = {};
const globalThisLike = windowLike;
const context = {
  // Mimic a browser's globals. We deliberately do NOT expose Buffer, require,
  // __dirname, etc. — this catches accidental Node-only usage in the SDK's
  // production code. `self` and `window` are real browser globals the bundle
  // is allowed to use; `process` is shimmed inside the bundle itself (see
  // scripts/bundle-browser.mjs) and must NOT be provided here.
  window: windowLike,
  globalThis: globalThisLike,
  self: windowLike,
  TextEncoder,
  TextDecoder,
  btoa,
  crypto,
  fetch: () => {
    throw new Error("fetch should not be called during import-time smoke test");
  },
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  AbortController,
  AbortSignal,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  DataView,
  ArrayBuffer,
  Promise,
  Date,
  Map,
  Set,
  WeakMap,
  WeakSet,
  console,
  Error,
  SyntaxError,
  TypeError,
  RangeError,
  JSON,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  parseInt,
  parseFloat,
  isNaN,
  URLSearchParams,
  URL,
  Headers,
  Request,
  Response,
  ReadableStream,
};
vm.createContext(context);

try {
  vm.runInContext(source, context, {
    filename: "sdk.bundle.js",
    timeout: 15_000,
  });
} catch (e) {
  console.error("[compat:browser-bundle] bundle threw at load time:", e);
  process.exit(1);
}

// Fallback bundles exposed window.TalosSDK; the esbuild IIFE declares
// `var TalosSDK`, which in a real browser lands on `window` (and here on the
// sandbox global object). Check both, preferring the global.
const sdk =
  (context.TalosSDK) ||
  (context.globalThis && context.globalThis.TalosSDK) ||
  (context.window && context.window.TalosSDK);

assert.ok(sdk, "TalosSDK not attached to global/window after loading bundle");
console.log("[compat:browser-bundle] TalosSDK attached to global scope");
if (typeof sdk.canonicalizeRequest === "function") {
  const vectors = JSON.parse(readFileSync(resolve(SDK_ROOT, "tests", "fixtures", "request-signing-vectors.json"), "utf8"));
  for (const vector of vectors.vectors) {
    const bytes = await sdk.canonicalizeRequest(vector.request);
    assert.deepEqual(Array.from(bytes), Array.from(new TextEncoder().encode(vector.canonical)), `signing vector ${vector.name}`);
  }
}
console.log(
  "  exports keys:",
  Object.keys(sdk).sort().join(", "),
);

// The esbuild bundle must expose the real public surface on the global, not
// just load: require the essential entry-point classes and a non-empty
// export set, so a bundle that silently exports nothing fails here.
const keys = Object.keys(sdk);
assert.ok(
  keys.length > 0,
  "TalosSDK exposes no exports — the bundle built but did not attach the public surface",
);
const essentials = ["TalosClient", "TalosWebhook"];
for (const k of essentials) {
  assert.ok(
    k in sdk,
    `TalosSDK is missing required export "${k}" (got ${keys.length} exports)`,
  );
  console.log("  + " + k + " present on TalosSDK");
}

console.log("[compat:browser-bundle] ALL CHECKS PASSED");
process.exit(0);
