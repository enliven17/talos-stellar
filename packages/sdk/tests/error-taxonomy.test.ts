/**
 * Stable SDK error-code taxonomy with versioned fixtures — focused suite for #1407.
 *
 * Covers:
 *   - classifyError maps transport, validation, quota and payment failures
 *     consistently (and every other code) — behavior + versioned fixture.
 *   - codeToCategory canonical mapping, including the unknown-code fallback.
 *   - toErrorContract produces a stable, JSON-serializable, redacted contract.
 *   - buildCauseChain: redaction of secrets, depth/cycle bounding, no-cause.
 *   - Versioned-fixture drift: tests/fixtures/error-taxonomy.json version matches
 *     ERROR_TAXONOMY_VERSION and its cases match the runtime case table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TalosAPIError,
  TalosValidationError,
  TalosAuthenticationError,
  TalosForbiddenError,
  TalosNotFoundError,
  TalosConflictError,
  TalosPaymentError,
  TalosRateLimitError,
  TalosServerError,
  TalosServerRetryableError,
  TalosTransportError,
  TalosTimeoutError,
  classifyError,
  codeToCategory,
  toErrorContract,
  buildCauseChain,
  ERROR_TAXONOMY_VERSION,
} from "../src/index.js";
import type {
  ErrorClassification,
  TalosErrorCategory,
  TalosErrorCode,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const TAXONOMY_FIXTURE = resolve(here, "fixtures", "error-taxonomy.json");

// ── Runtime case table (mirrors the committed fixture) ────────────────────────

interface TaxonomyCase {
  name: string;
  factory: () => unknown;
  expected: ErrorClassification;
}

const TAXONOMY_CASES: readonly TaxonomyCase[] = [
  {
    name: "validation_error",
    factory: () => new TalosValidationError(400, '{"issues":["bad"]}', "/api/x", ["bad"]),
    expected: { code: "validation_error", category: "validation", retryable: false },
  },
  {
    name: "authentication_error",
    factory: () => new TalosAuthenticationError(401, "nope", "/api/x"),
    expected: { code: "authentication_error", category: "authentication", retryable: false },
  },
  {
    name: "forbidden",
    factory: () => new TalosForbiddenError(403, "nope", "/api/x"),
    expected: { code: "forbidden", category: "authorization", retryable: false },
  },
  {
    name: "not_found_error",
    factory: () => new TalosNotFoundError(404, "missing", "/api/x"),
    expected: { code: "not_found_error", category: "not_found", retryable: false },
  },
  {
    name: "conflict_error",
    factory: () => new TalosConflictError(409, "dup", "/api/x"),
    expected: { code: "conflict_error", category: "conflict", retryable: false },
  },
  {
    name: "payment_error",
    factory: () => new TalosPaymentError(402, "pay required", "/api/x"),
    expected: { code: "payment_error", category: "payment", retryable: false },
  },
  {
    name: "rate_limit_error",
    factory: () =>
      new TalosRateLimitError(429, "slow down", "/api/x", {
        headers: {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1700000000",
        },
      }),
    expected: { code: "rate_limit_error", category: "quota", retryable: true },
  },
  {
    name: "server_error",
    factory: () => new TalosServerError(500, "boom", "/api/x"),
    expected: { code: "server_error", category: "server", retryable: false },
  },
  {
    name: "server_retryable",
    factory: () => new TalosServerRetryableError(503, "boom", "/api/x"),
    expected: { code: "server_error", category: "server", retryable: true },
  },
  {
    name: "transport_error",
    factory: () =>
      new TalosTransportError(0, "ECONNREFUSED", "/api/x", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
      }),
    expected: { code: "transport_error", category: "transport", retryable: true },
  },
  {
    name: "timeout_error",
    factory: () => new TalosTimeoutError(0, "timed out", "/api/x"),
    expected: { code: "timeout_error", category: "timeout", retryable: true },
  },
  {
    name: "api_error_generic",
    factory: () => new TalosAPIError(418, "teapot", "/api/x"),
    expected: { code: "api_error", category: "api", retryable: false },
  },
  {
    name: "generic_error",
    factory: () => new Error("boom"),
    expected: { code: "api_error", category: "api", retryable: false },
  },
  {
    name: "abort_error",
    factory: () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      return e;
    },
    expected: { code: "timeout_error", category: "timeout", retryable: true },
  },
];

// ── classifyError: consistent taxonomy mapping ────────────────────────────────

describe("classifyError (#1407)", () => {
  it("maps every taxonomy case to its stable (code, category, retryable)", () => {
    for (const c of TAXONOMY_CASES) {
      const got = classifyError(c.factory());
      expect(got).toEqual(c.expected);
    }
  });

  it("maps transport, validation, quota and payment failures consistently", () => {
    expect(classifyError(new TalosTransportError(0, "x", "/p"))).toEqual({
      code: "transport_error",
      category: "transport",
      retryable: true,
    });
    expect(classifyError(new TalosValidationError(400, "x", "/p", []))).toEqual({
      code: "validation_error",
      category: "validation",
      retryable: false,
    });
    expect(classifyError(new TalosRateLimitError(429, "x", "/p"))).toEqual({
      code: "rate_limit_error",
      category: "quota",
      retryable: true,
    });
    expect(classifyError(new TalosPaymentError(402, "x", "/p"))).toEqual({
      code: "payment_error",
      category: "payment",
      retryable: false,
    });
  });

  it("classifies a non-SDK abort error as a timeout (consistent with transport heuristic)", () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    expect(classifyError(e)).toEqual({
      code: "timeout_error",
      category: "timeout",
      retryable: true,
    });
  });

  it("falls back to the generic api bucket for unknown errors", () => {
    expect(classifyError(new Error("boom"))).toEqual({
      code: "api_error",
      category: "api",
      retryable: false,
    });
    expect(classifyError(null)).toEqual({
      code: "api_error",
      category: "api",
      retryable: false,
    });
  });
});

// ── codeToCategory ─────────────────────────────────────────────────────────────

describe("codeToCategory (#1407)", () => {
  it("maps each stable code to its coarse category", () => {
    const expected: Record<TalosErrorCode, TalosErrorCategory> = {
      validation_error: "validation",
      authentication_error: "authentication",
      forbidden: "authorization",
      not_found_error: "not_found",
      conflict_error: "conflict",
      payment_error: "payment",
      rate_limit_error: "quota",
      server_error: "server",
      transport_error: "transport",
      timeout_error: "timeout",
      api_error: "api",
    };
    for (const [code, category] of Object.entries(expected)) {
      expect(codeToCategory(code as TalosErrorCode)).toBe(category);
    }
  });

  it("falls back to 'api' for an unknown code", () => {
    expect(codeToCategory("not_a_real_code" as TalosErrorCode)).toBe("api");
  });
});

// ── toErrorContract ───────────────────────────────────────────────────────────

describe("toErrorContract (#1407)", () => {
  it("produces a stable, JSON-serializable contract for a typed error", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const err = new TalosTransportError(0, "ECONNREFUSED", "/api/x", {
      cause,
      requestId: "req-1",
    });
    const contract = toErrorContract(err);

    expect(contract.name).toBe("TalosTransportError");
    expect(contract.code).toBe("transport_error");
    expect(contract.category).toBe("transport");
    expect(contract.status).toBe(0);
    expect(contract.retryable).toBe(true);
    expect(contract.taxonomyVersion).toBe(ERROR_TAXONOMY_VERSION);
    expect(contract.causeChain).toEqual([
      { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:443" },
    ]);

    // Round-trips through JSON (Node + browser portability).
    const roundTripped = JSON.parse(JSON.stringify(contract));
    expect(roundTripped.code).toBe("transport_error");
    expect(roundTripped.category).toBe("transport");
    expect(roundTripped.causeChain[0].message).toBe(
      "connect ECONNREFUSED 127.0.0.1:443",
    );
  });

  it("redacts secrets in the cause chain", () => {
    const cause = new Error(
      "Authorization: Bearer abc.def-ghi_sk123 and key sk-abcdef123456",
    );
    const err = new TalosTransportError(0, "x", "/api/x", { cause });
    const chain = toErrorContract(err).causeChain;
    expect(chain).toBeDefined();
    const msg = chain![0].message;
    expect(msg).toContain("[REDACTED]");
    expect(msg).not.toContain("abc.def-ghi_sk123");
    expect(msg).not.toContain("sk-abcdef123456");
  });

  it("omits SDK-specific fields and causeChain for a plain generic error", () => {
    const contract = toErrorContract(new Error("boom"));
    expect(contract.name).toBe("Error");
    expect(contract.code).toBe("api_error");
    expect(contract.category).toBe("api");
    expect(contract.status).toBe(0);
    expect(contract.retryable).toBe(false);
    expect(contract.taxonomyVersion).toBe(ERROR_TAXONOMY_VERSION);
    expect(contract.causeChain).toBeUndefined();
    expect(contract.requestId).toBeUndefined();
    expect(contract.path).toBeUndefined();
    // JSON-serializable with no extra fields leaking.
    expect(() => JSON.stringify(contract)).not.toThrow();
  });
});

// ── buildCauseChain ───────────────────────────────────────────────────────────

describe("buildCauseChain (#1407)", () => {
  it("returns undefined when the error has no cause", () => {
    expect(buildCauseChain(new Error("x"))).toBeUndefined();
  });

  it("walks a multi-level cause chain", () => {
    const root = new Error("root");
    const mid = new Error("mid");
    mid.cause = root;
    const top = new Error("top");
    top.cause = mid;
    const chain = buildCauseChain(top);
    expect(chain).toEqual([
      { name: "Error", message: "mid" },
      { name: "Error", message: "root" },
    ]);
  });

  it("bounds a cyclic cause chain (never loops forever)", () => {
    const a = new Error("a");
    const b = new Error("b");
    a.cause = b;
    b.cause = a; // cycle
    const chain = buildCauseChain(a);
    expect(chain).toBeDefined();
    expect(chain!.length).toBeLessThanOrEqual(8);
    expect(chain!.length).toBeGreaterThanOrEqual(2);
    for (const frame of chain!) {
      expect(frame.name).toBe("Error");
    }
  });

  it("records a typed code frame when the cause is a Talos error", () => {
    const inner = new TalosTimeoutError(0, "timed out", "/api/x");
    const outer = new TalosTransportError(0, "wrap", "/api/x", { cause: inner });
    const chain = buildCauseChain(outer);
    expect(chain).toEqual([{ name: "TalosTimeoutError", message: "timed out", code: "timeout_error" }]);
  });
});

// ── Versioned-fixture drift ────────────────────────────────────────────────────

describe("versioned error-taxonomy fixture drift (#1407)", () => {
  it("tests/fixtures/error-taxonomy.json version matches ERROR_TAXONOMY_VERSION", () => {
    const committed = JSON.parse(readFileSync(TAXONOMY_FIXTURE, "utf8"));
    expect(committed.version).toBe(ERROR_TAXONOMY_VERSION);
  });

  it("committed fixture cases match the runtime case table", () => {
    const committed = JSON.parse(readFileSync(TAXONOMY_FIXTURE, "utf8"));
    const runtimeCases = TAXONOMY_CASES.map((c) => ({
      name: c.name,
      expected: c.expected,
    }));
    expect(committed.cases).toEqual(runtimeCases);
  });

  it("every committed case classifies as expected at runtime", () => {
    const committed = JSON.parse(readFileSync(TAXONOMY_FIXTURE, "utf8"));
    for (const c of committed.cases) {
      const tc = TAXONOMY_CASES.find((x) => x.name === c.name);
      expect(tc).toBeDefined();
      expect(classifyError(tc!.factory())).toEqual(c.expected);
    }
  });
});
