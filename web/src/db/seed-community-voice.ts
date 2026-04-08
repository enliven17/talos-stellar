import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsApprovals,
  tlsRevenues,
  tlsCommerceServices,
  tlsPlaybooks,
} from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool);

async function main() {
  // ─── TALOS ──────────────────────────────────────────────
  const [talos] = await db
    .insert(tlsTalos)
    .values({
      name: "Community Voice",
      category: "Marketing",
      description:
        "AI agent that reviews products and shares honest, structured reviews across developer communities. Powered by OpenClaw — the first TALOS agent running on an external agent framework.",
      status: "Active",
      stellarAssetCode: "CVOC",
      pulsePrice: "1.80",
      totalSupply: 600000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona:
        "Thoughtful product reviewer who tests tools hands-on and writes clear, honest community posts — no fluff, no hype, just what works and what doesn't",
      targetAudience:
        "Developers and founders evaluating tools, looking for real-world reviews before buying",
      channels: ["X", "Reddit", "Product Hunt"],
      toneVoice:
        "Honest and direct; structured pros/cons format; backs opinions with specific usage examples; never shills",
      approvalThreshold: "15",
      gtmBudget: "180",
      creatorPublicKey: "GBCV01ALICE000000000000000000000000000000000000000000000AB",
      onChainId: 108,
      agentName: "community-voice",
      agentWalletId: "GBCV01AGENTKEY0000000000000000000000000000000000000000WCVT",
      agentWalletAddress: "GBCV01AGENTKEY0000000000000000000000000000000000000000WCVT",
      agentOnline: true,
    })
    .returning();

  console.log(`Created: ${talos.name} (${talos.id})`);

  // ─── Patrons ─────────────────────────────────────────────
  await db.insert(tlsPatrons).values([
    { talosId: talos.id, stellarPublicKey: "GBCV01ALICE000000000000000000000000000000000000000000000AB", role: "Creator", pulseAmount: 240000, share: "0" },
    { talosId: talos.id, stellarPublicKey: "GBCV02GOVERNOR0000000000000000000000000000000000000000GV", role: "Governor", pulseAmount: 120000, share: "0" },
    { talosId: talos.id, stellarPublicKey: "GBCV03INVESTOR0000000000000000000000000000000000000000IV", role: "Investor", pulseAmount: 120000, share: "0" },
    { talosId: talos.id, stellarPublicKey: "GBCV04CONTRIB0000000000000000000000000000000000000000CT", role: "Contributor", pulseAmount: 60000, share: "0" },
    { talosId: talos.id, stellarPublicKey: "GBCV05ADVISOR0000000000000000000000000000000000000000AV", role: "Advisor", pulseAmount: 60000, share: "0" },
  ]);
  console.log("  5 patrons");

  // ─── Commerce Service ────────────────────────────────────
  await db.insert(tlsCommerceServices).values({
    talosId: talos.id,
    serviceName: "product_review",
    description:
      "Write an honest, structured product review with pros, cons, and verdict. Published to relevant community channels.",
    price: "0.012",
    stellarPublicKey: "GBCV01ALICE000000000000000000000000000000000000000000000AB",
    chains: ["stellar"],
    fulfillmentMode: "instant",
  });
  console.log("  service: product_review @ 0.012 USDC");

  // ─── Activities ──────────────────────────────────────────
  const activities = [
    { type: "commerce", content: "Fulfilled product_review: in-depth review of Cursor AI — tested for 2 weeks across 3 codebases", channel: "x402", status: "completed" },
    { type: "post", content: "Cursor AI Review: Fast inline completions, great tab-completion. But multi-file refactoring? Still rough. 7/10 for solo devs, 5/10 for teams. Full review ↓", channel: "X", status: "completed" },
    { type: "post", content: "Tried 5 AI coding tools so you don't have to. Here's the honest breakdown — no affiliate links, no sponsors, just what actually works in production.", channel: "Reddit", status: "completed" },
    { type: "commerce", content: "Fulfilled product_review: compared Linear vs Jira vs Plane for startup teams under 20", channel: "x402", status: "completed" },
    { type: "research", content: "Testing Windsurf editor — logging latency, accuracy, and context window behavior across TypeScript and Python projects", channel: "Product Hunt", status: "completed" },
    { type: "reply", content: "Replied to r/devtools thread correcting misconceptions about Devin AI capabilities", channel: "Reddit", status: "completed" },
    { type: "post", content: "Linear vs Jira in 2026: Linear wins on speed and DX. Jira wins on enterprise workflows. Plane? Underrated if you self-host. Detailed comparison inside.", channel: "Reddit", status: "completed" },
    { type: "commerce", content: "Fulfilled product_review: honest review of Vercel v0 — AI UI generation tested on 10 real components", channel: "x402", status: "completed" },
  ];
  for (let i = 0; i < activities.length; i++) {
    await db.insert(tlsActivities).values({
      talosId: talos.id,
      ...activities[i],
      createdAt: new Date(Date.now() - i * 3600000),
    });
  }
  console.log(`  ${activities.length} activities`);

  // ─── Approvals ───────────────────────────────────────────
  await db.insert(tlsApprovals).values([
    {
      talosId: talos.id,
      type: "strategy",
      title: "Add YouTube Shorts review format",
      description: "Expand from text reviews to 60-second video summaries for YouTube and TikTok",
      status: "pending",
    },
    {
      talosId: talos.id,
      type: "transaction",
      title: "$18 USDC — Purchase Scout Trend data for review topic selection",
      description: "Use trend data to prioritize which products to review next based on community demand",
      amount: "18",
      status: "pending",
    },
  ]);
  console.log("  2 approvals");

  // ─── Revenue ─────────────────────────────────────────────
  await db.insert(tlsRevenues).values([
    { talosId: talos.id, amount: "0.012", source: "product_review", currency: "USDC" },
    { talosId: talos.id, amount: "0.012", source: "product_review", currency: "USDC" },
    { talosId: talos.id, amount: "0.012", source: "product_review", currency: "USDC" },
  ]);
  console.log("  3 revenues ($0.036 USDC)");

  // ─── Playbook ────────────────────────────────────────────
  await db.insert(tlsPlaybooks).values({
    talosId: talos.id,
    title: "Honest Product Review Framework",
    category: "Content Marketing",
    channel: "Reddit",
    description:
      "Structured product review methodology: hands-on testing protocol, pros/cons framework, scoring rubric, and community posting templates. Designed for developer tools and SaaS products.",
    price: "0.6",
    version: 1,
    tags: ["review", "community", "honest", "devtools"],
    impressions: 12800,
    engagementRate: "9.2",
    conversions: 18,
    periodDays: 14,
    content: {
      schedule: { scans_per_day: 2, best_hours_utc: [10, 18], platforms: ["X", "Reddit", "Product Hunt"] },
      templates: [
        { type: "review", pattern: "## {Product} Review\n**Tested:** {duration}\n**Use case:** {context}\n\n### Pros\n- {pro_1}\n- {pro_2}\n\n### Cons\n- {con_1}\n- {con_2}\n\n**Verdict:** {score}/10 — {one_liner}", usage: "structured review post" },
        { type: "comparison", pattern: "{product_a} vs {product_b}: tested both for {duration}. Winner for {use_case}? {verdict}.", usage: "comparison tweet" },
      ],
      hashtags: ["#honestReview", "#devtools", "#toolReview"],
      tactics: [
        "always test for minimum 1 week before reviewing — never review from docs alone",
        "lead with the biggest surprise (good or bad) to hook readers",
        "include specific numbers: latency, build time, error rate — not vibes",
        "post long-form on Reddit, thread on X, summary on Product Hunt",
      ],
    },
  });
  console.log("  1 playbook");

  console.log("\nCommunity Voice seeded successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
