/**
 * Local Development Seed Script
 * 
 * Seeds a deterministic, repeatable Talos marketplace dataset for local development.
 * Safe for local databases only — refuses production-looking configurations.
 * 
 * Usage:
 *   pnpm db:seed-local
 * 
 * Features:
 *   - Idempotent: Running twice produces the same logical dataset
 *   - Deterministic: Same data every time for consistent testing
 *   - Safe: Blocks production database URLs
 *   - Complete: Includes agents, services, activities, and one completed commerce record
 *   - Clean: No real credentials or private keys in seed data
 */

import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsCommerceServices,
  tlsCommerceJobs,
  tlsApprovals,
  tlsRevenues,
} from "../src/db/schema";

// ─── Safety Guards ──────────────────────────────────────
function validateLocalEnvironment() {
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set. Please configure your local database connection.");
  }

  // Block production-looking database URLs unless explicitly overridden
  const productionIndicators = [
    "prod",
    "production",
    "live",
    "aws-",
    "supabase.co",
    "planetscale",
    "neon.tech",
  ];

  const override = process.env.SEED_ALLOW_PRODUCTION === "true";
  
  if (!override && productionIndicators.some(indicator => dbUrl.toLowerCase().includes(indicator))) {
    throw new Error(
      `DATABASE_URL appears to be a production database (contains: ${productionIndicators.find(i => dbUrl.toLowerCase().includes(i))}).\n` +
      `This seed command is for local development only.\n` +
      `If you're certain this is correct, set SEED_ALLOW_PRODUCTION=true and re-run.`
    );
  }

  // Require explicit localhost or common local indicators
  const localIndicators = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "local", "docker"];
  const isLocal = localIndicators.some(indicator => dbUrl.toLowerCase().includes(indicator));
  
  if (!override && !isLocal) {
    throw new Error(
      `DATABASE_URL does not appear to be a local database.\n` +
      `Expected localhost, 127.0.0.1, or 'local' in connection string.\n` +
      `Current: ${dbUrl.split("@")[1] || "(hidden)"}\n` +
      `If this is correct, set SEED_ALLOW_PRODUCTION=true and re-run.`
    );
  }

  console.log("✓ Database validated as local development environment");
}

// ─── Deterministic Test Data ────────────────────────────
// Fixed IDs and addresses for repeatability (not real keys/addresses)
const DEMO_WALLET_CREATOR = "GDEMOCREATORDETERMINISTICLOCALSEEDKEY123456789ABCD";
const DEMO_WALLET_BUYER = "GDEMO_BUYER_DETERMINISTIC_LOCAL_SEED_KEY_9876543210";
const DEMO_WALLET_PATRON_1 = "GDEMO_PATRON_1_LOCAL_DETERMINISTIC_KEY_111111111";
const DEMO_WALLET_PATRON_2 = "GDEMO_PATRON_2_LOCAL_DETERMINISTIC_KEY_222222222";

interface AgentSeedData {
  id: string;
  agentName: string;
  name: string;
  category: string;
  description: string;
  persona: string;
  totalSupply: number;
  serviceName: string;
  serviceDescription: string;
  servicePrice: string;
  patrons: Array<{ wallet: string; role: string; share: number; pulseAmount: number }>;
  activities: Array<{ type: string; content: string; channel: string }>;
  approvals: Array<{ type: string; title: string; description: string; amount?: string }>;
  revenues: Array<{ amount: string; source: string }>;
}

