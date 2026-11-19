import { describe, it, expect } from "vitest";

import {
  buildReconcilerViewModel,
  formatTimestamp,
  formatTimeSold,
  summarizeTickResult,
  type ReconcilerRecord,
  type ReconcilerStats,
} from "./view-model";

const stats: ReconcilerStats = {
  pending: 3,
  confirmed: 12,
  failed: 1,
  lastTickAt: "2024-06-01T12:00:00Z",
};

const records: ReconcilerRecord[] = [
  {
    id: "rec_1",
    txHashTruncated: "abcdef1...123456789",
    sourceType: "payment",
    sourceId: "pay_1",
    finalityStatus: "pending",
    pollCount: 4,
    lastError: null,
    createdAt: "2024-06-01T10:00:00Z",
    updatedAt: "2024-06-01T11:00:00Z",
  },
  {
    id: "rec_2",
    txHashTruncated: "fedcba1...987654321",
    sourceType: "payment",
    sourceId: "pay_2",
    finalityStatus: "failed",
    pollCount: 9,
    lastError: "Horizon timeout",
    createdAt: "2024-06-01T09:00:00Z",
    updatedAt: "2024-06-01T10:30:00Z",
  },
];

describe("buildReconcilerViewModel", () => {
  it("returns an empty-state view model with no records", () => {
    const vm = buildReconcilerViewModel(stats, [], null);
    expect(vm.records).toEqual([]);
    expect(vm.isEmpty).toBe(true);
    expect(vm.statsCards).toHaveLength(3);
  });

  it("projects stats and records", () => {
    const vm = buildReconcilerViewModel(stats, records, null);
    expect(vm.isEmpty).toBe(false);
    expect(vm.records).toHaveLength(2);
    expect(vm.statsCards).toEqual([
      { label: "Pending", value: 3, tone: "warning" },
      { label: "Confirmed", value: 12, tone: "success" },
      { label: "Failed", value: 1, tone: "danger" },
    ]);
    expect(vm.lastTickLabel).toBe("2024-06-01 12:00 UTC");
  });

  it("marks rows with errors and truncated hashes only", () => {
    const vm = buildReconcilerViewModel(stats, records, null);
    const row = vm.rows[1];
    expect(row.hasError).toBe(true);
    expect(row.statusTone).toBe("danger");
    expect(row.txHashTruncated).toBeTruthy();
    expect(row.txHashTruncated.length).toBeLessThan(64);
  });

  it("renders the tick summary when present", () => {
    const vm = buildReconcilerViewModel(stats, records, {
      ok: false,
      partial: true,
      message: "Horizon unavailable",
      processed: 2,
      confirmed: 1,
      failed: 1,
    });
    expect(vm.tickSummary).not.toBeNull();
    expect(vm.tickSummary?.partial).toBe(true);
    expect(vm.tickSummary?.tone).toBe("warning");
  });
});

describe("summarizeTickResult", () => {
  it("returns null for no result", () => {
    expect(summarizeTickResult(null)).toBeNull();
  });

  it("summarizes a successful tick", () => {
    const summary = summarizeTickResult({
      ok: true,
      partial: false,
      message: "Tick completed",
      processed: 5,
      confirmed: 4,
      failed: 1,
    });
    expect(summary?.tone).toBe("success");
    expect(summary?.partial).toBe(false);
    expect(summary?.detail).toContain("5");
  });

  it("surfaces the 503 partial case", () => {
    const summary = summarizeTickResult({
      ok: false,
      partial: true,
      message: "Horizon unreachable",
      processed: 0,
      confirmed: 0,
      failed: 0,
    });
    expect(summary?.tone).toBe("warning");
    expect(summary?.partial).toBe(true);
    expect(summary?.message).toBe("Horizon unreachable");
  });
});

describe("time formatting", () => {
  it("formats ISO timestamps to UTC labels", () => {
    expect(formatTimestamp("2024-06-01T12:34:56Z")).toBe("2024-06-01 12:34 UTC");
  });

  it("returns an empty label for missing timestamps", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
  });

  it("formats relative time for recent timestamps", () => {
    const now = new Date("2024-06-01T12:00:00Z");
    expect(formatTimeSold("2024-06-01T11:59:30Z", now)).toBe("30s ago");
    expect(formatTimeSold("2024-06-01T11:59:00Z", now)).toBe("1m ago");
    expect(formatTimeSold("2024-06-01T10:00:00Z", now)).toBe("2h ago");
  });
});
