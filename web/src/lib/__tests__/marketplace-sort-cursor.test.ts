import { describe, it, expect } from "vitest";
import {
  encodeRankedCursor,
  decodeRankedCursor,
  hashFilters,
  isCursorCompatible,
  type RankedMarketplaceCursor,
} from "@/lib/marketplace-sort";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CURSOR: RankedMarketplaceCursor = {
  sortField: "createdAt",
  sortDirection: "desc",
  filterHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  createdAt: "2025-06-01T12:00:00.000Z",
  id: "svc_001",
};

// ─── encodeRankedCursor / decodeRankedCursor ──────────────────────────────────

describe("encodeRankedCursor / decodeRankedCursor", () => {
  it("roundtrips a valid cursor", () => {
    const encoded = encodeRankedCursor(BASE_CURSOR);
    const decoded = decodeRankedCursor(encoded);
    expect(decoded).toEqual(BASE_CURSOR);
  });

  it("produces a URL-safe base64url string (no +, /, or =)", () => {
    const encoded = encodeRankedCursor(BASE_CURSOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("roundtrips a cursor with asc direction", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      sortDirection: "asc",
      sortField: "price",
      createdAt: "5.000000",
    };
    expect(decodeRankedCursor(encodeRankedCursor(cursor))).toEqual(cursor);
  });

  it("normalises the createdAt to ISO-8601", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      createdAt: "2025-06-01T12:00:00.000Z",
    };
    const decoded = decodeRankedCursor(encodeRankedCursor(cursor));
    expect(decoded?.createdAt).toBe("2025-06-01T12:00:00.000Z");
  });
});

describe("decodeRankedCursor — invalid inputs", () => {
  it("returns null for a plain string", () => {
    expect(decodeRankedCursor("not_a_cursor")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeRankedCursor("")).toBeNull();
  });

  it("returns null for valid base64url that is not a cursor", () => {
    const encoded = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    expect(decodeRankedCursor(encoded)).toBeNull();
  });

  it("returns null when sortDirection is not asc/desc", () => {
    const bad = { ...BASE_CURSOR, sortDirection: "sideways" };
    const encoded = Buffer.from(JSON.stringify(bad), "utf8").toString("base64url");
    expect(decodeRankedCursor(encoded)).toBeNull();
  });

  it("returns null when id is empty", () => {
    const bad = { ...BASE_CURSOR, id: "" };
    const encoded = Buffer.from(JSON.stringify(bad), "utf8").toString("base64url");
    expect(decodeRankedCursor(encoded)).toBeNull();
  });

  it("returns null when createdAt is not a valid date and sortField is createdAt", () => {
    const bad = { ...BASE_CURSOR, createdAt: "not-a-date" };
    const encoded = Buffer.from(JSON.stringify(bad), "utf8").toString("base64url");
    expect(decodeRankedCursor(encoded)).toBeNull();
  });
});

// ─── hashFilters ──────────────────────────────────────────────────────────────

describe("hashFilters", () => {
  it("produces a 64-char hex string", () => {
    const hash = hashFilters({ q: null, category: "automation" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash regardless of key insertion order", () => {
    const a = hashFilters({ q: "agent", category: "automation" });
    const b = hashFilters({ category: "automation", q: "agent" });
    expect(a).toBe(b);
  });

  it("produces different hashes for different values", () => {
    const a = hashFilters({ q: "agent" });
    const b = hashFilters({ q: "bot" });
    expect(a).not.toBe(b);
  });

  it("treats null and absent key differently", () => {
    const withNull = hashFilters({ q: null });
    const withValue = hashFilters({ q: "x" });
    expect(withNull).not.toBe(withValue);
  });

  it("is stable across calls with the same input", () => {
    const filters = { q: "hello", category: null, sort: "createdAt", direction: "desc" };
    expect(hashFilters(filters)).toBe(hashFilters(filters));
  });
});

// ─── isCursorCompatible ───────────────────────────────────────────────────────

describe("isCursorCompatible", () => {
  const sort = { field: "createdAt", direction: "desc" as const };
  const filterHash = hashFilters({ q: null, category: null, sort: "createdAt", direction: "desc" });

  it("returns true when cursor matches sort and filter hash", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      sortField: "createdAt",
      sortDirection: "desc",
      filterHash,
    };
    expect(isCursorCompatible(cursor, sort, filterHash)).toBe(true);
  });

  it("returns false when sort field differs", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      sortField: "price",
      sortDirection: "desc",
      filterHash,
    };
    expect(isCursorCompatible(cursor, sort, filterHash)).toBe(false);
  });

  it("returns false when sort direction differs", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      sortField: "createdAt",
      sortDirection: "asc",
      filterHash,
    };
    expect(isCursorCompatible(cursor, sort, filterHash)).toBe(false);
  });

  it("returns false when filter hash differs", () => {
    const cursor: RankedMarketplaceCursor = {
      ...BASE_CURSOR,
      sortField: "createdAt",
      sortDirection: "desc",
      filterHash: "different_hash",
    };
    expect(isCursorCompatible(cursor, sort, filterHash)).toBe(false);
  });
});
