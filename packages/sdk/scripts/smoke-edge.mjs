#!/usr/bin/env node
/**
 * Edge / Worker-like runtime smoke test.
 *
 * Runs the built ESM SDK inside a clean VM context that deliberately lacks:
 *   - `require`, `process`, `Buffer`, `__dirname`, `fs`, `net`, `http`, ... (all Node built-ins)
 *
 * Keeps only the standardised web APIs that edge runtimes (Vercel Edge,
 * Cloudflare Workers, Deno Deploy) expose:
 *   - globalThis, TextEncoder / TextDecoder, crypto, fetch (stubbed), setTimeout
 *   - Uint8Array, ArrayBuffer, Promise, Date, Map, Set, AbortController, Headers, URL, ...
 *
 * Then it asserts the ESM SDK can be evaluated in that restricted environment
 * and its exported classes can be instantiated without touching Node APIs —
 * proving the SDK is safe to load inside an Edge worker.
 *
 * Finally every declared subpath export (`./webhooks`, `./events`, `./errors`)
 * is bundled the way a serverless build would bundle it and loaded in the same
 * sandbox, proving a webhook handler can be deployed without the client or the
 * Stellar SDK.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Keypair, StrKey, Networks } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const ESM_DIR = resolve(SDK_ROOT, "dist", "esm");
const ESM_ENTRY = join(ESM_DIR, "index.js");

console.log("[compat:edge] loading ESM entry from:", ESM_ENTRY);
assert.ok(existsSync(ESM_ENTRY), `ESM dist missing at ${ESM_ENTRY}. Build ESM first.`);
console.log("[compat:edge] dist size:", statSync(ESM_ENTRY).size, "bytes (main)");

// Build a browser/edge-like sandbox. Deliberately no Node globals.
const edgeGlobal = {
  Keypair,
  StrKey,
  Networks,
  globalThis: undefined,
  TextEncoder,
  TextDecoder,
  crypto,
  // The flattened ESM smoke loader strips package imports; provide the
  // immutable constants used during SDK module initialization.
  fetch: () => {
    throw new Error("fetch should not be called during edge import smoke test");
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
  SharedArrayBuffer,
  Atomics,
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
  EvalError,
  ReferenceError,
  URIError,
  JSON,
  Math,
  Object,
  Reflect,
  Proxy,
  Array,
  String,
  Number,
  Boolean,
  Symbol,
  BigInt,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  Infinity,
  NaN,
  undefined,
  URLSearchParams,
  URL,
  Headers,
  Request,
  Response,
  FormData,
  Blob,
  File,
  ReadableStream,
  WritableStream,
  TransformStream,
  RegExp,
};

edgeGlobal.globalThis = edgeGlobal;
edgeGlobal.self = edgeGlobal;
edgeGlobal.window = undefined;
edgeGlobal.top = undefined;

// Negative / boundary: Node built-ins must remain unavailable in the sandbox.
assert.equal(
  Object.prototype.hasOwnProperty.call(edgeGlobal, "process"),
  false,
  "edge sandbox must not expose process",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(edgeGlobal, "Buffer"),
  false,
  "edge sandbox must not expose Buffer",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(edgeGlobal, "require"),
  false,
  "edge sandbox must not expose require",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(edgeGlobal, "__dirname"),
  false,
  "edge sandbox must not expose __dirname",
);

const ctx = vm.createContext(edgeGlobal, {
  codeGeneration: { strings: false, wasm: true },
});

// Confirm Node globals are not reachable from the sandbox context.
assert.equal(
  vm.runInContext("typeof process", ctx),
  "undefined",
  "process must be undefined inside edge sandbox",
);
assert.equal(
  vm.runInContext("typeof Buffer", ctx),
  "undefined",
  "Buffer must be undefined inside edge sandbox",
);
assert.equal(
  vm.runInContext("typeof require", ctx),
  "undefined",
  "require must be undefined inside edge sandbox",
);
console.log("[compat:edge] sandbox excludes Node built-ins (process/Buffer/require)");

// Since we can't easily use Node's real ESM loader into a separate
// context without SourceTextModule (unstable), we execute the
// concatenated ESM dist files as a script while shimming `export` semantics.
// This is imperfect for import semantics, but matches what bundlers do and
// catches any import-time Node API use that would break in Edge.
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full);
    // The CLI entry is built as a self-contained bundle and is not part of
    // the SDK export surface. Including it here duplicates every bundled
    // declaration when the remaining ESM modules are flattened below.
    else if (full.endsWith(".js") && !full.endsWith("/cli.js")) files.push(full);
  }
})(ESM_DIR);
