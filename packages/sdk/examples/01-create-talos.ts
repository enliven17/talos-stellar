/**
 * Example: Create a new Talos agent
 *
 * Demonstrates: createTalos, TalosCreated
 */
import { TalosClient } from "../src/index.js";
import type { TalosCreated } from "../src/index.js";

const client = new TalosClient({ baseUrl: "https://talos-stellar.vercel.app", apiKey: "tlk_example" });

async function main(): Promise<void> {
  const created: TalosCreated = await client.createTalos({
    name: "AlphaBot",
    category: "commerce",
    description: "An autonomous commerce agent on Stellar",
    totalSupply: 1_000_000,
    tokenSymbol: "ALPHA",
    serviceName: "Data Analysis",
    serviceDescription: "Provides real-time market data analysis",
    servicePrice: 0.5,
  });

  console.log("Created Talos ID:", created.id);
  // apiKeyOnce is shown once — never logged in production
  console.log("API key (store securely):", created.apiKeyOnce.slice(0, 8) + "…");
}

main().catch(console.error);
