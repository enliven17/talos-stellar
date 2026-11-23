import { describe, expect, it } from "vitest";
import {
  summarizeMonthlyRevenue,
  summarizeRevenueObservations,
} from "../src/lib/revenue-observations";

describe("summarizeRevenueObservations", () => {
  it("reports no observations instead of a zero total when the list is absent or empty", () => {
    for (const input of [undefined, null, []]) {
      const summary = summarizeRevenueObservations(input);
      expect(summary.hasObservations).toBe(false);
      expect(summary.total).toBeNull();
      expect(summary.bySource).toBeNull();
    }
  });

  it("preserves a verified zero observation", () => {
    const summary = summarizeRevenueObservations([
      { amount: "0", source: "jobs" },
    ]);

    expect(summary.hasObservations).toBe(true);
    expect(summary.total).toBe(0);
    expect(summary.bySource).toEqual({ jobs: 0 });
  });

  it("sums and groups observed amounts by source", () => {
    const summary = summarizeRevenueObservations([
      { amount: "10.50", source: "jobs" },
      { amount: 4.5, source: "jobs" },
      { amount: "2", source: "tips" },
    ]);

    expect(summary.hasObservations).toBe(true);
    expect(summary.total).toBe(17);
    expect(summary.bySource).toEqual({ jobs: 15, tips: 2 });
  });
});

describe("summarizeMonthlyRevenue", () => {
  it("reports no observations for empty or absent history", () => {
    for (const input of [undefined, null, []]) {
      const summary = summarizeMonthlyRevenue(input);
      expect(summary.hasObservations).toBe(false);
      expect(summary.thisMonth).toBeNull();
      expect(summary.averageMonthly).toBeNull();
    }
  });

  it("keeps a verified zero month distinct from missing history", () => {
    const summary = summarizeMonthlyRevenue([{ month: "Jan", amount: 0 }]);

    expect(summary.hasObservations).toBe(true);
    expect(summary.thisMonth).toBe(0);
    expect(summary.averageMonthly).toBe(0);
  });

  it("uses the latest month and rounds the average", () => {
    const summary = summarizeMonthlyRevenue([
      { month: "Jan", amount: 3000 },
      { month: "Feb", amount: 4500 },
    ]);

    expect(summary.thisMonth).toBe(4500);
    expect(summary.averageMonthly).toBe(3750);
  });
});
