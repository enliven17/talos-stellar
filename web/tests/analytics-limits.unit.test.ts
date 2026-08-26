import { describe, it, expect } from "vitest";
import { parseAnalyticsLimit } from "@/lib/analytics-limits";

describe("parseAnalyticsLimit", () => {
  describe("absent param → defaultLimit", () => {
    it("returns defaultLimit when raw is null", () => {
      const result = parseAnalyticsLimit(null, 25, 100);
      expect(result).toEqual({ ok: true, limit: 25 });
    });

    it("returns defaultLimit when raw is undefined", () => {
      const result = parseAnalyticsLimit(undefined, 10, 50);
      expect(result).toEqual({ ok: true, limit: 10 });
    });
  });

  describe("valid positive integers up to maxLimit", () => {
    const validCases: Array<[string, number, number, number]> = [
      ["1", 25, 100, 1],
      ["25", 25, 100, 25],
      ["100", 25, 100, 100],
      ["50", 10, 50, 50],
      ["10", 10, 50, 10],
      ["5000", 5000, 10000, 5000],
      ["10000", 5000, 10000, 10000],
    ];

    it.each(validCases)(
      'parseAnalyticsLimit("%s", %i, %i) → %i',
      (raw, def, max, expected) => {
        const result = parseAnalyticsLimit(raw, def, max);
        expect(result).toEqual({ ok: true, limit: expected });
      },
    );
  });

  describe("exceeds maxLimit → returns 400 validation error", () => {
    const overLimitCases: Array<[string, number, number]> = [
      ["101", 25, 100],
      ["500", 25, 100],
      ["9999", 50, 100],
      ["51", 10, 50],
      ["10001", 5000, 10000],
    ];

    it.each(overLimitCases)(
      'parseAnalyticsLimit("%s", %i, %i) → 400 over limit',
      async (raw, def, max) => {
        const result = parseAnalyticsLimit(raw, def, max);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.response.status).toBe(400);
          const body = await result.response.json();
          expect(body.error).toContain(`exceeds maximum allowed limit of ${max}`);
        }
      },
    );
  });

  describe("zero, negative, and malformed inputs → returns 400", () => {
    const invalidCases = [
      "0",
      "-1",
      "-50",
      "abc",
      "1.5",
      "1.0",
      "",
      " ",
      "1e2",
      "NaN",
      "Infinity",
      "0x10",
      " 10",
      "10 ",
    ];

    it.each(invalidCases)('rejects "%s" with 400', async (raw) => {
      const result = parseAnalyticsLimit(raw, 25, 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        const body = await result.response.json();
        expect(body).toHaveProperty("error");
        expect(body.error).toBe("limit must be a positive integer");
      }
    });
  });

  describe("custom parameter names in error response", () => {
    it("uses custom paramName in error messages", async () => {
      const malformed = parseAnalyticsLimit("abc", 25, 100, "jobLimit");
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) {
        expect(malformed.response.status).toBe(400);
        const body = await malformed.response.json();
        expect(body.error).toBe("jobLimit must be a positive integer");
      }

      const overLimit = parseAnalyticsLimit("200", 25, 100, "jobLimit");
      expect(overLimit.ok).toBe(false);
      if (!overLimit.ok) {
        expect(overLimit.response.status).toBe(400);
        const body = await overLimit.response.json();
        expect(body.error).toBe("jobLimit exceeds maximum allowed limit of 100");
      }
    });
  });
});
