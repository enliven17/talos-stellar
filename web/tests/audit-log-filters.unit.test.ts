import { describe, it, expect } from "vitest";
import {
  escapeIlikePattern,
  parseAuditLogFilters,
  statusClassRange,
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

  it("rejects a malformed cursor", () => {
    expect(parseAuditLogFilters(new URLSearchParams({ cursor: "not-a-date" })).ok).toBe(false);
  });
});
