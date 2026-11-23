import { describe, it, expect } from "vitest";
import { generateTransitionReport } from "../src/lib/reconciler/report";
import type { TxRecord, ReconcilerConfig, ReconcilerObservation } from "../src/lib/reconciler/types";

const BASE_CONFIG: ReconcilerConfig = {
  enabled: true,
  pollIntervalMs: 30_000,
  maxLedgerGap: 10, // Small for testing
  notFoundThreshold: 3,
  batchSize: 50,
  horizonUrl: "https://horizon-testnet.stellar.org",
  confirmationDepth: 1,
};

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: "rec_1",
    txHash: "abc123def456",
    sourceType: "commerce_job",
    sourceId: "job_1",
    finalityStatus: "PENDING",
    ledgerSubmitted: 1000,
    lastLedgerChecked: null,
    confirmedLedger: null,
    pollCount: 0,
    lastError: null,
    repairApplied: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("generateTransitionReport", () => {
  it("replays a PENDING to CONFIRMED sequence", () => {
    const initialState = makeRecord();
    const observations: ReconcilerObservation[] = [
      {
        pollResult: { outcome: "confirmed", ledger: 1005, successful: true },
        currentLedger: 1005,
        now: new Date(),
      },
      {
        pollResult: null, // CONFIRMING ignores pollResult
        currentLedger: 1006,
        now: new Date(),
      },
    ];

    const report = generateTransitionReport(initialState, observations, BASE_CONFIG);

    expect(report.steps).toHaveLength(2);
    expect(report.steps[0].resultingState.finalityStatus).toBe("CONFIRMING");
    expect(report.steps[1].resultingState.finalityStatus).toBe("CONFIRMED");
  });

  it("replays a PENDING to EXPIRED (ledger gap) sequence", () => {
    const initialState = makeRecord({ ledgerSubmitted: 1000 });
    const observations: ReconcilerObservation[] = [
      {
        pollResult: { outcome: "not_found" },
        currentLedger: 1005,
        now: new Date(),
      },
      {
        pollResult: { outcome: "not_found" },
        currentLedger: 1011, // 1000 + 10 (gap) + 1 = 1011
        now: new Date(),
      },
    ];

    const report = generateTransitionReport(initialState, observations, BASE_CONFIG);

    expect(report.steps[1].resultingState.finalityStatus).toBe("EXPIRED");
    expect(report.steps[1].resultingState.lastError).toMatch(/ledger gap/i);
  });
});
