import { vi, describe, it, expect, beforeEach } from "vitest";
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

  return {
    mockFindFirstTalos: vi.fn(),
    mockFindFirstRevenue: vi.fn(),
    mockFindFirstPatrons: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
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
  mockFindFirstRevenue,
  mockFindFirstPatrons,
  mockInsert,
  mockUpdate,
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
        tlsRevenues: {
          findFirst: (...args: any[]) => mocks.mockFindFirstRevenue(...args),
        },
        tlsPatrons: {
          findFirst: (...args: any[]) => mocks.mockFindFirstPatrons(...args),
        },
      },
      insert: (...args: any[]) => mocks.mockInsert(...args),
      update: (...args: any[]) => mocks.mockUpdate(...args),
    },
  };
});

vi.mock("@/lib/stellar", () => {
  return {
    getAccountInfo: (...args: any[]) => mocks.mockGetAccountInfo(...args),
    getNetworkPassphrase: (...args: any[]) => mocks.mockGetNetworkPassphrase(...args),
    getUSDCIssuer: (...args: any[]) => mocks.mockGetUSDCIssuer(...args),
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
    // Mock existing revenue record with the same txHash
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstRevenue.mockResolvedValue({
      id: "rev-123",
      txHash: "duplicate-tx-hash",
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

    expect(response.status).toBe(409);
    expect(body.error).toContain("replay");
  });

  it("returns 400 Bad Request if transaction is not found on Horizon", async () => {
    mockFindFirstTalos.mockResolvedValue({
      id: "agent-id",
      pulsePrice: "1.0",
    });
    mockFindFirstRevenue.mockResolvedValue(null);

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
    mockFindFirstRevenue.mockResolvedValue(null);

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
    mockFindFirstRevenue.mockResolvedValue(null);

    // Build a transaction signed by a different key than the claimed buyerPublicKey
    const buyerKeypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const sourceAccount = new Account(otherKeypair.publicKey(), "123456789012345");
    const usdcAsset = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: operatorTreasury,
          asset: usdcAsset,
          amount: "10.0000000",
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(otherKeypair);

    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: otherKeypair.publicKey(),
      envelope_xdr: tx.toXDR(),
    });

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey: buyerKeypair.publicKey(), // claim to be buyer, but transaction source is otherKeypair
        amount: 10,
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
    mockFindFirstRevenue.mockResolvedValue(null);

    const buyerKeypair = Keypair.random();
    const buyerPublicKey = buyerKeypair.publicKey();
    const sourceAccount = new Account(buyerPublicKey, "123456789012345");
    const usdcAsset = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    // Invalid Destination (pays to another user instead of Operator Treasury)
    const txWrongDest = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: usdcAsset,
          amount: "10.0000000",
        })
      )
      .setTimeout(60)
      .build();
    txWrongDest.sign(buyerKeypair);

    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: buyerPublicKey,
      envelope_xdr: txWrongDest.toXDR(),
    });

    const request = new Request("http://localhost/api/talos/agent-id/buy-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerPublicKey,
        amount: 10, // expecting 10 USDC
        txHash: "valid-tx-hash",
      }),
    });

    const params = Promise.resolve({ id: "agent-id" });
    const response = await POST(request, { params });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("No matching USDC payment");
  });

  it("processes happy path successfully, issuing Mitos tokens on valid payment details", async () => {
    const mockTalos = {
      id: "agent-id",
      pulsePrice: "0.5",
      stellarAssetCode: "MITOS:GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
      minPatronPulse: 100,
      agentWalletAddress: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
      tokenSymbol: "MITOS",
    };
    mockFindFirstTalos.mockResolvedValue(mockTalos);
    mockFindFirstRevenue.mockResolvedValue(null);
    mockFindFirstPatrons.mockResolvedValue(null);

    mockGetAccountInfo.mockResolvedValue({
      exists: true,
      xlmBalance: "100",
      usdcBalance: "1000",
    });

    const buyerKeypair = Keypair.random();
    const buyerPublicKey = buyerKeypair.publicKey();
    const sourceAccount = new Account(buyerPublicKey, "123456789012345");
    const usdcAsset = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    // Total cost for 10 tokens at 0.5 USDC = 5 USDC
    const totalCost = 5;

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: operatorTreasury,
          asset: usdcAsset,
          amount: "5.0000000",
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(buyerKeypair);

    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: buyerPublicKey,
      envelope_xdr: tx.toXDR(),
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
        buyerPublicKey,
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
