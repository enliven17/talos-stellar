import { describe, expect, it } from "vitest";

describe("soroban read-only helper", () => {
  it("builds a transaction using a valid Stellar source account", async () => {
    const { TransactionBuilder, Account, BASE_FEE, Networks, Operation, Asset } = await import("@stellar/stellar-sdk");

    const dummy = new Account(
      "GB72TS4AZNAIV2UB4SMZDFOJ6UX5VW4WKEW7RM63PV54YL5OKJHN7KK6",
      "0",
    );

    const operation = Operation.payment({
      destination: dummy.accountId(),
      asset: Asset.native(),
      amount: "0.0000001",
    });

    const tx = new TransactionBuilder(dummy, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    expect(tx).toBeDefined();
    expect(tx.source).toBe(dummy.accountId());
    expect(tx.operations).toHaveLength(1);
  });
});
