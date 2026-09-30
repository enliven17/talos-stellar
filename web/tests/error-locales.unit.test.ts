/**
 * Focused coverage for localization scaffolding of user-facing errors.
 *
 * Local command (run from repo root):
 *   pnpm --dir web exec vitest run tests/error-locales.unit.test.ts
 *
 * Fail-closed contract: every ambiguous locale input resolves to English;
 * secrets are never echoed, logged, or interpolated.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  ERROR_STRINGS,
  getErrorBoundaryCopy,
  getErrorStrings,
  isSupportedLocale,
  resolveLocale,
  resolveLocaleFromAcceptLanguage,
} from "../src/lib/error-locales";
import {
  emptyCopyFor,
  toPrivacySafeAgentError,
} from "../src/lib/agent-view-errors";
import fixture from "./fixtures/error-locales.fixture.json";

// ─── Positive ────────────────────────────────────────────────────────────────

describe("resolveLocale (positive)", () => {
  it("resolves supported tags, case-insensitively with region subtags", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
    expect(resolveLocale(" en ")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("en_US")).toBe("en");
  });

  it("picks the first supported tag from Accept-Language", () => {
    expect(resolveLocaleFromAcceptLanguage("en-US, en;q=0.9")).toBe("en");
    expect(resolveLocaleFromAcceptLanguage("fr, en;q=0.9")).toBe("en");
  });

  it("exposes the English dictionary through the current interface", () => {
    expect(getErrorStrings("en").fallback).toBe(fixture.fallback);
    expect(emptyCopyFor("catalog", "en").title).toBe(
      fixture.empty.catalog.title,
    );
    expect(getErrorBoundaryCopy("en").title).toBe(fixture.boundary.title);
  });

  it("passes safe messages through with an explicit locale", () => {
    expect(toPrivacySafeAgentError("Connection timed out", undefined, "en")).toBe(
      "Connection timed out",
    );
  });
});

// ─── Negative (unsupported / secret-bearing input) ───────────────────────────

describe("locale resolution (negative)", () => {
  it("fails closed to English for unsupported locales", () => {
    for (const unsupported of ["fr", "de", "es", "ja", "xx"]) {
      expect(resolveLocale(unsupported)).toBe(DEFAULT_LOCALE);
      expect(getErrorStrings(unsupported).fallback).toBe(fixture.fallback);
      expect(isSupportedLocale(unsupported)).toBe(false);
    }
    expect(resolveLocaleFromAcceptLanguage("fr, de;q=0.9")).toBe("en");
  });

  it("never echoes secret-bearing locale input", () => {
    const hostile = "api_key=ghp_supersecretvalue";
    expect(resolveLocale(hostile)).toBe("en");
    expect(getErrorStrings(hostile).fallback).toBe(fixture.fallback);
    expect(getErrorStrings(hostile).fallback).not.toContain("supersecret");
  });

  it("keeps privacy redaction active when a locale is supplied", () => {
    expect(
      toPrivacySafeAgentError("api_key=ghp_secretvaluehere", undefined, "en"),
    ).toBe(fixture.fallback);
    expect(
      toPrivacySafeAgentError("seed phrase: abandon abandon", undefined, "fr"),
    ).toBe(fixture.fallback);
  });
});

// ─── Boundary (missing / malformed / overlong) ───────────────────────────────

describe("locale resolution (boundary)", () => {
  it("fails closed on missing input", () => {
    for (const missing of [undefined, null, "", "   "]) {
      expect(resolveLocale(missing)).toBe("en");
      expect(resolveLocaleFromAcceptLanguage(missing)).toBe("en");
    }
    expect(getErrorStrings().fallback).toBe(fixture.fallback);
  });

  it("fails closed on malformed input types", () => {
    for (const malformed of [123, true, {}, [], 0, NaN]) {
      expect(resolveLocale(malformed)).toBe("en");
      expect(resolveLocaleFromAcceptLanguage(malformed)).toBe("en");
    }
  });

  it("fails closed on overlong or injection-style input", () => {
    expect(resolveLocale("e".repeat(100))).toBe("en");
    expect(resolveLocale("en; DROP TABLE")).toBe("en");
    expect(resolveLocale("en\nsecret")).toBe("en");
    expect(resolveLocaleFromAcceptLanguage("x".repeat(2000))).toBe("en");
    expect(resolveLocaleFromAcceptLanguage(",,,")).toBe("en");
  });

  it("falls back to generic copy for unknown empty kinds", () => {
    expect(
      emptyCopyFor("not-a-kind" as never, "en").title,
    ).toBe(fixture.empty.generic.title);
    expect(emptyCopyFor("catalog", "fr").title).toBe(
      fixture.empty.catalog.title,
    );
  });
});

// ─── Regression (no parallel source of truth, existing callers unchanged) ────

describe("localization scaffolding (regression)", () => {
  it("dictionary matches the checked-in fixture (fail closed on drift)", () => {
    expect(ERROR_STRINGS.en).toEqual(fixture);
  });

  it("existing two-arg callers still receive identical English copy", () => {
    expect(toPrivacySafeAgentError(null)).toBe(fixture.fallback);
    expect(toPrivacySafeAgentError(undefined)).toBe(fixture.fallback);
    expect(toPrivacySafeAgentError(new Error("boom"), "safe")).toBe("boom");
    expect(emptyCopyFor("catalog").title).toBe(fixture.empty.catalog.title);
    expect(emptyCopyFor("filtered").description).toBe(
      fixture.empty.filtered.description,
    );
  });

  it("resolvers are pure and retry-safe (no throw, no logging of input)", () => {
    expect(() => resolveLocale("fr")).not.toThrow();
    expect(() => resolveLocaleFromAcceptLanguage(null)).not.toThrow();
    expect(() => getErrorStrings("fr")).not.toThrow();
    // Repeated calls are stable — safe to retry.
    expect(resolveLocale("fr")).toBe(resolveLocale("fr"));
  });
});
