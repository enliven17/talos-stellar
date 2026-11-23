import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { LifecycleError } from "../src/lib/governance/lifecycle";
import { isDecimalAmount, snapshotPayoutObligations } from "../src/lib/governance/payout-obligations";

function executorReturning(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    groupBy: vi.fn(async () => rows),
  };
  return { select: vi.fn(() => chain) } as any;
}

describe("snapshotPayoutObligations", () => {
  it("keeps per-currency totals as exact decimal strings and sums record counts", async () => {
    const executor = executorReturning([
      { currency: "USDC", total: "12.500000", count: 2 },
      { currency: "XLM", total: "0.000001", count: 1 },
    ]);
    const snap = await snapshotPayoutObligations("t1", executor);
    expect(snap).toEqual({
      outstanding: { USDC: "12.500000", XLM: "0.000001" },
      recordCount: 3,
      source: "tls_dividends",
    });
  });

  it("returns an empty snapshot when nothing is owed", async () => {
    const snap = await snapshotPayoutObligations("t1", executorReturning([]));
    expect(snap.outstanding).toEqual({});
    expect(snap.recordCount).toBe(0);
  });

  it("fails closed on an amount that is not an exact decimal", async () => {
    const executor = executorReturning([{ currency: "USDC", total: "1e3", count: 1 }]);
    const err = await snapshotPayoutObligations("t1", executor).catch((e) => e);
    expect(err).toBeInstanceOf(LifecycleError);
    expect(err.code).toBe("LIFECYCLE_PREREQUISITE_FAILED");
  });
});

describe("isDecimalAmount", () => {
  it.each(["0", "12", "12.5", "12.500000", "0.000001"])("accepts %s", (v) => {
    expect(isDecimalAmount(v)).toBe(true);
  });
  it.each(["", "-1", "1e3", "12.5000001", ".5", "1,000", " 1"])("rejects %j", (v) => {
    expect(isDecimalAmount(v)).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isDecimalAmount(12.5)).toBe(false);
    expect(isDecimalAmount(null)).toBe(false);
  });
});
