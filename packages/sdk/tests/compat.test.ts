/**
 * Runtime compatibility matrix — focused test suite for #581
 *
 * Covers:
 *   - Matrix is complete and well-formed (all required fields present)
 *   - All supported runtimes are represented
 *   - probeGlobal works for present and absent capabilities
 *   - detectRuntime identifies the current Node environment correctly
 *   - checkRuntimeCompatibility returns a structured report
 *   - assertRuntimeCompatibility throws with a privacy-safe message
 *   - Boundary: unknown runtime, empty capabilities, nested paths
 *   - Regression: existing index.ts exports are unaffected
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getRuntimeMatrix,
  getRuntimeEntry,
  detectRuntime,
  probeGlobal,
  checkRuntimeCompatibility,
  assertRuntimeCompatibility,
} from "../src/compat.js";
import type {
  SupportedRuntime,
  RequiredCapability,
  RuntimeMatrixEntry,
  CompatibilityReport,
} from "../src/compat.js";

// ── Re-export surface check ───────────────────────────────────────────────────

import * as sdkIndex from "../src/index.js";

describe("Runtime compatibility matrix exports (#581)", () => {
  it("all compat exports are present on the public index", () => {
    expect(typeof sdkIndex.getRuntimeMatrix).toBe("function");
    expect(typeof sdkIndex.getRuntimeEntry).toBe("function");
    expect(typeof sdkIndex.detectRuntime).toBe("function");
    expect(typeof sdkIndex.probeGlobal).toBe("function");
    expect(typeof sdkIndex.checkRuntimeCompatibility).toBe("function");
    expect(typeof sdkIndex.assertRuntimeCompatibility).toBe("function");
  });
});

// ── getRuntimeMatrix ──────────────────────────────────────────────────────────

describe("getRuntimeMatrix()", () => {
  it("returns a non-empty readonly array", () => {
    const matrix = getRuntimeMatrix();
    expect(Array.isArray(matrix)).toBe(true);
    expect(matrix.length).toBeGreaterThan(0);
  });

  it("includes all expected runtime identifiers", () => {
    const runtimes = new Set(getRuntimeMatrix().map((e) => e.runtime));
    const expected: SupportedRuntime[] = ["node", "edge", "cloudflare", "deno", "bun", "browser"];
    for (const r of expected) {
      expect(runtimes.has(r)).toBe(true);
    }
  });

  it("every entry has required string fields", () => {
    for (const entry of getRuntimeMatrix()) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.runtime).toBe("string");
      expect(typeof entry.minVersion).toBe("string");
      expect(typeof entry.supported).toBe("boolean");
      expect(Array.isArray(entry.requiredCapabilities)).toBe(true);
      expect(Array.isArray(entry.notes)).toBe(true);
    }
  });

  it("every entry has at least one required capability", () => {
    for (const entry of getRuntimeMatrix()) {
      if (entry.supported) {
        expect(entry.requiredCapabilities.length).toBeGreaterThan(0);
      }
    }
  });

  it("matrix entries are distinct by runtime", () => {
    const matrix = getRuntimeMatrix();
    const runtimes = matrix.map((e) => e.runtime);
    const unique = new Set(runtimes);
    expect(unique.size).toBe(matrix.length);
  });

  it("matrix is frozen (immutable)", () => {
    const matrix = getRuntimeMatrix();
    expect(Object.isFrozen(matrix)).toBe(true);
  });
});

// ── getRuntimeEntry ───────────────────────────────────────────────────────────

describe("getRuntimeEntry()", () => {
  it("returns the node entry", () => {
    const entry = getRuntimeEntry("node");
    expect(entry).toBeDefined();
    expect(entry!.runtime).toBe("node");
    expect(entry!.supported).toBe(true);
  });

  it("returns the browser entry", () => {
    const entry = getRuntimeEntry("browser");
    expect(entry).toBeDefined();
    expect(entry!.runtime).toBe("browser");
  });

  it("returns undefined for unknown", () => {
    const entry = getRuntimeEntry("unknown");
    expect(entry).toBeUndefined();
  });

  it("node entry requires fetch capability", () => {
    const entry = getRuntimeEntry("node")!;
    expect(entry.requiredCapabilities).toContain("fetch");
  });

  it("all supported runtimes require AbortController", () => {
    for (const entry of getRuntimeMatrix()) {
      if (entry.supported) {
        expect(entry.requiredCapabilities).toContain("AbortController");
      }
    }
  });

  it("all supported runtimes require crypto", () => {
    for (const entry of getRuntimeMatrix()) {
      if (entry.supported) {
        expect(entry.requiredCapabilities).toContain("crypto");
      }
    }
  });
});

// ── probeGlobal ───────────────────────────────────────────────────────────────

describe("probeGlobal()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true for 'Promise' (always present)", () => {
    expect(probeGlobal("Promise")).toBe(true);
  });

  it("returns true for 'URL' (always present in Node 18+)", () => {
    expect(probeGlobal("URL")).toBe(true);
  });

  it("returns true for 'TextEncoder'", () => {
    expect(probeGlobal("TextEncoder")).toBe(true);
  });

  it("returns true for 'setTimeout'", () => {
    expect(probeGlobal("setTimeout")).toBe(true);
  });

  it("returns true for 'crypto' in Node 18+", () => {
    expect(probeGlobal("crypto")).toBe(true);
  });

  it("returns true for 'crypto.subtle' nested path", () => {
    expect(probeGlobal("crypto.subtle")).toBe(true);
  });

  it("returns false for an absent global", () => {
    // A capability that is definitely not present.
    expect(probeGlobal("__non_existent_global_xyz__" as RequiredCapability)).toBe(false);
  });

  it("returns false when intermediate path resolves to null", () => {
    vi.stubGlobal("crypto", null);
    expect(probeGlobal("crypto.subtle")).toBe(false);
  });

  it("returns false when intermediate path is a primitive (not traversable)", () => {
    vi.stubGlobal("crypto", 42);
    // 42["subtle"] is undefined, not traversable.
    expect(probeGlobal("crypto.subtle")).toBe(false);
  });

  it("never throws for any input", () => {
    // Throw-safety: even if globalThis access errors, probeGlobal must return false.
    expect(() => probeGlobal("__non_existent__" as RequiredCapability)).not.toThrow();
  });
});

// ── detectRuntime ─────────────────────────────────────────────────────────────

describe("detectRuntime()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects 'node' in the current test environment", () => {
    // Vitest runs in Node; process.versions.node is present.
    expect(detectRuntime()).toBe("node");
  });

  it("detects 'deno' when Deno namespace is present", () => {
    vi.stubGlobal("Deno", { version: { deno: "1.40.0" } });
    // Must also remove process so Node check doesn't win.
    vi.stubGlobal("process", undefined);
    expect(detectRuntime()).toBe("deno");
  });

  it("detects 'bun' when Bun namespace is present (and no Deno)", () => {
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("Bun", { version: "1.0.0" });
    vi.stubGlobal("process", undefined);
    expect(detectRuntime()).toBe("bun");
  });

  it("detects 'edge' when EdgeRuntime string is present", () => {
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("EdgeRuntime", "edge-runtime");
    vi.stubGlobal("process", undefined);
    expect(detectRuntime()).toBe("edge");
  });

  it("detects 'browser' when window and document are present", () => {
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("EdgeRuntime", undefined);
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(detectRuntime()).toBe("browser");
  });

  it("returns 'unknown' when no signature matches", () => {
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("EdgeRuntime", undefined);
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    expect(detectRuntime()).toBe("unknown");
  });
});

// ── checkRuntimeCompatibility ─────────────────────────────────────────────────

describe("checkRuntimeCompatibility()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a CompatibilityReport object", () => {
    const report = checkRuntimeCompatibility();
    expect(typeof report.runtime).toBe("string");
    expect(typeof report.supported).toBe("boolean");
    expect(Array.isArray(report.present)).toBe(true);
    expect(Array.isArray(report.missing)).toBe(true);
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.notes)).toBe(true);
  });

  it("reports runtime = 'node' in the test environment", () => {
    const report = checkRuntimeCompatibility();
    expect(report.runtime).toBe("node");
  });

  it("reports supported = true for node", () => {
    const report = checkRuntimeCompatibility();
    expect(report.supported).toBe(true);
  });

  it("ok is true when all capabilities are present (Node with fetch)", () => {
    // Node 18+ has everything; test should pass unless env is unusual.
    if (typeof globalThis.fetch === "function") {
      const report = checkRuntimeCompatibility();
      expect(report.ok).toBe(true);
      expect(report.missing).toHaveLength(0);
    }
  });

  it("present array contains capabilities that were found", () => {
    const report = checkRuntimeCompatibility();
    // Promise is always present.
    expect(report.present).toContain("Promise");
  });

  it("ok = false and missing is non-empty when a capability is absent (negative)", () => {
    // Temporarily remove fetch to simulate an old Node environment.
    vi.stubGlobal("fetch", undefined);
    const report = checkRuntimeCompatibility();
    expect(report.ok).toBe(false);
    expect(report.missing).toContain("fetch");
  });

  it("present + missing = requiredCapabilities for the detected runtime", () => {
    const report = checkRuntimeCompatibility();
    const entry = getRuntimeEntry(report.runtime);
    if (entry) {
      const allProbed = [...report.present, ...report.missing].sort();
      const required = [...entry.requiredCapabilities].sort();
      expect(allProbed).toEqual(required);
    }
  });

  it("returns supported=false and ok=true for unknown runtime (no requirements)", () => {
    vi.stubGlobal("Deno", undefined);
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("EdgeRuntime", undefined);
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    const report = checkRuntimeCompatibility();
    expect(report.runtime).toBe("unknown");
    expect(report.supported).toBe(false);
    // No requirements defined → missing is empty → ok = true.
    expect(report.ok).toBe(true);
    expect(report.missing).toHaveLength(0);
  });

  it("never throws, even with a mocked runtime", () => {
    vi.stubGlobal("Deno", { version: "1.0.0" });
    expect(() => checkRuntimeCompatibility()).not.toThrow();
  });
});

// ── assertRuntimeCompatibility ────────────────────────────────────────────────

describe("assertRuntimeCompatibility()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not throw in Node when all capabilities are present", () => {
    if (typeof globalThis.fetch === "function") {
      expect(() => assertRuntimeCompatibility()).not.toThrow();
    }
  });

  it("throws a descriptive Error when a required capability is missing (negative)", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => assertRuntimeCompatibility()).toThrow(Error);
  });

  it("error message contains the missing capability name (privacy-safe)", () => {
    vi.stubGlobal("fetch", undefined);
    let message = "";
    try {
      assertRuntimeCompatibility();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("fetch");
    expect(message).toContain("Missing required capabilities");
  });

  it("error message contains the runtime identifier", () => {
    vi.stubGlobal("fetch", undefined);
    let message = "";
    try {
      assertRuntimeCompatibility();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("node");
  });

  it("error message never contains credentials or secrets", () => {
    vi.stubGlobal("fetch", undefined);
    let message = "";
    try {
      assertRuntimeCompatibility();
    } catch (e) {
      message = (e as Error).message;
    }
    // Must not contain any secret-like content.
    expect(message).not.toMatch(/Bearer|apiKey|secret|token|password/i);
  });
});

// ── Regression: matrix does not break existing exports ────────────────────────

describe("Regression: existing SDK exports unaffected", () => {
  it("TalosClient is still exported", () => {
    expect(typeof sdkIndex.TalosClient).toBe("function");
  });

  it("TalosAPIError is still exported", () => {
    expect(typeof sdkIndex.TalosAPIError).toBe("function");
  });

  it("TalosTimeoutError is still exported", () => {
    expect(typeof sdkIndex.TalosTimeoutError).toBe("function");
  });

  it("generateIdempotencyKey is still exported", () => {
    expect(typeof sdkIndex.generateIdempotencyKey).toBe("function");
  });

  it("TalosEventStream is still exported", () => {
    expect(typeof sdkIndex.TalosEventStream).toBe("function");
  });
});

// ── Type-level tests (compile-time): ensure interfaces are well-typed ─────────

describe("Type structure tests", () => {
  it("RuntimeMatrixEntry type has all expected fields (structural check)", () => {
    const entry: RuntimeMatrixEntry = {
      name: "Test",
      runtime: "node",
      supported: true,
      minVersion: "18.0.0",
      requiredCapabilities: ["fetch", "Promise"],
      notes: [],
    };
    expect(entry.runtime).toBe("node");
  });

  it("CompatibilityReport type has all expected fields (structural check)", () => {
    const report: CompatibilityReport = {
      runtime: "node",
      supported: true,
      present: ["fetch"],
      missing: [],
      ok: true,
      notes: [],
    };
    expect(report.ok).toBe(true);
  });
});
