import { Keypair, Asset, TransactionBuilder, Operation, BASE_FEE, Networks } from "@stellar/stellar-sdk";
import { Horizon } from "@stellar/stellar-sdk";

const secret = process.env.STELLAR_OPERATOR_SECRET_KEY!;
const keypair = Keypair.fromSecret(secret);
const server = new Horizon.Server("https://horizon-testnet.stellar.org");
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

async function main() {
  console.log("Account:", keypair.publicKey());
  const account = await server.loadAccount(keypair.publicKey());

  const existing = (account.balances as any[]).find(
    (b) => b.asset_type !== "native" && b.asset_code === "USDC"
  );
  if (existing) {
    console.log("✓ Trustline already exists. Balance:", existing.balance, "USDC");
    return;
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const res = await server.submitTransaction(tx);
  console.log("✅ Trustline created:", res.hash);
  console.log("Now get testnet USDC from: https://friendbot-testnet.stellar.org (or Stellar lab faucet)");
}

main().catch(console.error);
