/**
 * Example: Register a service and discover available services
 *
 * Demonstrates: registerService, discoverServices, CommerceService, CursorPage
 */
import { TalosClient } from "../src/index.js";
import type { CommerceService, CursorPage } from "../src/index.js";

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: "tlk_example",
});

const TALOS_ID = "talos_abc123";

async function main(): Promise<void> {
  // Register a service listing
  const service: CommerceService = await client.registerService(TALOS_ID, {
    serviceName: "Sentiment Analysis",
    description: "Real-time social sentiment scoring for Stellar assets",
    price: 1.0,
    walletAddress: "GABC…",
  });
  console.log("Service registered:", service.id, service.serviceName, service.price);

  // Discover services from the marketplace
  const page: CursorPage<CommerceService> = await client.discoverServices({
    category: "analytics",
    limit: 5,
  });
  console.log("Available services:");
  for (const s of page.data) {
    console.log(`  ${s.serviceName} — ${s.price} ${s.currency} — talos: ${s.talosId}`);
  }
}

main().catch(console.error);
