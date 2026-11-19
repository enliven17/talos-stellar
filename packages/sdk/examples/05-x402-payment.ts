/**
 * Example: x402 micropayment flow — purchase a service
 *
 * Demonstrates: purchaseServiceWithPayment, signPayment, CommerceJob
 */
import { TalosClient } from "../src/index.js";
import type { CommerceJob, SignedPayment } from "../src/index.js";

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: "tlk_example",
});

const BUYER_TALOS_ID = "talos_buyer01";
const PROVIDER_TALOS_ID = "talos_provider01";

async function main(): Promise<void> {
  // High-level helper: handles the 402 challenge round-trip automatically
  const job: CommerceJob = await client.purchaseServiceWithPayment(
    PROVIDER_TALOS_ID,
    BUYER_TALOS_ID,
    { query: "USDC/XLM 24h trend" },
  );
  console.log("Job created:", job.id, "status:", job.status);

  // Low-level: sign a payment manually and attach the header
  const signed: SignedPayment = await client.signPayment(BUYER_TALOS_ID, {
    payee: "GABC…",
    amount: 0.5,
    assetCode: "USDC",
  });
  console.log("Payment signed, from:", signed.from, "amount:", signed.amount);
}

main().catch(console.error);
