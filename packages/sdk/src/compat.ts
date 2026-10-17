/**
 * Supported-runtime compatibility matrix for the Talos Protocol SDK.
 *
 * This module declares which runtime environments the SDK supports, what
 * Web-standard APIs each runtime must expose, and provides a
 * {@link checkRuntimeCompatibility} function that probes the current
 * environment and returns a structured compatibility report.
 *
 * ## Design goals
 * - **No Node-only globals** — safe to import in edge, browser, and
 *   Cloudflare Workers environments.
 * - **Additive** — existing code that never calls these helpers is
 *   unaffected.
 * - **Deterministic** — the probe reads `globalThis` once per call;
 *   results are plain objects, easy to log or assert in tests.
 * - **Privacy-safe** — no request payloads, credentials, or secrets are
 *   ever read or returned.
 *
 * @module compat
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Identifier for a known runtime environment.
 * - `node`            Node.js ≥ 18 (native `fetch`, `AbortController`, `crypto`)
 * - `edge`            Vercel Edge / Next.js Middleware runtime
 * - `cloudflare`      Cloudflare Workers / Pages Functions
 * - `deno`            Deno ≥ 1.28
 * - `bun`             Bun ≥ 1.0
 * - `browser`         Standard browser (Chrome, Firefox, Safari, Edge)
 * - `unknown`         Could not be identified from global signatures
 */
export type SupportedRuntime =
  | "node"
  | "edge"
  | "cloudflare"
  | "deno"
  | "bun"
  | "browser"
  | "unknown";

/**
 * An API capability required by the SDK. The value is the dotted global path
 * probed via {@link probeGlobal} (e.g. `"fetch"`, `"crypto.subtle"`).
 */
export type RequiredCapability =
  | "fetch"
  | "AbortController"
  | "crypto"
  | "crypto.subtle"
  | "crypto.randomUUID"
  | "URL"
  | "Headers"
  | "TextEncoder"
  | "Promise"
  | "setTimeout";

/**
 * A single entry in the compatibility matrix. Describes what a runtime
 * supports and what the SDK requires from it.
 */
export interface RuntimeMatrixEntry {
  /** Human-readable display name. */
  name: string;
  /** Stable machine identifier. */
  runtime: SupportedRuntime;
  /** Whether this runtime is officially supported by the SDK. */
  supported: boolean;
  /**
   * Minimum version string at which full support begins. Informational only;
   * the SDK does not parse or enforce this at runtime.
   */
  minVersion: string;
  /** Web-platform capabilities this runtime must expose for the SDK to work. */
  requiredCapabilities: RequiredCapability[];
  /**
   * Optional notes about known gaps, polyfills, or configuration required.
   * Empty array means "works out of the box".
   */
  notes: string[];
}

/**
 * The result of probing the current runtime environment.
 */
export interface CompatibilityReport {
  /** Detected runtime identifier. */
  runtime: SupportedRuntime;
  /** Whether the detected runtime is in the supported matrix. */
  supported: boolean;
  /** Capabilities present in `globalThis`. */
  present: RequiredCapability[];
  /** Capabilities absent from `globalThis`. */
  missing: RequiredCapability[];
  /**
   * `true` when every required capability for the detected runtime is
   * present. Always `true` when no requirements are defined for the runtime
   * (e.g. `unknown`).
   */
  ok: boolean;
  /** Notes from the matrix entry, if any. */
  notes: string[];
}

// ── Matrix ────────────────────────────────────────────────────────────────────

/**
 * The full supported-runtime compatibility matrix.
 *
 * Each entry is immutable. Call {@link getRuntimeMatrix} to get a read-only
 * copy, or {@link getRuntimeEntry} to look up a specific runtime.
 */
const RUNTIME_MATRIX: readonly RuntimeMatrixEntry[] = Object.freeze([
  {
    name: "Node.js",
    runtime: "node" as SupportedRuntime,
    supported: true,
    minVersion: "18.0.0",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [
      "fetch and AbortController are available globally from Node 18.",
      "crypto.randomUUID is available from Node 19; polyfill with uuid if targeting Node 18.",
    ],
  },
  {
    name: "Vercel Edge / Next.js Middleware",
    runtime: "edge" as SupportedRuntime,
    supported: true,
    minVersion: "N/A",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [
      "All required Web APIs are available natively in the Edge runtime.",
      "Do not import Node built-ins (fs, net, process, Buffer) in edge-deployed code.",
    ],
  },
  {
    name: "Cloudflare Workers",
    runtime: "cloudflare" as SupportedRuntime,
    supported: true,
    minVersion: "N/A",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [
      "All required Web APIs are available natively in Cloudflare Workers.",
      "The Stellar SDK dependency may require a polyfill for Buffer; check compatibility.",
    ],
  },
  {
    name: "Deno",
    runtime: "deno" as SupportedRuntime,
    supported: true,
    minVersion: "1.28.0",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [
      "Run with --allow-net for outbound HTTP requests.",
      "Import the SDK via npm: prefix: import { TalosClient } from 'npm:@talos-protocol/sdk'.",
    ],
  },
  {
    name: "Bun",
    runtime: "bun" as SupportedRuntime,
    supported: true,
    minVersion: "1.0.0",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [],
  },
  {
    name: "Browser",
    runtime: "browser" as SupportedRuntime,
    supported: true,
    minVersion: "Chrome 89 / Firefox 90 / Safari 15",
    requiredCapabilities: [
      "fetch",
      "AbortController",
      "crypto",
      "crypto.subtle",
      "crypto.randomUUID",
      "URL",
      "Headers",
      "TextEncoder",
      "Promise",
      "setTimeout",
    ] as RequiredCapability[],
    notes: [
      "Use the pre-built browser bundle: dist/browser/sdk.bundle.js.",
      "crypto.randomUUID requires a secure context (HTTPS or localhost).",
      "CORS must be configured on the Talos API server for cross-origin requests.",
    ],
  },
]);

