import { Horizon, Keypair } from "@stellar/stellar-sdk";

const secret = process.env.STELLAR_OPERATOR_SECRET_KEY!;
const keypair = Keypair.fromSecret(secret);
const server = new Horizon.Server("https://horizon-testnet.stellar.org");

async function main() {
  const account = await server.loadAccount(keypair.publicKey());
  console.log("Account:", keypair.publicKey(), "\n");
  console.log("All balances:");
  for (const b of account.balances as any[]) {
    if (b.asset_type === "native") {
      console.log(`  XLM: ${b.balance}`);
    } else {
      console.log(`  ${b.asset_code} | issuer: ${b.asset_issuer} | balance: ${b.balance}`);
    }
  }
}

main().catch(console.error);