const SEED_AGENTS: AgentSeedData[] = [
  {
    id: "demo_agent_analytics_001",
    agentName: "demo-scout-trend",
    name: "Scout Trend (Demo)",
    category: "Analytics",
    description: "Demo AI agent that tracks market trends and emerging opportunities. For local development only.",
    persona: "Trend analyst who spots emerging patterns in developer communities",
    totalSupply: 1000000,
    serviceName: "trend_research",
    serviceDescription: "Research latest trends and hot topics for a given market segment",
    servicePrice: "0.005",
    patrons: [
      { wallet: DEMO_WALLET_CREATOR, role: "Creator", share: 40, pulseAmount: 400000 },
      { wallet: DEMO_WALLET_PATRON_1, role: "Investor", share: 35, pulseAmount: 350000 },
      { wallet: DEMO_WALLET_PATRON_2, role: "Governor", share: 25, pulseAmount: 250000 },
    ],
    activities: [
      { type: "post", content: "Demo: Analyzing AI agent trends in developer communities", channel: "X" },
      { type: "research", content: "Demo: Scanned 100+ discussion threads for trend signals", channel: "X" },
      { type: "commerce", content: "Demo: Completed trend research job for 'Web3 gaming'", channel: "x402" },
    ],
    approvals: [
      {
        type: "strategy",
        title: "Expand to Product Hunt analysis",
        description: "Demo approval: Add Product Hunt as trend signal source",
      },
    ],
    revenues: [
      { amount: "0.005", source: "trend_research" },
      { amount: "0.005", source: "trend_research" },
      { amount: "0.005", source: "trend_research" },
    ],
  },
  {
    id: "demo_agent_sales_002",
    agentName: "demo-prospect-signal",
    name: "Prospect Signal (Demo)",
    category: "Sales",
    description: "Demo AI agent that detects buying intent signals. For local development only.",
    persona: "Sales intelligence analyst who spots buying signals early",
    totalSupply: 500000,
    serviceName: "intent_signal",
    serviceDescription: "Detect buying intent signals from social platforms",
    servicePrice: "0.01",
    patrons: [
      { wallet: DEMO_WALLET_CREATOR, role: "Creator", share: 50, pulseAmount: 250000 },
      { wallet: DEMO_WALLET_PATRON_1, role: "Investor", share: 30, pulseAmount: 150000 },
      { wallet: DEMO_WALLET_PATRON_2, role: "Contributor", share: 20, pulseAmount: 100000 },
    ],
    activities: [
      { type: "post", content: "Demo: AI-powered intent signal detection for B2B SaaS", channel: "X" },
      { type: "commerce", content: "Demo: Detected 15 buying signals for 'project management tools'", channel: "x402" },
    ],
    approvals: [
      {
        type: "transaction",
        title: "$12 USDC — Subscribe to LinkedIn data source",
        description: "Demo approval: Add LinkedIn as intent signal source",
        amount: "12",
      },
    ],
    revenues: [
      { amount: "0.01", source: "intent_signal" },
      { amount: "0.01", source: "intent_signal" },
    ],
  },
];

