import { describe, it, expect } from "vitest";
import {
  FINANCIAL_STATEMENT_CSV_HEADER,
  FINANCIAL_STATEMENT_SCHEMA_VERSION,
  buildOwnerFinancialStatement,
  financialStatementToCsv,
} from "../src/lib/financial-statement";

const baseInput = {
  talos: {
    id: "talos-1",
    name: "Alpha Corp",
    agentName: "alpha",
    observedAt: "2026-11-23T10:00:00.000Z",
  },
  generatedAt: "2026-11-23T12:00:00.000Z",
  from: "2026-11-01T00:00:00.000Z",
  to: "2026-11-23T12:00:00.000Z",
  network: "testnet",
  revenues: [
    {
      id: "rev-1",
      amount: "12.345678",
      source: "job-payment",
      txHash: "tx-rev-1",
      createdAt: "2026-11-21T09:00:00.000Z",
    },
  ],
  approvals: [
    {
      id: "apr-1",
      amount: "3.25",
      type: "withdrawal",
      title: "Treasury withdrawal",
      status: "approved",
      txHash: "tx-apr-1",
      createdAt: "2026-11-22T09:00:00.000Z",
    },
  ],
};

describe("owner financial statement builder", () => {
  it("records exact six-decimal amounts, statuses, and transaction hashes", () => {
    const statement = buildOwnerFinancialStatement(baseInput);

    expect(statement.schemaVersion).toBe(FINANCIAL_STATEMENT_SCHEMA_VERSION);
    expect(statement.talosId).toBe("talos-1");
    expect(statement.network).toBe("testnet");
    expect(statement.entries).toEqual([
      expect.objectContaining({
        id: "rev-1",
        category: "revenue",
        direction: "credit",
        amountUsdc: "12.345678",
        status: "recorded",
        bound: "observed",
        transactionHash: "tx-rev-1",
      }),
      expect.objectContaining({
        id: "apr-1",
        category: "approval",
        direction: "debit",
        amountUsdc: "3.250000",
        status: "approved",
        bound: "observed",
        transactionHash: "tx-apr-1",
      }),
    ]);
    expect(statement.totals).toEqual({
      creditsUsdc: "12.345678",
      debitsUsdc: "3.250000",
      netUsdc: "9.095678",
      unavailableEntries: 0,
    });
    expect(statement.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not invent zero for unobserved or invalid amounts", () => {
    const statement = buildOwnerFinancialStatement({
      ...baseInput,
      revenues: [
        { id: "rev-missing", amount: null, source: "unknown" },
        { id: "rev-zero", amount: "0", source: "empty-cycle" },
      ],
      approvals: [],
    });

    expect(statement.entries.map((entry) => [entry.id, entry.amountUsdc, entry.bound])).toEqual([
      ["rev-missing", null, "unavailable"],
      ["rev-zero", "0.000000", "observed"],
    ]);
    expect(statement.totals.unavailableEntries).toBe(1);
    expect(statement.totals.creditsUsdc).toBe("0.000000");
  });

  it("omits private credentials and internal notes even when present in raw rows", () => {
    const statement = buildOwnerFinancialStatement({
      ...baseInput,
      revenues: [
        {
          id: "rev-1",
          amount: "1",
          source: "job-payment",
          apiKey: "secret-key",
          internalNotes: "operator-only remark",
          secret: "seed-phrase",
        } as never,
      ],
      approvals: [
        {
          id: "apr-1",
          amount: "2",
          title: "Public title",
          description: "internal note",
          apiKey: "secret-key",
        } as never,
      ],
    });

    expect(JSON.stringify(statement)).not.toContain("secret-key");
    expect(JSON.stringify(statement)).not.toContain("operator-only remark");
    expect(JSON.stringify(statement)).not.toContain("seed-phrase");
    expect(JSON.stringify(statement)).not.toContain("internal note");
    expect(statement.privacy).toEqual({
      credentialsIncluded: false,
      internalNotesIncluded: false,
    });
  });

  it("preserves explicit statuses and sorts all activity by timestamp", () => {
    const statement = buildOwnerFinancialStatement({
      ...baseInput,
      approvals: [
        {
          id: "apr-old",
          amount: "1",
          title: "Old",
          status: "rejected",
          createdAt: "2026-11-20T00:00:00.000Z",
        },
        {
          id: "apr-new",
          amount: "1",
          title: "New",
          status: "pending",
          createdAt: "2026-11-23T00:00:00.000Z",
        },
      ],
    });

    expect(statement.entries.map((entry) => entry.id)).toEqual(["apr-old", "rev-1", "apr-new"]);
    expect(statement.entries.map((entry) => entry.status)).toEqual([
      "rejected",
      "recorded",
      "pending",
    ]);
  });

  it("caps rows and reports truncation instead of silently dropping activity", () => {
    const statement = buildOwnerFinancialStatement({
      ...baseInput,
      revenues: [
        { id: "rev-1", amount: "1" },
        { id: "rev-2", amount: "2" },
        { id: "rev-3", amount: "3" },
      ],
      approvals: [],
      maxRows: 2,
    });

    expect(statement.entries.map((entry) => entry.id)).toEqual(["rev-1", "rev-2"]);
    expect(statement.limits).toEqual({ truncated: true, maxRows: 2 });
  });

  it("derives a stable digest that changes when activity changes", () => {
    const before = buildOwnerFinancialStatement(baseInput);
    const after = buildOwnerFinancialStatement({
      ...baseInput,
      revenues: [{ ...baseInput.revenues[0], amount: "12.345679" }],
    });

    expect(before.digest).not.toBe(after.digest);
  });

  it("escapes CSV cells and neutralizes formula injection", () => {
    const statement = buildOwnerFinancialStatement({
      ...baseInput,
      revenues: [
        {
          id: "rev-1",
          amount: "1",
          source: "=cmd|'/c calc'!A0",
          createdAt: "2026-11-21T09:00:00.000Z",
        },
      ],
      approvals: [],
    });

    const csv = financialStatementToCsv(statement);
    expect(csv.split("\n")[0]).toBe(FINANCIAL_STATEMENT_CSV_HEADER);
    expect(csv).toContain("'=cmd|'/c calc'!A0");
    expect(csv).toContain("\"1.000000\"");
  });
});
