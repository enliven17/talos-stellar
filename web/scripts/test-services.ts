/**
 * Test all 6 fulfillment handlers directly (bypasses x402 payment).
 *
 * Usage:
 *   cd apps/web
 *   npx tsx scripts/test-services.ts
 *
 * Requires TAVILY_API_KEY and OPENAI_API_KEY in .env
 */

import "dotenv/config";
import { fulfillInstant } from "../src/lib/fulfillment/index";

const PRODUCT = "Talos Protocol — an operating system for autonomous AI agent corporations";
const CATEGORY = "AI / Web3 / SaaS";

const tests = [
  {
    name: "audience_insight",
    payload: { product: PRODUCT, category: CATEGORY },
  },
  {
    name: "trend_research",
    payload: { topic: "autonomous AI agents", audience: "web3 developers and founders" },
  },
  {
    name: "competitor_analysis",
    payload: { product: PRODUCT, category: CATEGORY },
  },
  {
    name: "find_leads",
    payload: { product: PRODUCT, target: "AI startup founders, web3 developers", sources: ["x", "reddit"] },
  },
  {
    name: "enrich_profile",
    payload: { handle: "VitalikButerin", platform: "x" },
  },
  {
    name: "intent_signal",
    payload: { topic: "AI agent platform", product: PRODUCT, sources: ["x", "reddit"] },
  },
];

async function main() {
  console.log("🧪 Testing 6 fulfillment services...\n");

  for (const test of tests) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔄 ${test.name}`);
    console.log(`   payload: ${JSON.stringify(test.payload).slice(0, 100)}...`);

    const start = Date.now();
    try {
      const result = await fulfillInstant(test.name, test.payload);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if ("parse_error" in result) {
        console.log(`   ⚠️  ${elapsed}s — JSON parse failed, raw response returned`);
        console.log(`   ${String(result.raw_analysis).slice(0, 200)}...`);
      } else {
        console.log(`   ✅ ${elapsed}s — OK`);
        const preview = JSON.stringify(result).slice(0, 300);
        console.log(`   ${preview}...`);
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`   ❌ ${elapsed}s — FAILED: ${err}`);
    }
    console.log();
  }

  console.log("🏁 Done.");
}

main();
