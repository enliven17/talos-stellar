import { describe, it, expect } from "vitest";
import { backoffMs, decideRetry } from "../src/lib/jobs/retry";

describe("jobs/retry — backoffMs", () => {
  it("grows exponentially with attempts for transient jobs", () => {
    const noJitter = () => 1; // pin the random factor so we assert the exponent, not the jitter
    expect(backoffMs("transient", 1, noJitter)).toBe(1_000);
    expect(backoffMs("transient", 2, noJitter)).toBe(2_000);
    expect(backoffMs("transient", 3, noJitter)).toBe(4_000);
    expect(backoffMs("transient", 4, noJitter)).toBe(8_000);
  });

  it("caps transient backoff at 5 minutes", () => {
    const noJitter = () => 1;
    expect(backoffMs("transient", 20, noJitter)).toBe(5 * 60_000);
  });

  it("uses a larger base and cap for rate_limited than transient", () => {
    const noJitter = () => 1;
    expect(backoffMs("rate_limited", 1, noJitter)).toBe(10_000);
    expect(backoffMs("rate_limited", 20, noJitter)).toBe(15 * 60_000);
  });

  it("applies full jitter — result is in [0, exponentialValue)", () => {
    const exponentialValue = 4_000; // attempts=3 → base 1000 * 2^2
    for (const random of [0, 0.5, 0.999999]) {
      const delay = backoffMs("transient", 3, () => random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(exponentialValue);
    }
  });
});

describe("jobs/retry — decideRetry", () => {
  it("retries a transient failure below maxAttempts", () => {
    const decision = decideRetry({ retryClass: "transient", attempts: 2, maxAttempts: 8 }, () => 0.5);
    expect(decision.action).toBe("retry");
    if (decision.action === "retry") expect(decision.delayMs).toBeGreaterThanOrEqual(0);
  });

  it("dead-letters a transient job once attempts reach maxAttempts", () => {
    const decision = decideRetry({ retryClass: "transient", attempts: 8, maxAttempts: 8 });
    expect(decision).toEqual({ action: "dead_letter" });
  });

  it("dead-letters a transient job that somehow exceeds maxAttempts", () => {
    const decision = decideRetry({ retryClass: "transient", attempts: 9, maxAttempts: 8 });
    expect(decision).toEqual({ action: "dead_letter" });
  });

  it("dead-letters fatal errors on the very first attempt, ignoring maxAttempts", () => {
    const decision = decideRetry({ retryClass: "fatal", attempts: 1, maxAttempts: 8 });
    expect(decision).toEqual({ action: "dead_letter" });
  });

  it("retries rate_limited failures the same as transient (just slower backoff)", () => {
    const decision = decideRetry({ retryClass: "rate_limited", attempts: 1, maxAttempts: 10 }, () => 0.5);
    expect(decision.action).toBe("retry");
  });
});
