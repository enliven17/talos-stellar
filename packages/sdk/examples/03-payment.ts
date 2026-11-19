/**
 * Example 03 — x402 Payment Flow
 *
 * Demonstrates the full Stellar/x402 service-purchase lifecycle:
 *   1. Attempt to purchase a service without a payment header (triggers 402).
 *   2. Parse the WWW-Authenticate challenge.
 *   3. Sign a Stellar payment via the Web API.
 *   4. Retry the purchase with the X-PAYMENT header attached.
 *   5. Confirm the resulting job record.
 *
 * The high-level helper `purchaseServiceWithPayment` encapsulates steps 1-4
 * automatically.  This example also shows the low-level path for cases where
 * callers need finer control over the signing step.
 *
 * Expected output:
 *   ✓ High-level purchase  jobId=<uuid>  status=pending
 *   ✓ Wallet fetched  address=G...
 *   ✓ Payment signed  from=G...  to=G...  amount=0.50
 *   ✓ Low-level purchase  jobId=<uuid>  status=pending
 *
 * Environment variables required:
 *   TALOS_API_KEY       — buyer agent API key
 *   TALOS_API_URL       — optional
 *   PROVIDER_TALOS_ID   — Talos ID of the service provider
 *   BUYER_TALOS_ID      — Talos ID of the purchasing agent
 */

import { TalosClient, TalosAPIError } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const PROVIDER_ID = process.env.PROVIDER_TALOS_ID ?? "";
const BUYER_ID = process.env.BUYER_TALOS_ID ?? "";

if (!API_KEY || !PROVIDER_ID || !BUYER_ID) {
  console.error("ERROR: TALOS_API_KEY, PROVIDER_TALOS_ID, and BUYER_TALOS_ID are required.");
  process.exit(1);
}

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const payload = { query: "Analyze trending Stellar DeFi protocols" };

  // ── Path A: High-level helper (recommended) ───────────────────────────────
  //
  // purchaseServiceWithPayment automatically:
  //   • makes the initial unauthenticated request
  //   • handles the 402 challenge
  //   • calls signPayment on the buyer's behalf
  //   • retries with the signed X-PAYMENT header
  //
  console.log("── High-level x402 purchase ─────────────────────────────────");
  const hlJob = await client.purchaseServiceWithPayment(PROVIDER_ID, BUYER_ID, payload);
  console.log(`✓ High-level purchase  jobId=${hlJob.id}  status=${hlJob.status}`);

  // ── Path B: Low-level manual control ──────────────────────────────────────
  //
  // Useful when you need to inspect or log the challenge parameters, apply
  // custom retry logic, or integrate with a hardware signing device.
  //
  console.log("\n── Low-level x402 purchase ──────────────────────────────────");

  // 1. Fetch the buyer's wallet address for logging
  const wallet = await client.getWallet(BUYER_ID);
  console.log(`✓ Wallet fetched  address=${wallet.agentWalletAddress}`);

  // 2. Sign a payment directly (normally triggered by a 402 challenge)
  //    In production, parse the challenge params from WWW-Authenticate header.
  const providerWallet = await client.getWallet(PROVIDER_ID);
  const signed = await client.signPayment(BUYER_ID, {
    payee: providerWallet.agentWalletAddress,
    amount: 0.50,
    assetCode: "USDC",
  });
  console.log(`✓ Payment signed  from=${signed.from}  to=${signed.to}  amount=${signed.amount}`);

  // 3. Purchase with pre-signed header
  const llJob = await client.purchaseService(PROVIDER_ID, {
    paymentHeader: signed.paymentHeader,
    payload,
  });
  console.log(`✓ Low-level purchase  jobId=${llJob.id}  status=${llJob.status}`);
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
    if (err.status === 402) {
      console.error("  → Service requires payment; ensure BUYER_TALOS_ID has sufficient balance.");
    }
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
