/**
 * test(web): service-settlement failure matrix
 *
 * Deterministic unit tests for POST /api/talos/[id]/service covering the
 * settlement failure classes described in #418:
 *   - invalid payment payloads and mismatched recipient or amount
 *   - facilitator rejection, timeout, and upstream 5xx responses
 *   - settlement success followed by persistence failure
 *
 * Everything (auth, DB, x402 verification/settlement, fulfillment) is mocked
 * or fixture-driven — no live Stellar or facilitator services are touched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/talos/[id]/service/route";

const mocks = vi.hoisted(() => ({
  resolveTalosFromRequest: vi.fn(),
  verifyX402Payment: vi.fn(),
  settleX402Payment: vi.fn(),
  fulfillInstant: vi.fn(),
  withTransactionRetry: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  resolveTalosFromRequest: mocks.resolveTalosFromRequest,
}));

vi.mock("@/lib/stellar-x402", () => ({
  verifyX402Payment: mocks.verifyX402Payment,
  settleX402Payment: mocks.settleX402Payment,
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: mocks.fulfillInstant,
}));

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: mocks.withTransactionRetry,
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mocks.select(...args),
    insert: (...args: unknown[]) => mocks.insert(...args),
  },
}));

const SERVICE = {
  id: "svc-1",
  talosId: "seller-1",
  serviceName: "trend_research",
  description: "Research market trends",
  price: "5.00",
  currency: "USDC",
  stellarPublicKey: "PAYEE_PUBLIC_KEY",
  chains: ["stellar"],
  fulfillmentMode: "instant",
};

const PROVIDER = { agentWalletAddress: "AGENT_WALLET_ADDR" };

// Drizzle query-builder look-alike: .from().where().limit() are chainable and
// the builder is thenable, resolving to the fixture row set for this call.
function chain(result: unknown): any {
  const c: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve?: (value: unknown) => unknown) => {
      if (resolve) return Promise.resolve(resolve(result));
      return Promise.resolve(result);
    }),
  };
  return c;
}

function makePostRequest(overrides?: {
  body?: unknown;
  xPayment?: string | null;
  auth?: boolean;
}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (overrides?.auth !== false) headers.Authorization = "Bearer buyer-key";
  if (overrides?.xPayment !== null) {
    headers["X-PAYMENT"] = overrides?.xPayment ?? "x402 valid-payment-token";
  }
  return new NextRequest("http://localhost/api/talos/seller-1/service", {
    method: "POST",
    headers,
    body: JSON.stringify(overrides?.body ?? { payload: { topic: "web3" } }),
  });
}

let selectResults: unknown[];

describe("POST /api/talos/[id]/service — service-settlement failure matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTalosFromRequest.mockResolvedValue({ ok: true, talos: { id: "buyer-1" } });
    mocks.verifyX402Payment.mockResolvedValue(true);
    mocks.settleX402Payment.mockResolvedValue({ txHash: "tx-hash-abc" });
    mocks.fulfillInstant.mockResolvedValue({ summary: "ok" });

    // select #1 = service, #2 = provider talos, #3 = replay check (none)
    selectResults = [[SERVICE], [PROVIDER], []];
    mocks.select.mockImplementation(() => chain(selectResults.shift()));
  });

  describe("invalid payment payloads and mismatched recipient or amount", () => {
    it("returns 400 when the X-PAYMENT header is missing", async () => {
      const response = await POST(makePostRequest({ xPayment: null }), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("Missing X-PAYMENT header");
      expect(mocks.verifyX402Payment).not.toHaveBeenCalled();
      expect(mocks.settleX402Payment).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("returns 402 for an invalid x402 payment token", async () => {
      mocks.verifyX402Payment.mockResolvedValue(false);

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toBe("Invalid or insufficient x402 payment");
      expect(mocks.settleX402Payment).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("returns 402 and never settles when recipient or amount mismatches the service", async () => {
      mocks.verifyX402Payment.mockResolvedValue(false);

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toBe("Invalid or insufficient x402 payment");

      // Route must enforce the listed price and payee (token signed for a
      // different amount/recipient fails verification and is never settled).
      expect(mocks.verifyX402Payment).toHaveBeenCalledWith(
        "valid-payment-token",
        "5.00",
        "PAYEE_PUBLIC_KEY",
      );
      expect(mocks.settleX402Payment).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });
  });

  describe("facilitator rejection, timeout, and upstream 5xx", () => {
    it.each([
      ["facilitator rejects the settlement", new Error("settlement rejected by facilitator")],
      ["facilitator times out", new Error("upstream request timed out")],
      ["facilitator returns an upstream 5xx", new Error("x402 settle failed: 503 Service Unavailable")],
    ])("returns 502 when %s — no false completed purchase", async (_label, settleError) => {
      mocks.settleX402Payment.mockRejectedValue(settleError);

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBe("On-chain payment settlement failed");

      // A failed settlement must never be reported as a completed purchase.
      expect(mocks.fulfillInstant).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });
  });

  describe("settlement success followed by persistence failure", () => {
    it("returns 500 when the payment settles but the instant job transaction fails", async () => {
      mocks.withTransactionRetry.mockRejectedValue(new Error("DB connection lost"));

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
      expect(body.status).not.toBe("completed");

      // Settlement succeeded on-chain but no completed purchase is returned.
      expect(mocks.settleX402Payment).toHaveBeenCalledWith("valid-payment-token");
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("returns 500 when the payment settles but the async job insert fails", async () => {
      selectResults = [[{ ...SERVICE, fulfillmentMode: "async" }], [PROVIDER], []];
      mocks.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error("db unavailable")),
        }),
      });

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Internal server error");
      expect(body.status).not.toBe("completed");
    });
  });

  describe("replay prevention and happy path", () => {
    it("rejects a replayed payment token with 409 before verifying or settling", async () => {
      selectResults = [[SERVICE], [PROVIDER], [{ id: "existing-job-1" }]];

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("replay detected");
      expect(mocks.verifyX402Payment).not.toHaveBeenCalled();
      expect(mocks.settleX402Payment).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("records a completed purchase on the happy path", async () => {
      mocks.withTransactionRetry.mockImplementation(async (cb: (tx: any) => Promise<unknown[]>) => {
        return cb({
          insert: () => ({
            values: () => ({
              returning: vi.fn().mockResolvedValue([{ id: "job-1" }]),
            }),
          }),
        });
      });

      const response = await POST(makePostRequest(), {
        params: Promise.resolve({ id: "seller-1" }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe("completed");
      expect(body.jobId).toBe("job-1");
      expect(body.txHash).toBe("tx-hash-abc");
      expect(mocks.verifyX402Payment).toHaveBeenCalledWith(
        "valid-payment-token",
        "5.00",
        "PAYEE_PUBLIC_KEY",
      );
    });
  });
});
