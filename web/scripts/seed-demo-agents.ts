/**
 * Seed script: registers 6 production service agents on the Talos platform.
 *
 * Usage:
 *   cd web
 *   DATABASE_URL=<pooler_url> npx tsx scripts/seed-demo-agents.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import * as schema from "../src/db/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool, { schema });

function generateApiKey() {
  return `tak_${createId()}${createId()}`;
}

// Real operator wallet — all agents are owned by this key
const OPERATOR_WALLET = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";

interface AgentDef {
  agentName: string;
  name: string;
  category: string;
  description: string;
  persona: string;
  service: {
    serviceName: string;
    description: string;
    price: number;
  };
}

const SERVICE_AGENTS: AgentDef[] = [
  {
    agentName: "vega",
    name: "Vega",
    category: "Analytics",
    description: "Audience intelligence agent. Analyzes target audiences — personas, communities, pain points, and the best channels to reach them.",
    persona: "Precise audience research analyst with deep knowledge of online communities and user behavior patterns.",
    service: {
      serviceName: "audience_insight",
      description: "Analyze a target audience: personas, communities they frequent, pain points, and best channels to reach them.",
      price: 0.005,
    },
  },
  {
    agentName: "atlas",
    name: "Atlas",
    category: "Analytics",
    description: "Trend research agent. Tracks market trends, hot topics, and emerging opportunities across X, Reddit, and Hacker News in real-time.",
    persona: "Trend analyst tracking discussions across X, Reddit, Hacker News, and Product Hunt.",
    service: {
      serviceName: "trend_research",
      description: "Research latest trends and hot topics for a given market. Includes trending discussions, momentum scores, and opportunities.",
      price: 0.005,
    },
  },
  {
    agentName: "nova",
    name: "Nova",
    category: "Analytics",
    description: "Competitive intelligence agent. Deep-dives on competitors — features, pricing, positioning, and market gaps.",
    persona: "Competitive intelligence analyst who dissects products and surfaces positioning opportunities.",
    service: {
      serviceName: "competitor_analysis",
      description: "Analyze competitors: features, pricing, strengths/weaknesses, market gaps, and positioning recommendations.",
      price: 0.008,
    },
  },
  {
    agentName: "forge",
    name: "Forge",
    category: "Sales",
    description: "Lead generation agent. Finds potential customers on social platforms based on target profile and product-market fit signals.",
    persona: "Lead generation specialist who identifies high-relevance prospects from social signals and behavioral data.",
    service: {
      serviceName: "find_leads",
      description: "Find potential customers on X, Reddit, and GitHub who match a target profile and show interest in related topics.",
      price: 0.01,
    },
  },
  {
    agentName: "lens",
    name: "Lens",
    category: "Sales",
    description: "Profile enrichment agent. Enriches prospect profiles with professional details, interests, and social links from public data.",
    persona: "Profile enrichment specialist who builds comprehensive prospect profiles from publicly available data.",
    service: {
      serviceName: "enrich_profile",
      description: "Enrich a person's profile: job title, company, interests, recent activity, and social links.",
      price: 0.008,
    },
  },
  {
    agentName: "radar",
    name: "Radar",
    category: "Sales",
    description: "Intent signal agent. Detects buying intent across platforms — people actively seeking solutions related to your product.",
    persona: "Intent signal analyst detecting 'looking for', 'need help', 'switching from' patterns across platforms.",
    service: {
      serviceName: "intent_signal",
      description: "Detect buying intent signals: people seeking solutions, switching tools, or frustrated with alternatives.",
      price: 0.01,
    },
  },
];

async function main() {
  console.log("🚀 Seeding production agents...\n");

  const results: { name: string; id: string; apiKey: string; service: string; price: number }[] = [];

  for (const agent of SERVICE_AGENTS) {
    const existing = await db
      .select({ id: schema.tlsTalos.id })
      .from(schema.tlsTalos)
      .where(eq(schema.tlsTalos.agentName, agent.agentName))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing) {
      console.log(`  ⏭  ${agent.agentName} already exists (${existing.id}), skipping`);
      continue;
    }

    const apiKey = generateApiKey();

    const [talos] = await db
      .insert(schema.tlsTalos)
      .values({
        agentName: agent.agentName,
        name: agent.name,
        category: agent.category,
        description: agent.description,
        persona: agent.persona,
        status: "Active",
        agentOnline: true,
        agentLastSeen: new Date(),
        apiKey,
        walletPublicKey: OPERATOR_WALLET,
        agentWalletAddress: OPERATOR_WALLET,
        creatorPublicKey: OPERATOR_WALLET,
        channels: ["X (Twitter)", "LinkedIn"],
        pulsePrice: "0.01",
        totalSupply: 1_000_000,
        creatorShare: 60,
        investorShare: 25,
        treasuryShare: 15,
        approvalThreshold: "10",
        gtmBudget: "200",
      })
      .returning();

    await db.insert(schema.tlsCommerceServices).values({
      talosId: talos.id,
      serviceName: agent.service.serviceName,
      description: agent.service.description,
      price: String(agent.service.price),
      stellarPublicKey: OPERATOR_WALLET,
      chains: ["stellar"],
      fulfillmentMode: "instant",
    });

    results.push({ name: agent.agentName, id: talos.id, apiKey, service: agent.service.serviceName, price: agent.service.price });
    console.log(`  ✅ ${agent.name} (${agent.agentName}) — ${agent.service.serviceName} @ $${agent.service.price}`);
  }

  console.log("\n" + "═".repeat(70));
  console.log("  PRODUCTION AGENTS");
  console.log("═".repeat(70));

  for (const r of results) {
    console.log(`\n  🤖 ${r.name}`);
    console.log(`     ID:      ${r.id}`);
    console.log(`     Service: ${r.service} @ $${r.price}`);
    console.log(`     API Key: ${r.apiKey}`);
  }

  console.log("\n" + "═".repeat(70));
  console.log("\n✨ Done! Agents are live.\n");

  await pool.end();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await pool.end();
  process.exit(1);
});
