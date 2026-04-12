/**
 * mint-mitos.ts — Mint real Mitos tokens on Stellar testnet for every Talos.
 *
 * How it works (Stellar classic assets):
 *   1. Generate a fresh ISSUER keypair for each Talos  (asset = symbol + issuer)
 *   2. Fund issuer via Friendbot
 *   3. OPERATOR sets a trustline for that asset
 *   4. ISSUER sends totalSupply tokens to OPERATOR (operator becomes the distributor)
 *   5. Save issuerPublicKey + stellarAssetCode to DB
 *
 * Run:
 *   DATABASE_URL=... STELLAR_OPERATOR_SECRET_KEY=... npx tsx scripts/mint-mitos.ts
 *
 * IMPORTANT: Save the printed issuer secret keys. They are never stored in DB.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { tlsTalos } from "../src/db/schema";

// ── Config ─────────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const OPERATOR_SECRET = process.env.STELLAR_OPERATOR_SECRET_KEY;
if (!OPERATOR_SECRET) {
  console.error("❌  STELLAR_OPERATOR_SECRET_KEY is not set");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL is not set");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

const server = new Horizon.Server(HORIZON_URL);

async function friendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: ${res.status}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  const operatorKeypair = Keypair.fromSecret(OPERATOR_SECRET!);
  const operatorPubkey = operatorKeypair.publicKey();
  console.log(`\nOperator: ${operatorPubkey}\n`);

  const talosRows = await db
    .select({
      id: tlsTalos.id,
      name: tlsTalos.name,
      tokenSymbol: tlsTalos.tokenSymbol,
      totalSupply: tlsTalos.totalSupply,
      stellarAssetCode: tlsTalos.stellarAssetCode,
    })
    .from(tlsTalos);

  const secrets: Record<string, string> = {};

  for (const talos of talosRows) {
    const symbol = talos.tokenSymbol;
    if (!symbol) {
      console.log(`⏭  ${talos.name} — no tokenSymbol, skipping`);
      continue;
    }

    // Skip if already minted
    if (talos.stellarAssetCode && talos.stellarAssetCode.includes(":")) {
      console.log(`⏭  ${talos.name} (${symbol}) — already minted: ${talos.stellarAssetCode}`);
      continue;
    }

    console.log(`\n🪙  Minting ${symbol} for ${talos.name}...`);

    // 1. Fresh issuer keypair
    const issuer = Keypair.random();
    secrets[talos.name] = issuer.secret();
    console.log(`   Issuer public:  ${issuer.publicKey()}`);

    // 2. Fund issuer via Friendbot
    process.stdout.write("   Funding issuer via Friendbot... ");
    await friendbot(issuer.publicKey());
    console.log("✓");
    await sleep(3000); // wait for ledger to close

    const asset = new Asset(symbol, issuer.publicKey());

    // 3. Operator sets trustline
    process.stdout.write("   Operator trustline... ");
    {
      const opAccount = await server.loadAccount(operatorPubkey);
      const tx = new TransactionBuilder(opAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset }))
        .setTimeout(30)
        .build();
      tx.sign(operatorKeypair);
      await server.submitTransaction(tx);
      console.log("✓");
    }

    await sleep(2000);

    // 4. Issuer mints totalSupply → operator
    process.stdout.write(`   Issuing ${talos.totalSupply} ${symbol} to operator... `);
    {
      const issuerAccount = await server.loadAccount(issuer.publicKey());
      const tx = new TransactionBuilder(issuerAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: operatorPubkey,
            asset,
            amount: String(talos.totalSupply),
          }),
        )
        .setTimeout(30)
        .build();
      tx.sign(issuer);
      await server.submitTransaction(tx);
      console.log("✓");
    }

    // 5. Save to DB
    const assetCode = `${symbol}:${issuer.publicKey()}`;
    await db
      .update(tlsTalos)
      .set({ stellarAssetCode: assetCode })
      .where(eq(tlsTalos.id, talos.id));

    console.log(`   ✅  ${talos.name}: ${assetCode}`);
    await sleep(1000);
  }

  // Print all issuer secrets at the end
  console.log("\n" + "=".repeat(60));
  console.log("ISSUER SECRET KEYS — save these securely, never shared again:");
  console.log("=".repeat(60));
  for (const [name, secret] of Object.entries(secrets)) {
    console.log(`  ${name.padEnd(20)} ${secret}`);
  }
  console.log("=".repeat(60) + "\n");

  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
