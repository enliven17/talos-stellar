import { describe, expect, it } from "vitest";
import { calculateLiabilities, dividendFixtures, type DividendRole } from "./dividend-conservation";

describe("dividend conservation fixtures", () => {
  it("is a versioned cross-client fixture set", () => {
    expect(dividendFixtures.format).toBe("talos-dividend-conservation-fixtures");
    expect(dividendFixtures.spec_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dividendFixtures.rounding).toBe("floor");
    expect(dividendFixtures.roles).toEqual(["creator", "investor", "treasury"]);
    expect(dividendFixtures.cases.length).toBeGreaterThanOrEqual(3);
  });

  for (const testCase of dividendFixtures.cases) {
    it(`preserves conservation for ${testCase.id}`, () => {
      const result = calculateLiabilities(testCase);

      expect(new Set(testCase.claim_order)).toEqual(new Set(dividendFixtures.roles));
      expect(result.claimed.toString()).toBe(testCase.expected_claimed_amount);
      expect(result.roundingDust.toString()).toBe(testCase.expected_rounding_dust);
      expect(result.claimed + result.roundingDust).toBe(BigInt(testCase.funded_amount));

      for (const role of dividendFixtures.roles as DividendRole[]) {
        expect(result.allocations[role].toString()).toBe(testCase.expected_allocations[role]);
      }
    });
  }

  it("produces the same recipient liabilities regardless of claim order", () => {
    const results = dividendFixtures.cases
      .filter((testCase) => testCase.funded_amount === "103")
      .map((testCase) => calculateLiabilities(testCase).allocations);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
  });
});
