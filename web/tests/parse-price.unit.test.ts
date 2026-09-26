/**
 * Unit tests for parsePriceRange.
 *
 * Covers every documented rule:
 *   1. Both absent  → ok, both undefined (unfiltered).
 *   2. One present  → ok, only that bound set.
 *   3. Valid numbers (integer, decimal, zero, large) → ok.
 *   4. Non-numeric strings → 400 naming the offending param.
 *   5. Negative values → 400.
 *   6. minPrice > maxPrice (reversed range) → 400 with both values in message.
 *   7. minPrice === maxPrice (exact match) → ok.
 *   8. Empty string → treated as non-numeric → 400.
 *   9. Infinity / NaN strings → 400.
 */

import { describe, it, expect } from "vitest";
import { parsePriceRange } from "@/lib/parse-price";

// ---------------------------------------------------------------------------
// 1. Both absent
// ---------------------------------------------------------------------------

describe("both params absent", () => {
  it("returns ok with both values undefined when both are null", () => {
    const result = parsePriceRange(null, null);
    expect(result).toEqual({ ok: true, minPrice: undefined, maxPrice: undefined });
  });
});

// ---------------------------------------------------------------------------
// 2. One param present
// ---------------------------------------------------------------------------

describe("single param present", () => {
  it("sets only minPrice when maxPrice is null", () => {
    const result = parsePriceRange("10", null);
    expect(result).toEqual({ ok: true, minPrice: 10, maxPrice: undefined });
  });

  it("sets only maxPrice when minPrice is null", () => {
    const result = parsePriceRange(null, "50");
    expect(result).toEqual({ ok: true, minPrice: undefined, maxPrice: 50 });
  });
});

// ---------------------------------------------------------------------------
// 3. Valid value shapes
// ---------------------------------------------------------------------------

describe("valid value shapes", () => {
  const cases: Array<[string, string, number, number]> = [
    ["integer strings",        "1",    "100",  1   ],
    ["decimal strings",        "1.50", "9.99", 1.5 ],
    ["zero min",               "0",    "10",   0   ],
    ["zero both",              "0",    "0",    0   ],
    ["large values",           "0",    "99999",0   ],
    ["equal min and max",      "25",   "25",   25  ],
  ];

  it.each(cases)(
    "%s: parsePriceRange(%s, %s) → ok",
    (_label, rawMin, rawMax, expectedMin) => {
      const result = parsePriceRange(rawMin, rawMax);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.minPrice).toBe(expectedMin);
      }
    },
  );

  it("zero is a valid free-tier price (boundary)", () => {
    const result = parsePriceRange("0", null);
    expect(result).toEqual({ ok: true, minPrice: 0, maxPrice: undefined });
  });
});

// ---------------------------------------------------------------------------
// 4. Non-numeric strings → 400
// ---------------------------------------------------------------------------

describe("non-numeric minPrice → 400", () => {
  const invalid = ["abc", "ten", "$10", "10px", "--"];

  it.each(invalid)('rejects minPrice="%s" with 400', async (raw) => {
    const result = parsePriceRange(raw, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/minPrice/);
    }
  });
});

describe("non-numeric maxPrice → 400", () => {
  const invalid = ["abc", "max", "$50", "50px"];

  it.each(invalid)('rejects maxPrice="%s" with 400', async (raw) => {
    const result = parsePriceRange(null, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/maxPrice/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Negative values → 400
// ---------------------------------------------------------------------------

describe("negative values → 400", () => {
  it("rejects negative minPrice", async () => {
    const result = parsePriceRange("-1", null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/minPrice/);
      expect(body.error).toMatch(/non-negative/);
    }
  });

  it("rejects negative maxPrice", async () => {
    const result = parsePriceRange(null, "-0.01");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/maxPrice/);
    }
  });

  it("validates minPrice before maxPrice (fail-fast on first bad param)", async () => {
    // Both negative; the error should mention minPrice (checked first).
    const result = parsePriceRange("-5", "-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = await result.response.json();
      expect(body.error).toMatch(/minPrice/);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Reversed range → 400
// ---------------------------------------------------------------------------

describe("reversed price range (minPrice > maxPrice) → 400", () => {
  const cases: Array<[string, string]> = [
    ["100",  "10"   ],
    ["50.01","50"   ],
    ["1",    "0"    ],
    ["999",  "1"    ],
  ];

  it.each(cases)(
    "minPrice=%s > maxPrice=%s → 400 with both values in message",
    async (rawMin, rawMax) => {
      const result = parsePriceRange(rawMin, rawMax);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        const body = await result.response.json();
        // Message must contain both numeric values so the caller knows exactly
        // what was wrong without parsing the raw query string again.
        expect(body.error).toContain(rawMin);
        expect(body.error).toContain(rawMax);
        expect(body.error).toMatch(/minPrice|min.*max|less than or equal/i);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 7. Equal min and max → ok (single-price filter)
// ---------------------------------------------------------------------------

describe("equal min and max → ok", () => {
  it("accepts minPrice === maxPrice as a single-price filter", () => {
    const result = parsePriceRange("25", "25");
    expect(result).toEqual({ ok: true, minPrice: 25, maxPrice: 25 });
  });

  it("accepts zero === zero", () => {
    const result = parsePriceRange("0", "0");
    expect(result).toEqual({ ok: true, minPrice: 0, maxPrice: 0 });
  });
});

// ---------------------------------------------------------------------------
// 8. Empty string → treated as absent (ok, value undefined)
// ---------------------------------------------------------------------------

describe("empty string → treated as absent (ok)", () => {
  it('treats minPrice="" as absent — returns ok with minPrice undefined', () => {
    const result = parsePriceRange("", null);
    expect(result).toEqual({ ok: true, minPrice: undefined, maxPrice: undefined });
  });

  it('treats maxPrice="" as absent — returns ok with maxPrice undefined', () => {
    const result = parsePriceRange(null, "");
    expect(result).toEqual({ ok: true, minPrice: undefined, maxPrice: undefined });
  });

  it('treats both "" as both absent — fully unfiltered', () => {
    const result = parsePriceRange("", "");
    expect(result).toEqual({ ok: true, minPrice: undefined, maxPrice: undefined });
  });
});

// ---------------------------------------------------------------------------
// 9. Infinity / NaN strings → 400
// ---------------------------------------------------------------------------

describe("Infinity and NaN strings → 400", () => {
  const special = ["Infinity", "-Infinity", "NaN", "inf", "+Inf"];

  it.each(special)('rejects minPrice="%s" with 400', async (raw) => {
    const result = parsePriceRange(raw, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it.each(special)('rejects maxPrice="%s" with 400', async (raw) => {
    const result = parsePriceRange(null, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});
