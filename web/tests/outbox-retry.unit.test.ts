import { describe, it, expect } from "vitest";
import { backoffMs, boundRetryDelayMs, decideRetry, MAX_RETRY_DELAY_MS } from "../src/lib/outbox/retry";

describe("outbox/retry — backoffMs", () => {
  it("grows exponentially and is capped at 5 minutes", () => {
    const noJitter = () => 1;
    expect(backoffMs(1, noJitter)).toBe(1_000);
    expect(backoffMs(2, noJitter)).toBe(2_000);
    expect(backoffMs(3, noJitter)).toBe(4_000);
    expect(backoffMs(20, noJitter)).toBe(5 * 60_000);
  });

  it("applies full jitter — result is in [0, exponentialValue)", () => {
    const exponentialValue = 4_000;
    for (const random of [0, 0.5, 0.999999]) {
      const delay = backoffMs(3, () => random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(exponentialValue);
    }
  });
});

describe("outbox/retry — decideRetry", () => {
  it("retries below maxAttempts", () => {
    const decision = decideRetry({ attempts: 2, maxAttempts: 8 }, () => 0.5);
    expect(decision.action).toBe("retry");
  });

  it("dead-letters once attempts reach maxAttempts", () => {
    expect(decideRetry({ attempts: 8, maxAttempts: 8 })).toEqual({ action: "dead_letter" });
  });

  it("dead-letters once attempts exceed maxAttempts", () => {
    expect(decideRetry({ attempts: 9, maxAttempts: 8 })).toEqual({ action: "dead_letter" });
  });
});

describe("outbox/retry — boundRetryDelayMs", () => {
  it("clamps negative, non-finite, and oversized delays to [0, MAX_RETRY_DELAY_MS]", () => {
    expect(boundRetryDelayMs(-500)).toBe(0);
    expect(boundRetryDelayMs(Number.NaN)).toBe(0);
    expect(boundRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(boundRetryDelayMs(1234.9)).toBe(1234);
    expect(boundRetryDelayMs(MAX_RETRY_DELAY_MS + 60_000)).toBe(MAX_RETRY_DELAY_MS);
  });
});
