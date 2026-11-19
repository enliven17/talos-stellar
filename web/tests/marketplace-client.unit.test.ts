/**
 * Unit tests for the MarketplaceClient helper functions and static properties.
 *
 * The component itself depends on useRouter / useSearchParams (Next.js
 * navigation hooks) and fetch, which are not available in the test environment.
 * Following the pattern established in agent-view-states.unit.test.ts and
 * agent-lifecycle.unit.test.ts, we test the pure, exported logic that drives
 * the component rather than rendering it with jsdom.
 *
 * Covered:
 *   1. buildApiUrl — correct param serialisation for all filter combinations
 *      and clearing.
 *   2. buildPageUrl — correct shareable URL construction, including clearing
 *      each filter individually and all at once.
 *   3. SERVICE_CATEGORIES — All is present and is the first element.
 *   4. SORT_OPTIONS — empty string value represents the default (newest first).
 *   5. Client-side price validation logic (mirrored from commitPriceRange).
 */

import { describe, it, expect } from "vitest";
import {
  buildApiUrl,
  buildPageUrl,
  SERVICE_CATEGORIES,
  SORT_OPTIONS,
} from "@/app/marketplace/marketplace-client";

// ---------------------------------------------------------------------------
// 1. buildApiUrl
// ---------------------------------------------------------------------------

describe("buildApiUrl", () => {
  // ── No filters ────────────────────────────────────────────────────────────

  it("emits only limit when all filter values are at their defaults", () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("category")).toBeNull();
    expect(sp.get("minPrice")).toBeNull();
    expect(sp.get("maxPrice")).toBeNull();
    expect(sp.get("sort")).toBeNull();
    expect(sp.get("direction")).toBeNull();
    expect(sp.get("limit")).toBe("24");
  });

  // ── Category ──────────────────────────────────────────────────────────────

  it('omits category param when category is "All"', () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    expect(new URL(url, "http://x").searchParams.get("category")).toBeNull();
  });

  it("includes category param for a specific category", () => {
    const url = buildApiUrl({ category: "Marketing", minPrice: "", maxPrice: "", sort: "" });
    expect(new URL(url, "http://x").searchParams.get("category")).toBe("Marketing");
  });

  // ── Price ─────────────────────────────────────────────────────────────────

  it("includes minPrice when set", () => {
    const url = buildApiUrl({ category: "All", minPrice: "10", maxPrice: "", sort: "" });
    expect(new URL(url, "http://x").searchParams.get("minPrice")).toBe("10");
    expect(new URL(url, "http://x").searchParams.get("maxPrice")).toBeNull();
  });

  it("includes maxPrice when set", () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "50", sort: "" });
    expect(new URL(url, "http://x").searchParams.get("maxPrice")).toBe("50");
    expect(new URL(url, "http://x").searchParams.get("minPrice")).toBeNull();
  });

  it("includes both minPrice and maxPrice when both are set", () => {
    const url = buildApiUrl({ category: "All", minPrice: "10", maxPrice: "50", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("minPrice")).toBe("10");
    expect(sp.get("maxPrice")).toBe("50");
  });

  it("treats minPrice=0 as a valid value (not falsy-filtered)", () => {
    // "0" is falsy in JS — ensure buildApiUrl does NOT drop it.
    // The component only passes non-empty strings, so "0" should be included.
    const url = buildApiUrl({ category: "All", minPrice: "0", maxPrice: "", sort: "" });
    expect(new URL(url, "http://x").searchParams.get("minPrice")).toBe("0");
  });

  // ── Sort ──────────────────────────────────────────────────────────────────

  it('omits sort and direction params when sort is "" (default)', () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBeNull();
    expect(sp.get("direction")).toBeNull();
  });

  it('splits "price:asc" into sort=price&direction=asc', () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "price:asc" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBe("price");
    expect(sp.get("direction")).toBe("asc");
  });

  it('splits "price:desc" into sort=price&direction=desc', () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "price:desc" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBe("price");
    expect(sp.get("direction")).toBe("desc");
  });

  it('splits "createdAt:asc" into sort=createdAt&direction=asc', () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "createdAt:asc" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBe("createdAt");
    expect(sp.get("direction")).toBe("asc");
  });

  // ── Cursor ────────────────────────────────────────────────────────────────

  it("includes cursor when provided", () => {
    const url = buildApiUrl({
      category: "All", minPrice: "", maxPrice: "", sort: "",
      cursor: "some-opaque-cursor",
    });
    expect(new URL(url, "http://x").searchParams.get("cursor")).toBe("some-opaque-cursor");
  });

  it("omits cursor when null", () => {
    const url = buildApiUrl({
      category: "All", minPrice: "", maxPrice: "", sort: "",
      cursor: null,
    });
    expect(new URL(url, "http://x").searchParams.get("cursor")).toBeNull();
  });

  // ── Combined ─────────────────────────────────────────────────────────────

  it("serialises all four filter params at once", () => {
    const url = buildApiUrl({
      category: "Analytics",
      minPrice: "5",
      maxPrice: "200",
      sort: "price:asc",
    });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("category")).toBe("Analytics");
    expect(sp.get("minPrice")).toBe("5");
    expect(sp.get("maxPrice")).toBe("200");
    expect(sp.get("sort")).toBe("price");
    expect(sp.get("direction")).toBe("asc");
    expect(sp.get("limit")).toBe("24");
  });

  // ── Clearing ──────────────────────────────────────────────────────────────

  it("clearing all filters produces a minimal URL with only limit=24", () => {
    const url = buildApiUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    // Only limit should be set
    expect([...sp.keys()]).toEqual(["limit"]);
  });
});

