import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMocks = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  getAccount: vi.fn(),
  prepareTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
  nativeToScVal: vi.fn((value: unknown, options: unknown) => ({ value, options })),
  scValToNative: vi.fn((value: unknown) => value),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockContract {
    constructor(readonly contractId: string) {}
    call(method: string, ...args: unknown[]) {
      return { contractId: this.contractId, method, args };
    }
  }

  class MockAccount {
    constructor(
      readonly publicKey: string,
      readonly sequence: string,
    ) {}
  }

  class MockTransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {};
    }
    static fromXDR(xdr: string) {
      return { signedXdr: xdr };
    }
  }

  class MockServer {
    simulateTransaction = rpcMocks.simulateTransaction;
    getAccount = rpcMocks.getAccount;
    prepareTransaction = rpcMocks.prepareTransaction;
    sendTransaction = rpcMocks.sendTransaction;
    getTransaction = rpcMocks.getTransaction;
  }

  return {
    ...actual,
    Account: MockAccount,
    Contract: MockContract,
    TransactionBuilder: MockTransactionBuilder,
    nativeToScVal: rpcMocks.nativeToScVal,
    scValToNative: rpcMocks.scValToNative,
    rpc: { ...actual.rpc, Server: MockServer },
  };
});

let getEpoch: typeof import("../src/lib/soroban").getEpoch;
let getNextEpochId: typeof import("../src/lib/soroban").getNextEpochId;
let getTalosPatron: typeof import("../src/lib/soroban").getTalosPatron;
let hasClaimed: typeof import("../src/lib/soroban").hasClaimed;
let submitDividendClaim: typeof import("../src/lib/soroban").submitDividendClaim;

describe("TalosDividends read helpers", () => {
  beforeAll(async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_TALOS_DIVIDENDS_CONTRACT",
      "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    vi.stubEnv(
      "NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT",
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    ({
      getEpoch,
      getNextEpochId,
      getTalosPatron,
      hasClaimed,
      submitDividendClaim,
    } = await import("../src/lib/soroban"));
  });

  beforeEach(() => {
    rpcMocks.simulateTransaction.mockReset();
    rpcMocks.nativeToScVal.mockClear();
    rpcMocks.scValToNative.mockImplementation((value) => value);
    rpcMocks.simulateTransaction.mockResolvedValue({
      result: { retval: null },
    });
    rpcMocks.getAccount.mockResolvedValue({
      accountId: () => "GCLAIMANT",
      sequenceNumber: () => "1",
    });
    rpcMocks.prepareTransaction.mockResolvedValue({
      toXDR: () => "unsigned-xdr",
    });
    rpcMocks.sendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: "submitted-hash",
    });
    rpcMocks.getTransaction.mockResolvedValue({ status: "SUCCESS" });
  });

  it("reads and normalizes an epoch record", async () => {
    rpcMocks.simulateTransaction.mockResolvedValue({
      result: {
        retval: {
          epoch_id: BigInt(3),
          talos_id: 12,
          total_amount: BigInt(5000),
          claimed_amount: BigInt(1000),
          created_at: BigInt(1_800_000_000),
          expiry_secs: BigInt(86_400),
        },
      },
    });

    await expect(getEpoch(12, BigInt(3))).resolves.toEqual({
      epochId: BigInt(3),
      talosId: 12,
      totalAmount: BigInt(5000),
      claimedAmount: BigInt(1000),
      createdAt: BigInt(1_800_000_000),
      expirySecs: BigInt(86_400),
    });
    expect(rpcMocks.nativeToScVal).toHaveBeenNthCalledWith(1, 12, { type: "u32" });
    expect(rpcMocks.nativeToScVal).toHaveBeenNthCalledWith(
      2,
      BigInt(3),
      { type: "u64" },
    );
  });

  it("returns null for an uncommitted epoch", async () => {
    await expect(getEpoch(12, 4)).resolves.toBeNull();
  });

  it("reads the next sequential epoch ID as a bigint", async () => {
    rpcMocks.simulateTransaction.mockResolvedValue({
      result: { retval: BigInt(9) },
    });

    await expect(getNextEpochId(12)).resolves.toBe(BigInt(9));
    expect(rpcMocks.nativeToScVal).toHaveBeenCalledWith(12, { type: "u32" });
  });

  it("reads canonical patron role addresses and shares from the registry", async () => {
    rpcMocks.simulateTransaction.mockResolvedValue({
      result: {
        retval: {
          patron: {
            creator_addr: "GCREATOR",
            investor_addr: "GINVESTOR",
            treasury_addr: "GTREASURY",
            creator_share: 60,
            investor_share: 25,
            treasury_share: 15,
          },
        },
      },
    });

    await expect(getTalosPatron(12)).resolves.toEqual({
      creatorAddress: "GCREATOR",
      investorAddress: "GINVESTOR",
      treasuryAddress: "GTREASURY",
      creatorShare: 60,
      investorShare: 25,
      treasuryShare: 15,
    });
  });

  it("reads the caller's claimed state", async () => {
    rpcMocks.simulateTransaction.mockResolvedValue({
      result: { retval: true },
    });

    await expect(
      hasClaimed(BigInt(3), "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    ).resolves.toBe(true);
    expect(rpcMocks.nativeToScVal).toHaveBeenNthCalledWith(
      1,
      BigInt(3),
      { type: "u64" },
    );
    expect(rpcMocks.nativeToScVal).toHaveBeenNthCalledWith(
      2,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      { type: "address" },
    );
  });

  it("surfaces Soroban RPC simulation errors", async () => {
    rpcMocks.simulateTransaction.mockResolvedValue({
      error: "RPC unavailable",
    });

    await expect(getNextEpochId(12)).rejects.toThrow("RPC unavailable");
  });

  it("builds the claim with registry arguments and signs only through the wallet callback", async () => {
    const signTransaction = vi.fn(async (xdr: string) => `signed:${xdr}`);
    const claim = {
      claimant: "GCLAIMANT",
      talosId: 12,
      epochId: BigInt(3),
      patronCreator: "GCREATOR",
      patronInvestor: "GINVESTOR",
      patronTreasury: "GTREASURY",
      creatorShare: 60,
      investorShare: 25,
      treasuryShare: 15,
    };

    await expect(submitDividendClaim(claim, signTransaction)).resolves.toBe(
      "submitted-hash",
    );
    expect(signTransaction).toHaveBeenCalledWith("unsigned-xdr");
    expect(rpcMocks.sendTransaction).toHaveBeenCalledWith({
      signedXdr: "signed:unsigned-xdr",
    });
    expect(rpcMocks.getTransaction).toHaveBeenCalledWith("submitted-hash");
  });
});
