/**
 * Circle Developer-Controlled Wallets — One-time Setup
 *
 * 1. Generates CIRCLE_ENTITY_SECRET (32 bytes hex)
 * 2. Creates entity secret ciphertext (for Circle console registration)
 * 3. Creates a wallet set
 *
 * Usage:
 *   node circle-setup.mjs                         # First run: generate + register
 *   ENTITY_SECRET=xxx node circle-setup.mjs        # Re-run: create wallet set only
 */

import crypto from "crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const CIRCLE_API_KEY = "TEST_API_KEY:1ffca1d84e7cb127ff7df96c0737f6d2:594e8dd68bd4927193185a8dd6c30ea9";

async function setup(entitySecret) {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: CIRCLE_API_KEY,
    entitySecret,
  });

  // Generate ciphertext for console registration
  console.log("\n=== Generating Entity Secret Ciphertext ===");
  try {
    const ciphertext = await client.generateEntitySecretCiphertext();
    console.log("Register this ciphertext at:");
    console.log("  https://console.circle.com/ → Configurator → Entity Secret");
    console.log(`\nCiphertext:\n${ciphertext}\n`);
  } catch (err) {
    console.error("Ciphertext error:", err?.response?.data || err.message);
  }

  // Create wallet set
  console.log("=== Creating Wallet Set ===");
  try {
    const res = await client.createWalletSet({ name: "Corpus Agent Wallets" });
    const walletSetId = res.data?.walletSet?.id;

    console.log("\n========================================");
    console.log("  .env values — copy these:");
    console.log("========================================");
    console.log(`CIRCLE_API_KEY=${CIRCLE_API_KEY}`);
    console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
    console.log(`CIRCLE_WALLET_SET_ID=${walletSetId}`);
    console.log("========================================\n");
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error("Wallet set error:", msg);

    if (JSON.stringify(msg).includes("entity secret")) {
      console.log("\n→ Entity secret not yet registered in Circle Console.");
      console.log("  1. Register the ciphertext above at console.circle.com");
      console.log("  2. Re-run:");
      console.log(`     ENTITY_SECRET=${entitySecret} node circle-setup.mjs\n`);
    }
  }
}

// Main
const entitySecret = process.env.ENTITY_SECRET || crypto.randomBytes(32).toString("hex");
console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
setup(entitySecret).catch(console.error);