// ---------------------------------------------------------------------------
// 2. buildPageUrl
// ---------------------------------------------------------------------------

describe("buildPageUrl", () => {
  // ── No filters ────────────────────────────────────────────────────────────

  it('returns "/marketplace" with no query string when all defaults', () => {
    const url = buildPageUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    expect(url).toBe("/marketplace");
  });

  // ── Individual filters ────────────────────────────────────────────────────

  it("includes category in page URL", () => {
    const url = buildPageUrl({ category: "Marketing", minPrice: "", maxPrice: "", sort: "" });
    expect(url).toBe("/marketplace?category=Marketing");
  });

  it("includes minPrice in page URL", () => {
    const url = buildPageUrl({ category: "All", minPrice: "10", maxPrice: "", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("minPrice")).toBe("10");
    expect(sp.get("category")).toBeNull();
  });

  it("includes maxPrice in page URL", () => {
    const url = buildPageUrl({ category: "All", minPrice: "", maxPrice: "50", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("maxPrice")).toBe("50");
  });

  it("includes sort in page URL", () => {
    const url = buildPageUrl({ category: "All", minPrice: "", maxPrice: "", sort: "price:asc" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBe("price:asc");
  });

  // ── Clearing individual filters ───────────────────────────────────────────

  it("clearing category drops it from the URL while preserving other params", () => {
    // Simulate: user has category=Marketing, minPrice=5 set, then clears category
    const url = buildPageUrl({ category: "All", minPrice: "5", maxPrice: "", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("category")).toBeNull();
    expect(sp.get("minPrice")).toBe("5");
  });

  it("clearing minPrice drops it from the URL while preserving other params", () => {
    const url = buildPageUrl({ category: "Finance", minPrice: "", maxPrice: "100", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("minPrice")).toBeNull();
    expect(sp.get("category")).toBe("Finance");
    expect(sp.get("maxPrice")).toBe("100");
  });

  it("clearing maxPrice drops it from the URL while preserving other params", () => {
    const url = buildPageUrl({ category: "All", minPrice: "5", maxPrice: "", sort: "price:asc" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("maxPrice")).toBeNull();
    expect(sp.get("minPrice")).toBe("5");
    expect(sp.get("sort")).toBe("price:asc");
  });

  it("clearing sort drops it from the URL while preserving other params", () => {
    const url = buildPageUrl({ category: "Research", minPrice: "10", maxPrice: "200", sort: "" });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("sort")).toBeNull();
    expect(sp.get("category")).toBe("Research");
  });

  // ── Clearing all ──────────────────────────────────────────────────────────

  it('clearing all filters produces exactly "/marketplace"', () => {
    const url = buildPageUrl({ category: "All", minPrice: "", maxPrice: "", sort: "" });
    expect(url).toBe("/marketplace");
  });

  // ── Combined ─────────────────────────────────────────────────────────────

  it("serialises all four filter params into the page URL", () => {
    const url = buildPageUrl({
      category: "Sales",
      minPrice: "1",
      maxPrice: "999",
      sort: "price:desc",
    });
    const sp = new URL(url, "http://x").searchParams;
    expect(sp.get("category")).toBe("Sales");
    expect(sp.get("minPrice")).toBe("1");
    expect(sp.get("maxPrice")).toBe("999");
    expect(sp.get("sort")).toBe("price:desc");
  });

  it("URL starts with /marketplace", () => {
    const url = buildPageUrl({ category: "Design", minPrice: "", maxPrice: "", sort: "" });
    expect(url.startsWith("/marketplace")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. SERVICE_CATEGORIES constant
// ---------------------------------------------------------------------------

describe("SERVICE_CATEGORIES", () => {
  it('has "All" as the first element', () => {
    expect(SERVICE_CATEGORIES[0]).toBe("All");
  });

  it("contains all expected category names", () => {
    const expected = [
      "Marketing", "Development", "Research", "Design", "Finance",
      "Analytics", "Operations", "Sales", "Support", "Education",
    ];
    for (const cat of expected) {
      expect(SERVICE_CATEGORIES).toContain(cat);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(SERVICE_CATEGORIES).size).toBe(SERVICE_CATEGORIES.length);
  });
});

// ---------------------------------------------------------------------------
// 4. SORT_OPTIONS constant
// ---------------------------------------------------------------------------

describe("SORT_OPTIONS", () => {
  it('has "" (empty string) as the default/first option value', () => {
    expect(SORT_OPTIONS[0].value).toBe("");
  });

  it("contains price:asc, price:desc, and createdAt:asc", () => {
    const values = SORT_OPTIONS.map((o) => o.value);
    expect(values).toContain("price:asc");
    expect(values).toContain("price:desc");
    expect(values).toContain("createdAt:asc");
  });

  it("every option has a non-empty label", () => {
    for (const opt of SORT_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate values", () => {
    const values = SORT_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Client-side price validation (mirrors commitPriceRange logic)
//
// The component validates drafts before pushing to the URL.  We test the
// identical logic inline since it's not extracted to its own utility.
// ---------------------------------------------------------------------------

describe("client-side price validation (commitPriceRange logic)", () => {
  // Extracted verbatim from the component to keep tests independent of render.
  function validate(min: string, max: string): string | null {
    if (min !== "" && Number.isNaN(Number(min))) return "Min price must be a number.";
    if (max !== "" && Number.isNaN(Number(max))) return "Max price must be a number.";
    if (min !== "" && max !== "" && Number(min) > Number(max))
      return "Min price cannot exceed max price.";
    return null;
  }

  it("returns null (valid) when both are empty", () => {
    expect(validate("", "")).toBeNull();
  });

  it("returns null when only min is set to a valid number", () => {
    expect(validate("10", "")).toBeNull();
  });

  it("returns null when only max is set to a valid number", () => {
    expect(validate("", "50")).toBeNull();
  });

  it("returns null when min < max", () => {
    expect(validate("10", "50")).toBeNull();
  });

  it("returns null when min === max (single-price boundary)", () => {
    expect(validate("25", "25")).toBeNull();
  });

  it("returns null when min is 0 (free tier boundary)", () => {
    expect(validate("0", "")).toBeNull();
    expect(validate("0", "0")).toBeNull();
  });

  it("returns an error when min is non-numeric", () => {
    const err = validate("abc", "");
    expect(err).toMatch(/min.*number/i);
  });

  it("returns an error when max is non-numeric", () => {
    const err = validate("", "xyz");
    expect(err).toMatch(/max.*number/i);
  });

  it("returns an error when min > max (reversed range)", () => {
    const err = validate("100", "10");
    expect(err).toMatch(/min.*exceed|cannot exceed|min.*max/i);
  });

  it("returns min-error before max-error (fail-fast order)", () => {
    // Both bad; min is checked first.
    const err = validate("bad", "also-bad");
    expect(err).toMatch(/min.*number/i);
  });

  it("returns reversed-range error only when both values are valid numbers", () => {
    // max is bad text → max-error fires before the range check
    const err = validate("50", "bad");
    expect(err).toMatch(/max.*number/i);
    expect(err).not.toMatch(/exceed/i);
  });
});
