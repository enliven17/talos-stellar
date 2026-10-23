import { Horizon, Keypair } from "@stellar/stellar-sdk";

// ── Env guard ─────────────────────────────────────────────────────────────────

const secret = process.env.STELLAR_OPERATOR_SECRET_KEY;
if (!secret || secret.trim() === "") {
  console.error(
    "Error: STELLAR_OPERATOR_SECRET_KEY is not set.\n" +
      "Export the operator secret key before running this script:\n" +
      "  export STELLAR_OPERATOR_SECRET_KEY=S…",
  );
  process.exitCode = 1;
  process.exit(1);
}

// ── Network config ────────────────────────────────────────────────────────────

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

// ── Main ──────────────────────────────────────────────────────────────────────

const keypair = Keypair.fromSecret(secret);
const server = new Horizon.Server(HORIZON_URL);

async function main() {
  console.log(`Using Horizon: ${HORIZON_URL}`);
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

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