// ─── Main Seed Function ─────────────────────────────────
async function seedLocalDemo() {
  console.log("🌱 Starting local development database seed...\n");

  validateLocalEnvironment();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const db = drizzle(pool);

  try {
    // Check for existing data
    const existingAgents = await db
      .select({ id: tlsTalos.id, agentName: tlsTalos.agentName })
      .from(tlsTalos)
      .where(eq(tlsTalos.agentName, SEED_AGENTS[0].agentName));

    if (existingAgents.length > 0) {
      console.log("⚠️  Seed data already exists. Running cleanup for idempotent re-seed...\n");
      
      // Delete in FK order
      for (const agent of SEED_AGENTS) {
        const [existing] = await db
          .select({ id: tlsTalos.id })
          .from(tlsTalos)
          .where(eq(tlsTalos.agentName, agent.agentName));
        
        if (existing) {
          await db.delete(tlsCommerceJobs).where(eq(tlsCommerceJobs.talosId, existing.id));
          await db.delete(tlsCommerceServices).where(eq(tlsCommerceServices.talosId, existing.id));
          await db.delete(tlsRevenues).where(eq(tlsRevenues.talosId, existing.id));
          await db.delete(tlsApprovals).where(eq(tlsApprovals.talosId, existing.id));
          await db.delete(tlsActivities).where(eq(tlsActivities.talosId, existing.id));
          await db.delete(tlsPatrons).where(eq(tlsPatrons.talosId, existing.id));
          await db.delete(tlsTalos).where(eq(tlsTalos.id, existing.id));
        }
      }
      
      console.log("✓ Cleaned existing seed data\n");
    }

    // Seed agents
    for (const agent of SEED_AGENTS) {
      console.log(`📦 Seeding: ${agent.name}`);

      // Create talos agent
      const [talos] = await db
        .insert(tlsTalos)
        .values({
          id: agent.id,
          name: agent.name,
          agentName: agent.agentName,
          category: agent.category,
          description: agent.description,
          status: "Active",
          persona: agent.persona,
          totalSupply: agent.totalSupply,
          creatorShare: 40,
          investorShare: 35,
          treasuryShare: 25,
          creatorPublicKey: DEMO_WALLET_CREATOR,
          pulsePrice: "1.00",
          approvalThreshold: "10",
          gtmBudget: "100",
          channels: ["X", "Demo"],
          agentOnline: true,
          targetAudience: "Demo users and local developers",
        })
        .returning();

      console.log(`  ✓ Agent created: ${talos.id}`);

      // Create patrons
      if (agent.patrons.length > 0) {
        await db.insert(tlsPatrons).values(
          agent.patrons.map((p) => ({
            talosId: talos.id,
            stellarPublicKey: p.wallet,
            role: p.role,
            share: p.share.toString(),
            pulseAmount: p.pulseAmount,
            status: "active",
          }))
        );
        console.log(`  ✓ Patrons created: ${agent.patrons.length}`);
      }

      // Create commerce service
      await db.insert(tlsCommerceServices).values({
        talosId: talos.id,
        serviceName: agent.serviceName,
        description: agent.serviceDescription,
        price: agent.servicePrice,
        currency: "USDC",
        stellarPublicKey: DEMO_WALLET_CREATOR,
        chains: ["stellar"],
        fulfillmentMode: "async",
      });
      console.log(`  ✓ Service registered: ${agent.serviceName} @ ${agent.servicePrice} USDC`);

      // Create activities
      if (agent.activities.length > 0) {
        for (let i = 0; i < agent.activities.length; i++) {
          const activity = agent.activities[i];
          await db.insert(tlsActivities).values({
            talosId: talos.id,
            type: activity.type,
            content: activity.content,
            channel: activity.channel,
            status: "completed",
            createdAt: new Date(Date.now() - (i + 1) * 3600000), // Stagger by hours
          });
        }
        console.log(`  ✓ Activities created: ${agent.activities.length}`);
      }

      // Create approvals
      if (agent.approvals.length > 0) {
        await db.insert(tlsApprovals).values(
          agent.approvals.map((a) => ({
            talosId: talos.id,
            type: a.type,
            title: a.title,
            description: a.description,
            amount: a.amount ?? null,
            status: "pending",
          }))
        );
        console.log(`  ✓ Approvals created: ${agent.approvals.length}`);
      }

      // Create revenues
      if (agent.revenues.length > 0) {
        await db.insert(tlsRevenues).values(
          agent.revenues.map((r) => ({
            talosId: talos.id,
            amount: r.amount,
            source: r.source,
            currency: "USDC",
          }))
        );
        console.log(`  ✓ Revenues created: ${agent.revenues.length}`);
      }

      console.log();
    }

    // Create one completed commerce record
    const firstAgent = SEED_AGENTS[0];
    const [firstTalos] = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.agentName, firstAgent.agentName));

    const [completedJob] = await db
      .insert(tlsCommerceJobs)
      .values({
        talosId: firstTalos.id,
        requesterTalosId: SEED_AGENTS[1]?.id || "external_buyer",
        serviceName: firstAgent.serviceName,
        payload: { query: "Demo: AI agent marketplace trends", timeframe: "7d" },
        result: {
          trends: [
            { topic: "Autonomous AI agents", momentum: "high", mentions: 342 },
            { topic: "Agent-to-agent commerce", momentum: "emerging", mentions: 127 },
          ],
        },
        status: "completed",
        amount: firstAgent.servicePrice,
        paymentSig: "demo_payment_sig_" + createId(),
        txHash: "demo_tx_" + createId(),
      })
      .returning();

    console.log(`💰 Completed commerce record created: ${completedJob.id}`);
    console.log(`   Service: ${completedJob.serviceName}`);
    console.log(`   Amount: ${completedJob.amount} USDC`);
    console.log(`   Status: ${completedJob.status}\n`);

    console.log("✅ Local seed completed successfully!\n");
    console.log("📊 Summary:");
    console.log(`   Agents: ${SEED_AGENTS.length}`);
    console.log(`   Services: ${SEED_AGENTS.length}`);
    console.log(`   Activities: ${SEED_AGENTS.reduce((sum, a) => sum + a.activities.length, 0)}`);
    console.log(`   Commerce records: 1 completed`);
    console.log(`   Patrons: ${SEED_AGENTS.reduce((sum, a) => sum + a.patrons.length, 0)}\n`);
    console.log("🧹 Cleanup: Run `pnpm db:seed-local` again to re-seed (idempotent)\n");

  } catch (error) {
    console.error("❌ Seed failed:", error);
    throw error;
  } finally {
    await pool.end();
  }
}

// ─── Run ────────────────────────────────────────────────
seedLocalDemo().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
