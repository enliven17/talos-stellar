import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/commerce/cross-chain-webhook/route";
import { tlsCommerceJobs, tlsRevenues } from "@/db/schema";

const WEBHOOK_SECRET = "test-cross-chain-secret";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
  fulfillInstant: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: mocks.fulfillInstant,
}));

// The ledger write has its own tests; here it only needs to succeed.
vi.mock("@/lib/reputation-ledger", () => ({
  ingestJobToLedger: vi.fn().mockResolvedValue(null),
}));

const { mockDb, fulfillInstant } = mocks;

const mockSelectChain = (result: unknown) => {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((callback) => callback(result)),
  };
  return chain;
};

function signPayload(timestamp: string | number, body: string) {
  return createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
}

function buildRequest(
  body: Record<string, unknown>,
  options?: {
    timestamp?: string | number | null;
    signature?: string | null;
  },
) {
  const rawBody = JSON.stringify(body);
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timestamp =
    options && "timestamp" in options ? options.timestamp : currentTimestamp;

  const signature =
    options && "signature" in options
      ? options.signature
      : timestamp !== null && timestamp !== undefined
        ? signPayload(timestamp, rawBody)
        : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (timestamp !== null && timestamp !== undefined) {
    headers["X-Signature-Timestamp"] = String(timestamp);
  }

  if (signature !== null && signature !== undefined) {
    headers["X-Signature"] = signature;
  }

  return new NextRequest("http://localhost:3000/api/commerce/cross-chain-webhook", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/commerce/cross-chain-webhook", () => {
  const previousSecret = process.env.CROSS_CHAIN_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CROSS_CHAIN_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.CROSS_CHAIN_WEBHOOK_SECRET;
    } else {
      process.env.CROSS_CHAIN_WEBHOOK_SECRET = previousSecret;
    }
  });

  it("rejects unauthenticated webhook calls", async () => {
    const request = new NextRequest("http://localhost:3000/api/commerce/cross-chain-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ talosId: "agent_1" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects requests with missing X-Signature-Timestamp header", async () => {
    const body = { talosId: "agent_1" };
    const rawBody = JSON.stringify(body);
    const legacySignature = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

    const request = new NextRequest("http://localhost:3000/api/commerce/cross-chain-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": legacySignature,
      },
      body: rawBody,
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Missing or invalid webhook timestamp");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects requests with stale timestamps outside tolerance", async () => {
    const body = { talosId: "agent_1" };
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301; // older than 5 minutes (300s)
    const request = buildRequest(body, { timestamp: staleTimestamp });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Webhook timestamp outside tolerance");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects requests with future timestamps outside tolerance", async () => {
    const body = { talosId: "agent_1" };
    const futureTimestamp = Math.floor(Date.now() / 1000) + 301; // more than 5 minutes in the future
    const request = buildRequest(body, { timestamp: futureTimestamp });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Webhook timestamp outside tolerance");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects invalid signature even with fresh timestamp", async () => {
    const body = { talosId: "agent_1" };
    const now = Math.floor(Date.now() / 1000);
    const request = buildRequest(body, { timestamp: now, signature: "invalidhex123456" });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Invalid webhook signature");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects non-hex characters in signature without throwing or partially decoding", async () => {
    const body = { talosId: "agent_1" };
    const now = Math.floor(Date.now() / 1000);
    const validSig = signPayload(now, JSON.stringify(body));
    // Replace characters with non-hex characters e.g. 'z'
    const nonHexSig = "z".repeat(64);
    const request = buildRequest(body, { timestamp: now, signature: nonHexSig });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Invalid webhook signature");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects signature containing trailing non-hex characters or odd length", async () => {
    const body = { talosId: "agent_1" };
    const now = Math.floor(Date.now() / 1000);
    const validSig = signPayload(now, JSON.stringify(body));
    // Valid 64 hex plus extra garbage or odd length
    const garbageSig = validSig.slice(0, 63) + "g";
    const request = buildRequest(body, { timestamp: now, signature: garbageSig });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const resBody = await response.json();
    expect(resBody.error).toBe("Invalid webhook signature");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("respects custom CROSS_CHAIN_WEBHOOK_TOLERANCE_SECONDS if configured", async () => {
    process.env.CROSS_CHAIN_WEBHOOK_TOLERANCE_SECONDS = "60";
    try {
      const body = { talosId: "agent_1" };
      const timestamp = Math.floor(Date.now() / 1000) - 70; // outside 60s, inside 300s
      const request = buildRequest(body, { timestamp });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const resBody = await response.json();
      expect(resBody.error).toBe("Webhook timestamp outside tolerance");
    } finally {
      delete process.env.CROSS_CHAIN_WEBHOOK_TOLERANCE_SECONDS;
    }
  });

  it("rejects invalid webhook payloads after signature verification", async () => {
    const body = {};
    const request = buildRequest(body);

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("creates a pending commerce job for verified async cross-chain payments", async () => {
    const mockTalos = { id: "agent_1" };
    const mockService = {
      id: "service_1",
      talosId: "agent_1",
      serviceName: "competitor_analysis",
      price: "10.0",
      currency: "USDC",
      fulfillmentMode: "async",
      chains: ["stellar", "base"],
    };
    const mockJob = {
      id: "job_1",
      status: "pending",
      serviceName: "competitor_analysis",
      txHash: "0xbase_tx_1",
      result: null,
    };

    mockDb.select
      .mockReturnValueOnce(mockSelectChain([mockTalos]))
      .mockReturnValueOnce(mockSelectChain([mockService]))
      .mockReturnValueOnce(mockSelectChain([]));

    const jobValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([mockJob]),
    });

    const mockTxInsert = vi.fn().mockReturnValue({
      values: jobValues,
    });

    mockDb.transaction.mockImplementation(async (callback) => {
      const tx = {
        insert: mockTxInsert,
      };
      return callback(tx);
    });

    const request = buildRequest({
      talosId: "agent_1",
      requesterTalosId: "human:0xBuyer",
      sourceChain: "base",
      destinationChain: "stellar",
      paymentReference: "bridge_payment_1",
      sourceTxHash: "0xbase_tx_1",
      amount: 10,
      currency: "USDC",
      simulatedVerified: true,
      payload: { company: "Acme" },
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.jobId).toBe("job_1");
    expect(body.status).toBe("pending");
    expect(body.bridge.sourceChain).toBe("base");

    expect(mockTxInsert).toHaveBeenCalledTimes(1);
    expect(mockTxInsert.mock.calls[0][0]).toBe(tlsCommerceJobs);
    expect(fulfillInstant).not.toHaveBeenCalled();
  });

  it("creates a completed commerce job and records revenue for verified instant cross-chain payments", async () => {
    const mockTalos = { id: "agent_2" };
    const mockService = {
      id: "service_2",
      talosId: "agent_2",
      serviceName: "product_review",
      price: "5.0",
      currency: "USDC",
      fulfillmentMode: "instant",
      chains: ["arbitrum", "stellar"],
    };
    const mockResult = { summary: "done" };
    const mockJob = {
      id: "job_2",
      status: "completed",
      serviceName: "product_review",
      txHash: "0xarb_tx_1",
      result: mockResult,
    };

    mockDb.select
      .mockReturnValueOnce(mockSelectChain([mockTalos]))
      .mockReturnValueOnce(mockSelectChain([mockService]))
      .mockReturnValueOnce(mockSelectChain([]));

    fulfillInstant.mockResolvedValue(mockResult);

    const jobValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([mockJob]),
    });
    const revenueValues = vi.fn().mockResolvedValue([]);

    const mockTxInsert = vi.fn((table: unknown) => {
      if (table === tlsCommerceJobs) {
        return { values: jobValues };
      }
      if (table === tlsRevenues) {
        return { values: revenueValues };
      }
      throw new Error("Unexpected table");
    });

    mockDb.transaction.mockImplementation(async (callback) => {
      const tx = {
        insert: mockTxInsert,
      };
      return callback(tx);
    });

    const request = buildRequest({
      talosId: "agent_2",
      requesterTalosId: "talos_requester_1",
      sourceChain: "arbitrum",
      destinationChain: "stellar",
      paymentReference: "bridge_payment_2",
      sourceTxHash: "0xarb_tx_1",
      amount: 5,
      currency: "USDC",
      simulatedVerified: true,
      payload: { product: "Widget" },
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.jobId).toBe("job_2");
    expect(body.status).toBe("completed");
    expect(body.result).toEqual(mockResult);

    expect(fulfillInstant).toHaveBeenCalledWith("product_review", { product: "Widget" });
    expect(mockTxInsert).toHaveBeenCalledTimes(2);
    expect(mockTxInsert.mock.calls[0][0]).toBe(tlsCommerceJobs);
    expect(mockTxInsert.mock.calls[1][0]).toBe(tlsRevenues);
    expect(revenueValues).toHaveBeenCalledWith({
      talosId: "agent_2",
      amount: "5.0",
      currency: "USDC",
      source: "commerce",
      txHash: "0xarb_tx_1",
    });
  });
});