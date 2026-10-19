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
 * Security changes (see #928):
 *   - Issuer secret keys are NEVER printed to stdout.
 *   - Instead they are written to an output file (default: ~/mitos-issuer-secrets.json)
 *     with mode 0600 so only the current OS user can read it.
 *   - Only the output file path and public keys are printed to stdout.
 *   - The script refuses to run unless the configured network passphrase matches
 *     Stellar TESTNET.  Pass --allow-network to override (e.g. for a private network).
 *
 * Run:
 *   DATABASE_URL=... STELLAR_OPERATOR_SECRET_KEY=... npx tsx scripts/mint-mitos.ts
 *   DATABASE_URL=... npx tsx scripts/mint-mitos.ts --out /safe/path/secrets.json
 *   DATABASE_URL=... npx tsx scripts/mint-mitos.ts --allow-network
 *
 * IMPORTANT: The output file contains issuer secret keys.  Store it securely.
 *            It is never stored in the database and cannot be recovered if lost.
 */

import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

// ── Network guard ──────────────────────────────────────────────────────────

/**
 * Asserts that the given passphrase is the Stellar testnet passphrase, or that
 * the caller has explicitly opted in to a non-testnet run.
 *
 * Exported for unit-testing.
 *
 * @throws {Error} when the passphrase is not testnet and allowNetwork is false.
 */
export function assertTestnetPassphrase(
  passphrase: string,
  allowNetwork: boolean,
): void {
  if (passphrase === Networks.TESTNET) return;
  if (allowNetwork) {
    console.warn(
      "⚠️  --allow-network is set: running against a non-testnet network passphrase.",
    );
    return;
  }
  throw new Error(
    `mint-mitos refuses to run against a non-testnet network passphrase.\n` +
      `  configured: "${passphrase}"\n` +
      `  expected:   "${Networks.TESTNET}"\n` +
      `Pass --allow-network to override (only do this on a private/local network).`,
  );
}

// ── Secret-file writer ────────────────────────────────────────────────────

/**
 * Writes issuer secrets to a JSON file with mode 0600.
 *
 * The file is written atomically-ish (writeFileSync) so a crash mid-write
 * does not leave a partially written file readable by other users.
 *
 * Exported for unit-testing.
 *
 * @param secrets  Map of Talos name → issuer secret key.
 * @param outPath  Absolute path to the output file.
 */
export function writeSecretsFile(
  secrets: Record<string, string>,
  outPath: string,
): void {
  const payload = JSON.stringify(
    {
      warning:
        "These are ISSUER SECRET KEYS. Never commit, share, or expose them. Store securely.",
      generatedAt: new Date().toISOString(),
      secrets,
    },
    null,
    2,
  );

  // Write with mode 0600 (owner read/write only)
  writeFileSync(outPath, payload, { encoding: "utf8", mode: 0o600 });
}

// ── Script entry point ────────────────────────────────────────────────────
// Guards below only execute when the file is run directly (not imported by
// tests or other modules).

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT_URL = "https://friendbot.stellar.org";

// Detect whether this module is the direct entry point.
// tsx sets process.argv[1] to the resolved file path.
function isEntryPoint(): boolean {
  return process.argv[1]?.endsWith("mint-mitos.ts") ||
    process.argv[1]?.endsWith("mint-mitos.js") ||
    false;
}

async function friendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`Friendbot failed for ${publicKey}: ${res.status}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Parse CLI flags
  const args = process.argv.slice(2);
  const allowNetwork = args.includes("--allow-network");
  const outFlagIdx = args.indexOf("--out");
  const outPath =
    outFlagIdx !== -1 && args[outFlagIdx + 1]
      ? args[outFlagIdx + 1]
      : join(homedir(), "mitos-issuer-secrets.json");

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

  // Enforce testnet-only by default
  assertTestnetPassphrase(NETWORK_PASSPHRASE, allowNetwork);

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  const server = new Horizon.Server(HORIZON_URL);
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
    // Store secret for file output only — never printed to stdout
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

  if (Object.keys(secrets).length === 0) {
    console.log("\nNo new tokens were minted — nothing to write.\n");
    await pool.end();
    return;
  }

  // Write secrets to file with 0600 permissions — not to stdout
  writeSecretsFile(secrets, outPath);

  console.log("\n" + "=".repeat(60));
  console.log("ISSUER SECRET KEYS written to (mode 0600):");
  console.log(`  ${outPath}`);
  console.log("Keep that file secure. It cannot be recovered if lost.");
  console.log("=".repeat(60) + "\n");

  await pool.end();
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
