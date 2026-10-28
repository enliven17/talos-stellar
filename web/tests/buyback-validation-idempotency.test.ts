/**
 * Validation + idempotency tests for POST /api/talos/[id]/revenue/buyback
 *
 *   validation  — string / NaN / Infinity / negative / zero / >7 decimals / malformed JSON → 400
 *   success     — valid body submits exactly one Stellar transfer and records revenue
 *   replay      — same Idempotency-Key returns the original response, no second transfer
 *   guards      — pending → 409, key reused with different body → 422, failed → retried
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/talos/[id]/revenue/buyback/route";
import { buybackSchema } from "../src/lib/schemas";

const mocks = vi.hoisted(() => ({
  findTalos: vi.fn(),
  findBuyback: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  txInsert: vi.fn(),
  txUpdate: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: { findFirst: (...a: unknown[]) => mocks.findTalos(...a) },
      tlsBuybackRequests: { findFirst: (...a: unknown[]) => mocks.findBuyback(...a) },
    },
    insert: (...a: unknown[]) => mocks.insert(...a),
    update: (...a: unknown[]) => mocks.update(...a),
  },
}));

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      insert: (...a: unknown[]) => mocks.txInsert(...a),
      update: (...a: unknown[]) => mocks.txUpdate(...a),
    }),
  ),
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn(async () => ({ ok: true, talos: { id: "talos_1" } })),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn(function () {
        return {
          loadAccount: mocks.loadAccount,
          submitTransaction: mocks.submitTransaction,
        };
      }),
    },
  };
});

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const params = { params: Promise.resolve({ id: "talos_1" }) };

function chain() {
  return { values: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
}

function req(body: unknown, headers: Record<string, string> = {}, raw = false) {
  return new NextRequest("http://localhost/api/talos/talos_1/revenue/buyback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const valid = { usdcAmount: 5, mitosAmount: 100 };

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.STELLAR_OPERATOR_SECRET_KEY = (await import("@stellar/stellar-sdk")).Keypair.random().secret();
  mocks.findTalos.mockResolvedValue({ id: "talos_1", stellarAssetCode: `MITOS:${ISSUER}` });
  mocks.findBuyback.mockResolvedValue(undefined);
  mocks.insert.mockReturnValue(chain());
  mocks.update.mockReturnValue(chain());
  mocks.txInsert.mockReturnValue(chain());
  mocks.txUpdate.mockReturnValue(chain());
  const { Account, Keypair } = await import("@stellar/stellar-sdk");
  mocks.loadAccount.mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
  mocks.submitTransaction.mockResolvedValue({ hash: "a".repeat(64) });
});

describe("buybackSchema", () => {
  it.each([
    ["string amount", { usdcAmount: "5", mitosAmount: 100 }],
    ["NaN", { usdcAmount: NaN, mitosAmount: 100 }],
    ["Infinity", { usdcAmount: 5, mitosAmount: Infinity }],
    ["negative", { usdcAmount: -1, mitosAmount: 100 }],
    ["zero", { usdcAmount: 0, mitosAmount: 100 }],
    ["8 decimals", { usdcAmount: 0.12345678, mitosAmount: 100 }],
    ["missing field", { usdcAmount: 5 }],
  ])("rejects %s", (_n, body) => {
    expect(buybackSchema.safeParse(body).success).toBe(false);
  });

  it("accepts positive finite numbers with up to 7 decimals", () => {
    expect(buybackSchema.safeParse({ usdcAmount: 0.1234567, mitosAmount: 1 }).success).toBe(true);
    expect(buybackSchema.safeParse({ usdcAmount: 0.0000001, mitosAmount: 250 }).success).toBe(true);
  });
});

describe("POST buyback — validation", () => {
  it.each([
    ["string amount", { usdcAmount: "5", mitosAmount: 100 }],
    ["negative amount", { usdcAmount: 5, mitosAmount: -100 }],
    ["too many decimals", { usdcAmount: 1.12345678, mitosAmount: 100 }],
  ])("returns 400 for %s and never touches Stellar", async (_n, body) => {
    const res = await POST(req(body), params);
    expect(res.status).toBe(400);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    const res = await POST(req("{not json", {}, true), params);
    expect(res.status).toBe(400);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty Idempotency-Key", async () => {
    const res = await POST(req(valid, { "idempotency-key": "   " }), params);
    expect(res.status).toBe(400);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });
});

describe("POST buyback — success", () => {
  it("submits one transfer and records revenue without a key", async () => {
    const res = await POST(req(valid), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, mitosBurned: 100, usdcSpent: 5 });
    expect(mocks.submitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.txInsert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled(); // no ledger row without a key
  });

  it("claims the key, transfers once, and completes the ledger row", async () => {
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Idempotent-Replayed")).toBe("false");
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.submitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("POST buyback — replay and guards", () => {
  const hash = async () =>
    (await import("node:crypto")).createHash("sha256").update("5:100").digest("hex");

  it("replays the original response with no second transfer", async () => {
    const original = { success: true, txHash: "b".repeat(64), mitosBurned: 100, usdcSpent: 5, message: "done" };
    mocks.findBuyback.mockResolvedValue({ status: "completed", requestHash: await hash(), responseBody: original });

    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(original);
    expect(res.headers.get("X-Idempotent-Replayed")).toBe("true");
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
    expect(mocks.txInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when the same key is still pending", async () => {
    mocks.findBuyback.mockResolvedValue({ status: "pending", requestHash: await hash(), responseBody: null });
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(409);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when a concurrent request wins the insert race", async () => {
    mocks.insert.mockReturnValue({ values: vi.fn().mockRejectedValue({ code: "23505" }) });
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(409);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("returns 422 when the key is reused with different amounts", async () => {
    mocks.findBuyback.mockResolvedValue({ status: "completed", requestHash: "different", responseBody: {} });
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(422);
    expect(mocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("retries a previously failed key", async () => {
    mocks.findBuyback.mockResolvedValue({ status: "failed", requestHash: await hash(), responseBody: null });
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(200);
    expect(mocks.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("marks the key failed when Horizon rejects the transfer", async () => {
    mocks.submitTransaction.mockRejectedValue({ response: { data: { extras: { result_codes: { operations: ["op_underfunded"] } } } } });
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("leaves the key pending on an ambiguous (non-Horizon) failure", async () => {
    mocks.submitTransaction.mockRejectedValue(new Error("socket hang up"));
    const res = await POST(req(valid, { "idempotency-key": "k-1" }), params);
    expect(res.status).toBe(500);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