// ── Runtime detection ─────────────────────────────────────────────────────────

/**
 * Probe a dotted global path (e.g. `"crypto.subtle"`) against `globalThis`.
 * Returns `true` when the path resolves to a non-null, non-undefined value.
 * Never throws — always returns `false` on unexpected errors.
 */
export function probeGlobal(path: RequiredCapability): boolean {
  try {
    const parts = path.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let current: any = globalThis;
    for (const part of parts) {
      if (current == null || typeof current !== "object" && typeof current !== "function") {
        return false;
      }
      current = current[part];
    }
    return current != null;
  } catch {
    return false;
  }
}

/**
 * Identify the current runtime environment from `globalThis` signatures.
 * Returns `"unknown"` when no signature matches.
 *
 * Detection order matters: more specific runtimes are checked before more
 * generic ones (e.g. Deno before browser, Bun before Node).
 */
export function detectRuntime(): SupportedRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  // Deno — exposes `Deno` namespace.
  if (typeof g.Deno !== "undefined" && typeof g.Deno.version !== "undefined") {
    return "deno";
  }

  // Bun — exposes `Bun` namespace.
  if (typeof g.Bun !== "undefined" && typeof g.Bun.version !== "undefined") {
    return "bun";
  }

  // Cloudflare Workers — exposes `caches` and `CacheStorage` but NOT
  // `process` or `window`.
  if (
    typeof g.caches !== "undefined" &&
    typeof g.window === "undefined" &&
    typeof g.process === "undefined" &&
    typeof g.navigator !== "undefined" &&
    typeof g.navigator.userAgent === "string" &&
    g.navigator.userAgent.includes("Cloudflare-Workers")
  ) {
    return "cloudflare";
  }

  // Vercel Edge / Next.js Middleware — exposes `EdgeRuntime` global.
  if (typeof g.EdgeRuntime === "string") {
    return "edge";
  }

  // Node.js — exposes `process` with `versions.node`.
  if (
    typeof g.process !== "undefined" &&
    typeof g.process.versions !== "undefined" &&
    typeof g.process.versions.node === "string"
  ) {
    return "node";
  }

  // Browser — exposes `window` and `document`.
  if (typeof g.window !== "undefined" && typeof g.document !== "undefined") {
    return "browser";
  }

  return "unknown";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return a frozen copy of the full runtime compatibility matrix.
 * Safe to call at any time; does not probe `globalThis`.
 */
export function getRuntimeMatrix(): readonly RuntimeMatrixEntry[] {
  return RUNTIME_MATRIX;
}

/**
 * Return the matrix entry for a specific runtime identifier, or `undefined`
 * if the runtime is not in the matrix.
 */
export function getRuntimeEntry(
  runtime: SupportedRuntime,
): RuntimeMatrixEntry | undefined {
  return RUNTIME_MATRIX.find((e) => e.runtime === runtime);
}

/**
 * Probe the current runtime environment and return a {@link CompatibilityReport}.
 *
 * This function:
 * 1. Identifies the current runtime via {@link detectRuntime}.
 * 2. Looks up its requirements in the compatibility matrix.
 * 3. Probes each required capability against `globalThis`.
 * 4. Returns a structured report — never throws.
 *
 * The report is useful for:
 * - CI smoke tests that assert the SDK can run in a given environment.
 * - Operator startup checks that log missing capabilities before the first
 *   API call fails with a cryptic error.
 * - \`if (!report.ok) throw new Error(…)\` guards in SDK consumers.
 *
 * @example
 * ```ts
 * import { checkRuntimeCompatibility } from '@talos-protocol/sdk';
 *
 * const report = checkRuntimeCompatibility();
 * if (!report.ok) {
 *   console.error('Missing capabilities:', report.missing);
 * }
 * ```
 */
export function checkRuntimeCompatibility(): CompatibilityReport {
  const runtime = detectRuntime();
  const entry = getRuntimeEntry(runtime);

  const requiredCaps = entry?.requiredCapabilities ?? [];
  const present: RequiredCapability[] = [];
  const missing: RequiredCapability[] = [];

  for (const cap of requiredCaps) {
    if (probeGlobal(cap)) {
      present.push(cap);
    } else {
      missing.push(cap);
    }
  }

  return {
    runtime,
    supported: entry?.supported ?? false,
    present,
    missing,
    ok: missing.length === 0,
    notes: entry?.notes ?? [],
  };
}

/**
 * Assert that the current runtime is compatible with the SDK. Throws a
 * descriptive `Error` when any required capability is missing. Safe to call
 * at module initialisation.
 *
 * The error message lists only the missing capability names — no request
 * payloads, credentials, or sensitive data are ever included.
 *
 * @throws {Error} when `checkRuntimeCompatibility().ok` is `false`.
 */
export function assertRuntimeCompatibility(): void {
  const report = checkRuntimeCompatibility();
  if (!report.ok) {
    throw new Error(
      `[@talos-protocol/sdk] Unsupported runtime environment "${report.runtime}". ` +
        `Missing required capabilities: ${report.missing.join(", ")}. ` +
        `See the compatibility matrix for supported runtimes and polyfill options.`,
    );
  }
}
