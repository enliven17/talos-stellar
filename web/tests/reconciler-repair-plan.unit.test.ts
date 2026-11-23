/**
 * Unit tests for the dry-run payment repair plan and guarded execution.
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildPaymentRepairPlan,
  createDryRunRepairPlan,
  executeRepairPlan,
  computePlanHash,
} from "../src/lib/reconciler/plan";
import type {
  HorizonPollResult,
  ReconcilerConfig,
  TxRecord,
  TxRecordUpdate,
} from "../src/lib/reconciler/types";

const BASE_CONFIG: ReconcilerConfig = {
  enabled: true,
  pollIntervalMs: 30_000,
  maxLedgerGap: 120,
  notFoundThreshold: 3,
  batchSize: 50,
  horizonUrl: "https://horizon-testnet.stellar.org",
  confirmationDepth: 2,
};

const NOW = new Date("2026-11-20T12:00:00.000Z");

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: "rec_1",
    txHash: "hash_1",
    sourceType: "commerce_job",
    sourceId: "job_1",
    finalityStatus: "PENDING",
    ledgerSubmitted: 1000,
    lastLedgerChecked: null,
    confirmedLedger: null,
    pollCount: 0,
    lastError: null,
    repairApplied: false,
    expiresAt: new Date("2026-11-20T13:00:00.000Z"),
    createdAt: new Date("2026-11-20T11:00:00.000Z"),
    updatedAt: new Date("2026-11-20T11:30:00.000Z"),
    ...overrides,
  };
}

describe("buildPaymentRepairPlan", () => {
  it("shows proposed state changes, downstream repairs, and supporting observations", () => {
    const pendingFailed = makeRecord({
      id: "rec_fail",
      txHash: "hash_fail",
      sourceType: "commerce_job",
      sourceId: "job_fail",
      finalityStatus: "PENDING",
    });
    const confirmingReady = makeRecord({
      id: "rec_confirm",
      txHash: "hash_confirm",
      sourceType: "token_purchase",
      sourceId: "hash_confirm",
      finalityStatus: "CONFIRMING",
      confirmedLedger: 1005,
    });
    const pendingConfirmed = makeRecord({
      id: "rec_pending_ok",
      txHash: "hash_pending_ok",
      sourceType: "commerce_job",
      sourceId: "job_ok",
      finalityStatus: "PENDING",
    });

    const observations = new Map<string, HorizonPollResult | null>([
      ["rec_fail", { outcome: "failed", ledger: 1006, successful: false, detail: "tx_bad_seq" }],
      ["rec_confirm", null],
      ["rec_pending_ok", { outcome: "confirmed", ledger: 1007, successful: true }],
    ]);

    const plan = buildPaymentRepairPlan(
      [pendingFailed, confirmingReady, pendingConfirmed],
      observations,
      1008,
      BASE_CONFIG,
      NOW,
    );

    expect(plan.currentLedger).toBe(1008);
    expect(plan.planHash).toBe(computePlanHash(plan));
    expect(plan.items).toHaveLength(3);

    const failItem = plan.items[0];
    expect(failItem.currentState.finalityStatus).toBe("PENDING");
    expect(failItem.proposedState.finalityStatus).toBe("FAILED");
    expect(failItem.proposedState.repairApplied).toBe(true);
    expect(failItem.proposedRepair).toEqual({
      action: "mark_failed",
      targetTable: "tls_commerce_jobs",
      targetStatus: "payment_failed",
      detail: "Job status -> payment_failed (if still pending)",
    });
    expect(failItem.observations.pollResult).toEqual({
      outcome: "failed",
      ledger: 1006,
      successful: false,
      detail: "tx_bad_seq",
    });
    expect(failItem.observations.reason).toContain("tx_bad_seq");
    expect(failItem.requiresExecution).toBe(true);

    const confirmItem = plan.items[1];
    expect(confirmItem.currentState.finalityStatus).toBe("CONFIRMING");
    expect(confirmItem.proposedState.finalityStatus).toBe("CONFIRMED");
    expect(confirmItem.observations.confirmationDepthMet).toBe(true);
    expect(confirmItem.proposedRepair.action).toBe("mark_confirmed");
    expect(confirmItem.proposedRepair.targetTable).toBe("tls_token_purchases");

    const pendingOkItem = plan.items[2];
    expect(pendingOkItem.proposedState.finalityStatus).toBe("CONFIRMING");
    expect(pendingOkItem.proposedRepair.action).toBe("none");
    expect(pendingOkItem.observations.pollResult).toEqual({
      outcome: "confirmed",
      ledger: 1007,
      successful: true,
    });
  });
});

describe("createDryRunRepairPlan", () => {
  it("uses fake Horizon transport and performs zero mutations during dry-run", async () => {
    const rec = makeRecord({ id: "rec_dry", txHash: "hash_dry" });
    const pollTransaction = vi.fn().mockResolvedValue({
      outcome: "failed",
      ledger: 1010,
      successful: false,
      detail: "tx_insufficient_balance",
    } satisfies HorizonPollResult);

    const plan = await createDryRunRepairPlan(BASE_CONFIG, {
      fetchCurrentLedger: vi.fn().mockResolvedValue(1012),
      pollTransaction,
      loadCandidateRecords: vi.fn().mockResolvedValue([rec]),
      now: () => NOW,
    });

    expect(plan).not.toBeNull();
    expect(pollTransaction).toHaveBeenCalledWith("hash_dry", BASE_CONFIG.horizonUrl);
    expect(plan!.items[0].proposedState.finalityStatus).toBe("FAILED");
    expect(plan!.items[0].observations.currentLedger).toBe(1012);
  });

  it("returns null when Horizon is unreachable", async () => {
    const plan = await createDryRunRepairPlan(BASE_CONFIG, {
      fetchCurrentLedger: vi.fn().mockResolvedValue(null),
      pollTransaction: vi.fn(),
      loadCandidateRecords: vi.fn(),
    });
    expect(plan).toBeNull();
  });
});

describe("executeRepairPlan", () => {
  it("executes ONLY explicitly selected records from an unchanged plan", async () => {
    const rec1 = makeRecord({ id: "rec_1", txHash: "hash_1", sourceId: "job_1" });
    const rec2 = makeRecord({ id: "rec_2", txHash: "hash_2", sourceId: "job_2" });

    const plan = buildPaymentRepairPlan(
      [rec1, rec2],
      new Map<string, HorizonPollResult | null>([
        ["rec_1", { outcome: "failed", ledger: 1005, successful: false, detail: "tx_failed" }],
        ["rec_2", { outcome: "failed", ledger: 1006, successful: false, detail: "tx_failed" }],
      ]),
      1010,
      BASE_CONFIG,
      NOW,
    );

    const updates: Array<{ id: string; update: TxRecordUpdate }> = [];
    const repairedIds: string[] = [];

    const result = await executeRepairPlan(
      plan,
      { planHash: plan.planHash, selectedRecordIds: ["rec_1"] },
      {
        loadRecordsByIds: vi.fn().mockResolvedValue([rec1]),
        updateRecord: vi.fn(async (id, update) => {
          updates.push({ id, update });
        }),
        applyRepair: vi.fn(async (record) => {
          repairedIds.push(record.id);
          return { ok: true, repaired: true, detail: "Job status -> payment_failed" };
        }),
        now: () => NOW,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executedCount).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].recordId).toBe("rec_1");
      expect(result.items[0].newStatus).toBe("FAILED");
      expect(result.items[0].repairApplied).toBe(true);
    }
    expect(repairedIds).toEqual(["rec_1"]);
    expect(updates.every((u) => u.id === "rec_1")).toBe(true);
  });

  it("rejects execution if the plan was modified (PLAN_MODIFIED) with zero writes", async () => {
    const rec1 = makeRecord({ id: "rec_1", txHash: "hash_1" });
    const plan = buildPaymentRepairPlan(
      [rec1],
      new Map([["rec_1", { outcome: "failed", ledger: 1005, successful: false }]]),
      1010,
      BASE_CONFIG,
      NOW,
    );

    // Mutate the plan after generation
    const tamperedPlan = {
      ...plan,
      items: [
        {
          ...plan.items[0],
          proposedState: {
            ...plan.items[0].proposedState,
            finalityStatus: "CONFIRMED" as const,
          },
        },
      ],
    };

    const updateRecord = vi.fn();
    const applyRepair = vi.fn();

    const result = await executeRepairPlan(
      tamperedPlan,
      { planHash: plan.planHash, selectedRecordIds: ["rec_1"] },
      {
        loadRecordsByIds: vi.fn().mockResolvedValue([rec1]),
        updateRecord,
        applyRepair,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PLAN_MODIFIED");
    }
    expect(updateRecord).not.toHaveBeenCalled();
    expect(applyRepair).not.toHaveBeenCalled();
  });

  it("rejects execution if a selected record changed since dry-run (RECORD_CHANGED) with zero writes", async () => {
    const rec1 = makeRecord({ id: "rec_1", txHash: "hash_1", pollCount: 0 });
    const plan = buildPaymentRepairPlan(
      [rec1],
      new Map([["rec_1", { outcome: "failed", ledger: 1005, successful: false }]]),
      1010,
      BASE_CONFIG,
      NOW,
    );

    // Simulate concurrent update to rec_1 in DB
    const driftedRec1 = { ...rec1, pollCount: 1 };
    const updateRecord = vi.fn();
    const applyRepair = vi.fn();

    const result = await executeRepairPlan(
      plan,
      { planHash: plan.planHash, selectedRecordIds: ["rec_1"] },
      {
        loadRecordsByIds: vi.fn().mockResolvedValue([driftedRec1]),
        updateRecord,
        applyRepair,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("RECORD_CHANGED");
      expect(result.changedRecordIds).toEqual(["rec_1"]);
    }
    expect(updateRecord).not.toHaveBeenCalled();
    expect(applyRepair).not.toHaveBeenCalled();
  });

  it("rejects execution when selection is empty or contains unknown record IDs", async () => {
    const rec1 = makeRecord({ id: "rec_1", txHash: "hash_1" });
    const plan = buildPaymentRepairPlan(
      [rec1],
      new Map([["rec_1", { outcome: "failed", ledger: 1005, successful: false }]]),
      1010,
      BASE_CONFIG,
      NOW,
    );

    const emptyRes = await executeRepairPlan(
      plan,
      { planHash: plan.planHash, selectedRecordIds: [] },
      { loadRecordsByIds: vi.fn().mockResolvedValue([]), updateRecord: vi.fn(), applyRepair: vi.fn() },
    );
    expect(emptyRes.ok).toBe(false);
    if (!emptyRes.ok) expect(emptyRes.code).toBe("INVALID_SELECTION");

    const unknownRes = await executeRepairPlan(
      plan,
      { planHash: plan.planHash, selectedRecordIds: ["rec_unknown"] },
      { loadRecordsByIds: vi.fn().mockResolvedValue([]), updateRecord: vi.fn(), applyRepair: vi.fn() },
    );
    expect(unknownRes.ok).toBe(false);
    if (!unknownRes.ok) expect(unknownRes.code).toBe("INVALID_SELECTION");
  });
});
