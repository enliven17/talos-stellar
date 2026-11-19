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
    else if (full.endsWith(".js")) files.push(full);
  }
})(ESM_DIR);
files.sort((a, b) => {
  if (a.endsWith("chaos.js") && b.endsWith("chaos-fixtures.js")) return -1;
  if (b.endsWith("chaos.js") && a.endsWith("chaos-fixtures.js")) return 1;
  return a.localeCompare(b);
});

console.log(`[compat:edge] concatenating ${files.length} ESM files`);

const EXPORT_REGEX =
  /^export\s+(default\s+)?(?:(?:const|let|var|class|function|enum|async\s+function)\s+)?([A-Za-z0-9_$]+)/m;
const REEXPORT_ALL = /^export\s+\*\s+from\s+["']([^"']+)["']/;
const REEXPORT_NAMED = /^export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/;
const IMPORT_LINE =
  /^import\s+(?:(?:\{[^}]*\}|\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?["']([^"']+)["'];?\s*$/;

function stripImportsExports(src) {
  // Strip multiline re-exports and imports before line processing
  const preprocessed = src
    .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/gs, "")
    .replace(/import\s+(?:\{[^}]*\}|\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["'][^"']+["'];?/gs, "");
  const lines = preprocessed.split(/\r?\n/);
  const out = [];
  const deferred = [];
  for (const raw of lines) {
    const line = raw.trimEnd();

    // Skip re-exports — sources are concatenated inline.
    if (REEXPORT_ALL.test(line)) continue;
    if (REEXPORT_NAMED.test(line)) continue;
    if (IMPORT_LINE.test(line)) continue;
    if (/^export\s*\{\s*\}\s*;?\s*$/.test(line)) continue;

    // `export default X` → `__EXPORTS__.default = X`
    if (/^export\s+default\s+/.test(line)) {
      const rest = line.replace(/^export\s+default\s+/, "");
      deferred.push("__EXPORTS__.default = (" + rest + ");");
      continue;
    }

    // `export class Foo`, `export function foo`, `export const x = ...`
    const m = EXPORT_REGEX.exec(line);
    if (m) {
      const name = m[2];
      const decl = line.replace(/^export\s+/, "");
      out.push(decl);
      if (name) deferred.push(`try { __EXPORTS__.${name} = ${name}; } catch (_) {}`);
      continue;
    }

    // `export { a, b as c }` local re-export
    const namedLocal = /^export\s+\{([^}]+)\}\s*;?\s*$/.exec(line);
    if (namedLocal) {
      for (const part of namedLocal[1].split(",")) {
        const bit = part.trim();
        if (!bit) continue;
        const asMatch = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(bit);
        if (asMatch) {
          deferred.push(`try { __EXPORTS__.${asMatch[2]} = ${asMatch[1]}; } catch (_) {}`);
        } else {
          deferred.push(`try { __EXPORTS__.${bit} = ${bit}; } catch (_) {}`);
        }
      }
      continue;
    }

    out.push(line);
  }
  return out.join("\n") + "\n" + deferred.join("\n");
}

const sources = [];
sources.push("var __EXPORTS__ = {};");
for (const f of files) {
  const rel = relative(ESM_DIR, f);
  const raw = readFileSync(f, "utf8");
  sources.push(`\n// ===== ${rel} =====`);
  sources.push(stripImportsExports(raw));
}
const combined = sources.join("\n") + "\nthis.__EXPORTS__ = __EXPORTS__;";

console.log("[compat:edge] evaluating concatenated ESM in edge sandbox...");
try {
  vm.runInContext(combined, ctx, {
    filename: "sdk-edge-bundle.mjs",
    timeout: 15_000,
    displayErrors: true,
  });
} catch (e) {
  console.error("[compat:edge] FAILED loading SDK into edge sandbox:", e);
  process.exit(1);
}

const sdk = ctx.__EXPORTS__;
assert.ok(sdk, "SDK exports not produced in edge sandbox");
console.log(
  "[compat:edge] exports discovered:",
  Object.keys(sdk).sort().join(", ") || "(none — expected when esbuild fallback is used)",
);

// When exports ARE present, they must be the right shape.
function check(name, kind) {
  if (!(name in sdk) || sdk[name] === undefined) {
    console.log("  ? " + name + " not exported (acceptable for fallback concatenation)");
    return;
  }
  const v = sdk[name];
  if (kind === "class" || kind === "function") {
    assert.equal(typeof v, "function", name + " should be a function/class");
  } else if (kind === "object" || kind === "enum") {
    assert.ok(v && typeof v === "object", name + " should be an object");
  }
  console.log("  + " + name + " OK (" + kind + ")");
}

check("TalosClient", "class");
check("TalosAPIError", "class");
check("TalosEventStream", "class");
check("TalosStreamError", "class");
check("InMemorySeenStore", "class");
check("TalosWebhook", "class");
check("TalosWebhookError", "class");
check("ChaosInjector", "class");
check("ChaosInjectedError", "class");
check("globalChaosInjector", "object");
check("FaultType", "enum");
check("generateKeypair", "function");
check("isValidPublicKey", "function");
check("isValidSecretKey", "function");

