import { vi, describe, it, expect, beforeEach } from "vitest";
import fixtures from "./fixtures/x402-payments.json";
import { POST } from "../src/app/api/talos/[id]/buy-token/route";
import { Keypair, Asset, TransactionBuilder, Operation, Networks, Account } from "@stellar/stellar-sdk";
import { OPERATOR_PUBLIC_KEY } from "../src/lib/stellar-config";

// Use vi.hoisted to declare mock functions so they are hoisted along with the vi.mock calls,
// preventing any TypeScript linting or execution scoping warnings.
const mocks = vi.hoisted(() => {
  const transactionCall = vi.fn();
  const submitTransaction = vi.fn();
  const transactions = vi.fn(() => ({
    transaction: vi.fn(() => ({
      call: transactionCall,
    })),
  }));

  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
    });
  });

  return {
    mockFindFirstTalos: vi.fn(),
    mockFindFirstTokenPurchase: vi.fn(),
    mockFindFirstPatrons: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTransaction,
    mockGetAccountInfo: vi.fn(),
    mockGetNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
    mockGetUSDCIssuer: vi.fn(() => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
    mockTransactionCall: transactionCall,
    mockTransactions: transactions,
    mockSubmitTransaction: submitTransaction,
  };
});

const {
  mockFindFirstTalos,
  mockFindFirstTokenPurchase,
  mockFindFirstPatrons,
  mockInsert,
  mockUpdate,
  mockTransaction,
  mockGetAccountInfo,
  mockGetNetworkPassphrase,
  mockGetUSDCIssuer,
  mockTransactionCall,
  mockTransactions,
  mockSubmitTransaction,
} = mocks;

vi.mock("@/db", () => {
  return {
    db: {
      query: {
        tlsTalos: {
          findFirst: (...args: any[]) => mocks.mockFindFirstTalos(...args),
        },
        tlsTokenPurchases: {
          findFirst: (...args: any[]) => mocks.mockFindFirstTokenPurchase(...args),
        },
        tlsPatrons: {
          findFirst: (...args: any[]) => mocks.mockFindFirstPatrons(...args),
        },
      },
      insert: (...args: any[]) => mocks.mockInsert(...args),
      update: (...args: any[]) => mocks.mockUpdate(...args),
      transaction: (cb: any) => mocks.mockTransaction(cb),
    },
  };
});

vi.mock("@/lib/stellar", () => {
  return {
    getAccountInfo: (...args: any[]) => mocks.mockGetAccountInfo(...args),
            getNetworkPassphrase: () => mocks.mockGetNetworkPassphrase(),
    getUSDCIssuer: () => mocks.mockGetUSDCIssuer(),
  };
});

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...original,
    Horizon: {
      Server: class {
        loadAccount = vi.fn().mockImplementation(async (publicKey: string) => {
          const account = new Account(publicKey, "12345");
          (account as any).balances = [{ asset_type: "native", balance: "100" }];
          return account;
        });
        transactions = mocks.mockTransactions;
        submitTransaction = (...args: any[]) => mocks.mockSubmitTransaction(...args);
      },
    },
  };
});

describe("POST /api/talos/[id]/buy-token — Verification Tests", () => {
  const operatorTreasury = OPERATOR_PUBLIC_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    });
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  it("returns 409 Conflict if txHash has already been processed (duplicate/replay)", async () => {
    // Mock existing purchase record with the same txHash (status=completed)
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstTokenPurchase.mockResolvedValue({
      txHash: "duplicate-tx-hash",
      status: "completed",
      responseBody: {
        success: true,
        txHash: "duplicate-tx-hash",
        mitosTxHash: null,
        tokenSymbol: "MITOS",
        amount: 10,
        pricePerToken: 1.0,
        totalCost: 10,
        currency: "USDC",
        buyerPublicKey: "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
        totalPulseHeld: 10,
        patronStatus: "pending (need 90 more MITOS)",
        message: "Successfully purchased 10 MITOS for 10.00 USDC",
      },
    });

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
        amount: 10,
        txHash: "duplicate-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    // Returns 200 with cached response (idempotent replay, not an error)
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.txHash).toBe("duplicate-tx-hash");
    // No Horizon call or DB writes
    expect(mockTransactionCall).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 Bad Request if transaction is not found on Horizon", async () => {
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstTokenPurchase.mockResolvedValue(null);

    // Mock Horizon call throwing an error (transaction not found)
    mockTransactionCall.mockRejectedValue(new Error("Horizon error: 404 Not Found"));

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
        amount: 10,
        txHash: "missing-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Stellar network");
  });

  it("returns 400 Bad Request if the transaction was not successful on-chain", async () => {
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstTokenPurchase.mockResolvedValue(null);

    mockTransactionCall.mockResolvedValue({
      successful: false,
      source_account: "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
    });

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
        amount: 10,
        txHash: "failed-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("was not successful");
  });

  it("returns 400 Bad Request if transaction source_account does not match buyerPublicKey", async () => {
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstTokenPurchase.mockResolvedValue(null);

    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: "some-other-public-key", // Not the buyer
      envelope_xdr: fixtures.valid,
    });

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: fixtures.metadata.senderPublicKey, // claim to be buyer, but transaction source is otherKeypair
        amount: 1.5,
        txHash: "valid-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("signer does not match");
  });

  it("returns 400 Bad Request if the payment destination, asset, or amount mismatch", async () => {
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstTokenPurchase.mockResolvedValue(null);

    // Invalid Destination (pays to another user instead of Operator Treasury)
    mockTransactionCall.mockResolvedValueOnce({
      successful: true,
      source_account: fixtures.metadata.senderPublicKey,
      envelope_xdr: fixtures.invalidWrongRecipient,
    });

    const requestWrongDest = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: fixtures.metadata.senderPublicKey,
        amount: 1.5,
        txHash: "wrong-dest-tx",
      }),
    });

    const paramsWrongDest = Promise.resolve({ id: "agent-id" });
    const responseWrongDest = await POST(requestWrongDest, { params: paramsWrongDest });
    const bodyWrongDest = await responseWrongDest.json();

    expect(responseWrongDest.status).toBe(400);
    expect(bodyWrongDest.error).toContain("No matching USDC payment");
  });

  it("processes happy path successfully, issuing Mitos tokens on valid payment details", async () => {
    const mockTalos = {
      id: "agent-id",
      pulsePrice: "0.15",
      stellarAssetCode: "MITOS:GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
      minPatronPulse: 100,
      agentWalletAddress: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
      tokenSymbol: "MITOS",
    };
    mockFindFirstTalos.mockResolvedValue(mockTalos);
    mockFindFirstTokenPurchase.mockResolvedValue(null);
    mockFindFirstPatrons.mockResolvedValue(null);

    mockGetAccountInfo.mockResolvedValue({
      exists: true,
      xlmBalance: "100",
      usdcBalance: "1000",
    });

    // Total cost for 10 tokens at 0.15 USDC = 1.5 USDC
    const totalCost = 1.5;

    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: fixtures.metadata.senderPublicKey,
      envelope_xdr: fixtures.valid,
    });

    mockSubmitTransaction.mockResolvedValue({
      hash: "mitos-transfer-tx-hash",
    });

    // Mock operator secret key
    process.env.STELLAR_OPERATOR_SECRET_KEY = Keypair.random().secret();

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: fixtures.metadata.senderPublicKey,
        amount: 10,
        txHash: "valid-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mitosTxHash).toBe("mitos-transfer-tx-hash");
    expect(body.totalCost).toBe(totalCost);
    expect(mockInsert).toHaveBeenCalled();
  });
});
