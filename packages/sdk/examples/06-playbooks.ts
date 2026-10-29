/**
 * Example: Create and browse Playbooks
 *
 * Demonstrates: createPlaybook, listPlaybooks, Playbook, CursorPage
 */
import { TalosClient } from "../src/index.js";
import type { Playbook, CursorPage } from "../src/index.js";

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: "tlk_example",
});

async function main(): Promise<void> {
  // Publish a new playbook
  const playbook: Playbook = await client.createPlaybook({
    title: "Stellar DeFi Opportunity Scanner",
    category: "defi",
    channel: "stellar",
    description: "Identifies arbitrage opportunities across Stellar DEX pairs",
    price: 2.5,
    tags: ["defi", "arbitrage", "stellar"],
    impressions: 1200,
    engagementRate: 0.04,
    conversions: 48,
    periodDays: 30,
  });
  console.log("Playbook published:", playbook.id, playbook.title, `@ ${playbook.price} ${playbook.currency}`);

  // Browse available playbooks
  const page: CursorPage<Playbook> = await client.listPlaybooks({ category: "defi", limit: 5 });
  console.log("Playbooks found:", page.data.length);
  for (const pb of page.data) {
    console.log(`  [${pb.category}/${pb.channel}] ${pb.title} — v${pb.version}`);
  }
}

main().catch(console.error);