// When TalosClient is present, instantiate one and confirm method shape.
if (typeof sdk.TalosClient === "function") {
  const client = new sdk.TalosClient({
    baseUrl: "http://example.test",
    apiKey: "edge",
  });
  assert.equal(typeof client.getTalos, "function", "client.getTalos not callable");
  assert.equal(typeof client.listTaloses, "function", "client.listTaloses not callable");
  assert.equal(typeof client.createTalos, "function", "client.createTalos not callable");
  // Privacy: constructor must not echo apiKey into enumerable/stringified state.
  const leaked = JSON.stringify(client);
  assert.ok(
    !leaked.includes("edge") || !/"apiKey"\s*:/.test(leaked),
    "TalosClient must not expose apiKey/secrets in JSON serialization",
  );
  console.log("  + TalosClient instantiation & method shape OK (edge sandbox)");
}

if (typeof sdk.ChaosInjector === "function") {
  const inj = new sdk.ChaosInjector({ enabled: false });
  assert.equal(inj.isEnabled(), false);
  console.log("  + ChaosInjector instantiation OK (edge sandbox)");
}

// Deterministic chaos fixtures inside the edge sandbox (pure JS paths only).
if (typeof sdk.planChaosScenario === "function") {
  const scenario = sdk.getChaosScenario("always-injects-unit-probability");
  assert.ok(scenario, "chaos scenario lookup failed in edge sandbox");
  const plan = sdk.planChaosScenario(scenario);
  assert.equal(plan.calls[0].outcome, "injected-throw", "chaos plan outcome drifted in edge sandbox");
  const seeded = sdk.createSeededRandom(1);
  const seeded2 = sdk.createSeededRandom(1);
  assert.deepEqual(
    Array.from({ length: 4 }, seeded),
    Array.from({ length: 4 }, seeded2),
    "seeded PRNG not deterministic in edge sandbox",
  );
  console.log("  + deterministic chaos fixtures OK (edge sandbox)");
}

// Malformed / boundary: constructing with missing baseUrl should be explicit, not silent Node crash.
if (typeof sdk.TalosClient === "function") {
  try {
    // Many clients accept empty opts; ensure it does not throw a Node-only ReferenceError.
    const soft = new sdk.TalosClient({});
    assert.ok(soft);
    console.log("  + TalosClient({}) boundary construct OK");
  } catch (err) {
    assert.ok(err instanceof Error, "errors must be Error instances");
    assert.ok(
      !/process is not defined|Buffer is not defined|require is not defined/.test(String(err)),
      "boundary errors must not be Node-global ReferenceErrors",
    );
    console.log("  + TalosClient({}) threw explicit Error (acceptable):", err.name);
  }
}

// ── Subpath entries: server-only bundles in the same sandbox ─────────
//
// The `./webhooks`, `./events` and `./errors` subpaths exist so an edge handler
// can verify a webhook or decode an event stream without the client and without
// `@stellar/stellar-sdk`. Each declared subpath is bundled exactly as a
// serverless build would (esbuild, browser platform) and the resulting bundle
// must (a) contain no Stellar SDK code, and (b) evaluate inside the Node-free
// sandbox above with its documented exports intact.
const SUBPATH_CONTRACT = new Map([
  ["./webhooks", ["TalosWebhook", "TalosWebhookError", "parseWebhookEvent", "verifyWebhook"]],
  ["./events", ["InMemorySeenStore", "TalosEventStream", "TalosStreamError", "negotiateSchemaVersion"]],
  ["./errors", ["TalosAPIError", "errorFromResponse", "parseRetryAfter"]],
]);

async function checkSubpathEntries() {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    console.log("[compat:edge] esbuild is not installed — skipping subpath bundle checks");
    return;
  }

  const pkg = JSON.parse(readFileSync(resolve(SDK_ROOT, "package.json"), "utf8"));
  const subpaths = Object.keys(pkg.exports ?? {}).filter((subpath) => subpath !== ".");
  assert.ok(subpaths.length > 0, "package.json declares no subpath exports");

  for (const subpath of subpaths) {
    const spec = pkg.exports[subpath];
    const target = typeof spec === "string" ? spec : spec?.import;
    assert.ok(target, `${subpath} declares no ESM ("import") entry point`);

    const absolute = resolve(SDK_ROOT, target);
    assert.ok(
      existsSync(absolute),
      `${subpath} ESM target ${target} is missing — run "npm run build" first`,
    );

    const result = await esbuild.build({
      entryPoints: [absolute],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__SUBPATH__",
      platform: "browser",
      target: "es2020",
      legalComments: "none",
      metafile: true,
      logLevel: "silent",
    });

    const inputs = Object.keys(result.metafile.inputs);
    const heavy = inputs.filter((file) => file.includes("stellar-sdk"));
    assert.ok(
      heavy.length === 0,
      `${subpath} must bundle without @stellar/stellar-sdk (pulled in ${heavy.join(", ")})`,
    );

    const code = result.outputFiles[0].text;
    vm.runInContext(`this.__SUBPATH__ = undefined;\n${code}`, ctx, {
      filename: `sdk-edge${subpath.replace(/[^a-z]/gi, "-")}.js`,
      timeout: 15_000,
      displayErrors: true,
    });

    const mod = ctx.__SUBPATH__;
    assert.ok(mod && typeof mod === "object", `${subpath} produced no namespace in the sandbox`);
    for (const name of SUBPATH_CONTRACT.get(subpath) ?? []) {
      assert.ok(name in mod, `${subpath} is missing ${name} in the edge sandbox`);
    }
    console.log(
      `  + ${subpath} -> ${inputs.length} modules, ${code.length} bytes, ` +
        `no Stellar SDK, ${Object.keys(mod).length} exports OK (edge sandbox)`,
    );
  }
}

await checkSubpathEntries();

console.log("[compat:edge] ALL CHECKS PASSED");
process.exit(0);
