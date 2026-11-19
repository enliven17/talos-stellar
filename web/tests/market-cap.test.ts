import { describe, expect, it } from "vitest";
import { calculateMarketCap } from "../src/lib/market-cap";

describe("calculateMarketCap", () => {
  it("calculates market cap to six decimal places", () => {
    expect(calculateMarketCap("0.123456", 3)).toBe(0.370368);
    expect(calculateMarketCap("0.1", 3)).toBe(0.3);
  });

  it.each([null, undefined, "", "not-a-price", "Infinity"])(
    "returns null for an invalid pulse price (%s)",
    (pulsePrice) => {
      expect(calculateMarketCap(pulsePrice, 100)).toBeNull();
    },
  );

  it("returns null when market cap cannot be represented as a finite number", () => {
    expect(calculateMarketCap("1e308", 1e308)).toBeNull();
  });
});
