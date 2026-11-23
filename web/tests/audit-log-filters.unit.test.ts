import { describe, it, expect } from "vitest";
import {
  MAX_CURSOR_LEN,
  MAX_TALOS_ID_LEN,
  escapeIlikePattern,
  parseAuditLogFilters,
  statusClassRange,
  validateAuditLogFilters,
} from "@/lib/audit-log/filters";

describe("escapeIlikePattern", () => {
  it("escapes percent, underscore, and backslash", () => {
    expect(escapeIlikePattern(`a%b_c\\d`)).toBe(`a\\%b\\_c\\\\d`);
  });
});

describe("statusClassRange", () => {
  it("maps each class to an inclusive HTTP range", () => {
    expect(statusClassRange("2xx")).toEqual({ min: 200, max: 299 });
    expect(statusClassRange("4xx")).toEqual({ min: 400, max: 499 });
    expect(statusClassRange("5xx")).toEqual({ min: 500, max: 599 });
  });
});

describe("parseAuditLogFilters", () => {
  it("accepts a full positive filter set", () => {
    const params = new URLSearchParams({
      talosId: "tal_abc",
      method: "get",
      q: "/api/talos",
      statusClass: "4xx",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-02T00:00:00.000Z",
      limit: "10",
    });
    const result = parseAuditLogFilters(params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.method).toBe("GET");
    expect(result.filters.statusClass).toBe("4xx");
    expect(result.filters.q).toBe("/api/talos");
    expect(result.filters.limit).toBe(10);
  });

  it("rejects an invalid HTTP method", () => {
    const result = parseAuditLogFilters(new URLSearchParams({ method: "TRACE" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid method/);
  });

  it("rejects statusCode + statusClass together", () => {
    const result = parseAuditLogFilters(
      new URLSearchParams({ statusCode: "403", statusClass: "4xx" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed statusCode", () => {
    expect(parseAuditLogFilters(new URLSearchParams({ statusCode: "99" })).ok).toBe(false);
    expect(parseAuditLogFilters(new URLSearchParams({ statusCode: "abc" })).ok).toBe(false);
  });

  it("rejects from > to (boundary)", () => {
    const result = parseAuditLogFilters(
      new URLSearchParams({
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects empty q and oversized q", () => {
    expect(parseAuditLogFilters(new URLSearchParams({ q: "   " })).ok).toBe(false);
    expect(parseAuditLogFilters(new URLSearchParams({ q: "x".repeat(201) })).ok).toBe(false);
  });

  it("clamps limit and rejects zero / non-integer", () => {
    const clamped = parseAuditLogFilters(new URLSearchParams({ limit: "9999" }));
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(clamped.filters.limit).toBe(200);

    expect(parseAuditLogFilters(new URLSearchParams({ limit: "0" })).ok).toBe(false);
    expect(parseAuditLogFilters(new URLSearchParams({ limit: "1.5" })).ok).toBe(false);
  });

  it("rejects a malformed or oversized cursor", () => {
    expect(parseAuditLogFilters(new URLSearchParams({ cursor: "not-a-date" })).ok).toBe(false);
    const oversized = parseAuditLogFilters(
      new URLSearchParams({ cursor: "2026-01-01T00:00:00.000Z".padEnd(MAX_CURSOR_LEN + 1, "0") }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error).toBe(`cursor must be at most ${MAX_CURSOR_LEN} characters`);
    }
  });
});

describe("validateAuditLogFilters", () => {
  it("validates actor, action, and cursor bounds directly", () => {
    expect(validateAuditLogFilters({ talosId: "a".repeat(MAX_TALOS_ID_LEN) }).ok).toBe(true);
    expect(validateAuditLogFilters({ talosId: "a".repeat(MAX_TALOS_ID_LEN + 1) }).ok).toBe(false);
    expect(validateAuditLogFilters({ method: "POST" }).ok).toBe(true);
    expect(validateAuditLogFilters({ method: "INVALID" as never }).ok).toBe(false);
    expect(validateAuditLogFilters({ cursor: "2026-01-01T00:00:00.000Z" }).ok).toBe(true);
    expect(validateAuditLogFilters({ cursor: "x".repeat(MAX_CURSOR_LEN + 1) }).ok).toBe(false);
  });
});
