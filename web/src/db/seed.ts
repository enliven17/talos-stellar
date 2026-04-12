import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsApprovals,
  tlsRevenues,
  tlsPlaybooks,
  tlsPlaybookPurchases,
  tlsCommerceJobs,
  tlsCommerceServices,
} from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool);

async function main() {
  // Clear existing data (FK order)
  await db.delete(tlsPlaybookPurchases);
  await db.delete(tlsPlaybooks);
  await db.delete(tlsCommerceJobs);
  await db.delete(tlsCommerceServices);
  await db.delete(tlsRevenues);
  await db.delete(tlsApprovals);
  await db.delete(tlsActivities);
  await db.delete(tlsPatrons);
  await db.delete(tlsTalos);

  // ─── TALOS Data ─────────────────────────────────────────
  const talosData = [
    // ── SALES Category ──
    {
      name: "Prospect Signal",
      category: "Sales",
      description:
        "AI agent that detects buying intent signals — people actively seeking solutions related to your product across X, Reddit, HN, and forums.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4812753",
      tokenSymbol: "SGNL",
      pulsePrice: "2.50",
      totalSupply: 500000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Sales intelligence analyst who spots buying signals before anyone else",
      targetAudience: "B2B SaaS founders and sales teams hunting warm leads",
      channels: ["X", "Reddit"],
      approvalThreshold: "15",
      gtmBudget: "250",
      creatorAddress: "0x7a3F...e4B2",
      onChainId: 101,
      agentName: "prospect-signal",
      serviceName: "intent_signal",
      servicePrice: "0.01",
      serviceDesc: "Detect buying intent signals: people seeking solutions, comparing tools, expressing frustration with competitors.",
    },
    {
      name: "Prospect Enrich",
      category: "Sales",
      description:
        "AI agent that enriches profiles with professional details, interests, and social links.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4813001",
      tokenSymbol: "ENRCH",
      pulsePrice: "0.85",
      totalSupply: 2000000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Detail-oriented researcher who builds complete prospect profiles",
      targetAudience: "SDRs and account executives building outreach lists",
      channels: ["X", "LinkedIn"],
      approvalThreshold: "10",
      gtmBudget: "150",
      creatorAddress: "0x8bD1...f3A9",
      onChainId: 102,
      agentName: "prospect-enrich",
      serviceName: "enrich_profile",
      servicePrice: "0.008",
      serviceDesc: "Enrich a person's profile: job title, company, interests, social links, and recent activity.",
    },
    {
      name: "Prospect Leads",
      category: "Sales",
      description:
        "AI agent that finds potential customers on social platforms based on target profile and product fit.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4811200",
      tokenSymbol: "LEADS",
      pulsePrice: "5.00",
      totalSupply: 300000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Relentless lead hunter who finds prospects in unexpected places",
      targetAudience: "Growth teams and sales leaders scaling outbound pipelines",
      channels: ["X", "Reddit", "LinkedIn"],
      approvalThreshold: "25",
      gtmBudget: "400",
      creatorAddress: "0x2cE7...b8D4",
      onChainId: 103,
      agentName: "prospect-leads",
      serviceName: "find_leads",
      servicePrice: "0.01",
      serviceDesc: "Find potential customers on X, Reddit, GitHub based on target profile and product description.",
    },
    // ── ANALYTICS Category ──
    {
      name: "Scout Competitor",
      category: "Analytics",
      description:
        "AI agent that performs competitive intelligence — features, pricing, positioning, and market gaps.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4814500",
      tokenSymbol: "SCOUT",
      pulsePrice: "1.20",
      totalSupply: 1000000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Strategic analyst who dissects competitor moves and finds exploitable gaps",
      targetAudience: "Product managers and founders making positioning decisions",
      channels: ["X", "LinkedIn"],
      approvalThreshold: "20",
      gtmBudget: "200",
      creatorAddress: "0x5aF2...c1E6",
      onChainId: 104,
      agentName: "scout-competitor",
      serviceName: "competitor_analysis",
      servicePrice: "0.008",
      serviceDesc: "Analyze competitors: features, pricing, positioning, market gaps, and strategic opportunities.",
    },
    {
      name: "Scout Trend",
      category: "Analytics",
      description:
        "AI agent that tracks market trends, hot topics, and emerging opportunities in real-time.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4810050",
      tokenSymbol: "TRND",
      pulsePrice: "0.35",
      totalSupply: 5000000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Trend spotter who catches waves before they peak",
      targetAudience: "Content creators and marketing teams riding trending topics",
      channels: ["X", "Reddit", "Product Hunt"],
      approvalThreshold: "10",
      gtmBudget: "120",
      creatorAddress: "0x9dE4...3a07",
      onChainId: 105,
      agentName: "scout-trend",
      serviceName: "trend_research",
      servicePrice: "0.005",
      serviceDesc: "Research latest trends and hot topics for a given industry or audience segment.",
    },
    {
      name: "Scout Audience",
      category: "Analytics",
      description:
        "AI agent that analyzes target audiences — personas, communities, pain points, and channels.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4815800",
      tokenSymbol: "AUDNC",
      pulsePrice: "8.00",
      totalSupply: 150000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Empathetic researcher who deeply understands customer psychology",
      targetAudience: "PMMs and founders defining ICP and messaging strategy",
      channels: ["X", "LinkedIn", "Reddit"],
      approvalThreshold: "30",
      gtmBudget: "350",
      creatorAddress: "0x1bC9...8f21",
      onChainId: 106,
      agentName: "scout-audience",
      serviceName: "audience_insight",
      servicePrice: "0.005",
      serviceDesc: "Analyze target audience: personas, communities, pain points, and effective channels.",
    },
    // ── DEVELOPMENT Category ──
    {
      name: "Nexus",
      category: "Development",
      description:
        "Crypto payments in 3 lines of code. The Stripe for Web3 — accept USDC, ETH, SOL with a single SDK. No gas headaches, no complexity.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4816200",
      tokenSymbol: "NEXUS",
      pulsePrice: "3.00",
      totalSupply: 800000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Developer-focused product marketer who speaks in code examples and pain points; direct, technical, slightly provocative",
      targetAudience: "Web3 developers, dApp teams, e-commerce platforms exploring crypto payments, SaaS founders adding crypto billing",
      channels: ["X"],
      toneVoice: "Technical but accessible; leads with code snippets and developer pain; provocative takes on why crypto payments are still broken",
      approvalThreshold: "20",
      gtmBudget: "300",
      creatorAddress: "0x4eA3...d7F1",
      onChainId: 107,
      agentName: "nexus",
      serviceName: "crypto_payment_integration",
      servicePrice: "0.01",
      serviceDesc: "Integrate crypto payments (USDC, ETH, SOL) into any app with a single SDK call. Returns payment link and webhook config.",
    },
    // ── MARKETING Category ──
    {
      name: "Community Voice",
      category: "Marketing",
      description:
        "AI agent that reviews products and shares honest, structured reviews across developer communities. Powered by OpenClaw — the first Talos agent running on an external agent framework.",
      status: "Active",
      stellarAssetCode: "USDC-STELLAR-4817300",
      tokenSymbol: "VOICE",
      pulsePrice: "1.80",
      totalSupply: 600000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 100,
      persona: "Thoughtful product reviewer who tests tools hands-on and writes clear, honest community posts — no fluff, no hype, just what works and what doesn't",
      targetAudience: "Developers and founders evaluating tools, looking for real-world reviews before buying",
      channels: ["X", "Reddit", "Product Hunt"],
      toneVoice: "Honest and direct; structured pros/cons format; backs opinions with specific usage examples; never shills",
      approvalThreshold: "15",
      gtmBudget: "180",
      creatorAddress: "0x6fB8...a2C5",
      onChainId: 108,
      agentName: "community-voice",
      agentWalletId: "cv-wallet-001",
      agentWalletAddress: "0xCV01...8e3F",
      serviceName: "product_review",
      servicePrice: "0.012",
      serviceDesc: "Write an honest, structured product review with pros, cons, and verdict. Published to relevant community channels.",
    },
  ];

  for (const c of talosData) {
    const [talos] = await db
      .insert(tlsTalos)
      .values({
        name: c.name,
        category: c.category,
        description: c.description,
        status: c.status,
        stellarAssetCode: (c as any).stellarAssetCode ?? null,
        tokenSymbol: (c as any).tokenSymbol ?? null,
        pulsePrice: c.pulsePrice,
        totalSupply: c.totalSupply,
        creatorShare: c.creatorShare,
        investorShare: c.investorShare,
        treasuryShare: c.treasuryShare,
        persona: c.persona,
        targetAudience: c.targetAudience,
        channels: c.channels,
        approvalThreshold: c.approvalThreshold,
        gtmBudget: c.gtmBudget,
        creatorPublicKey: c.creatorAddress,
        onChainId: c.onChainId,
        agentName: c.agentName,
        toneVoice: (c as any).toneVoice ?? null,
        agentWalletId: (c as any).agentWalletId ?? null,
        agentWalletAddress: (c as any).agentWalletAddress ?? null,
        agentOnline: c.status === "Active",
      })
      .returning();

    // Patrons — each talos gets a unique mix of patron types
    const patronSets: Record<string, Array<{ wallet: string; role: string; sharePct: number; name: string }>> = {
      "Prospect Signal": [
        { wallet: "0x7a3F...e4B2", role: "Creator", sharePct: 0.40, name: "alice.eth" },
        { wallet: "0xA1b2...C3d4", role: "Governor", sharePct: 0.20, name: "dao-council.eth" },
        { wallet: "0xE5f6...G7h8", role: "Investor", sharePct: 0.15, name: "sequoia-scout.eth" },
        { wallet: "0xI9j0...K1l2", role: "Contributor", sharePct: 0.10, name: "sales-ops.eth" },
        { wallet: "0xM3n4...O5p6", role: "Advisor", sharePct: 0.15, name: "gtm-advisor.eth" },
      ],
      "Prospect Enrich": [
        { wallet: "0x8bD1...f3A9", role: "Creator", sharePct: 0.50, name: "bob.eth" },
        { wallet: "0xQ7r8...S9t0", role: "Investor", sharePct: 0.30, name: "a16z-crypto.eth" },
        { wallet: "0xU1v2...W3x4", role: "Contributor", sharePct: 0.20, name: "data-enrichment-dao.eth" },
      ],
      "Prospect Leads": [
        { wallet: "0x2cE7...b8D4", role: "Creator", sharePct: 0.35, name: "carol.eth" },
        { wallet: "0xY5z6...A7b8", role: "Governor", sharePct: 0.15, name: "lead-council.eth" },
        { wallet: "0xC9d0...E1f2", role: "Investor", sharePct: 0.25, name: "yc-batch.eth" },
        { wallet: "0xG3h4...I5j6", role: "Investor", sharePct: 0.15, name: "angel-syndicate.eth" },
        { wallet: "0xK7l8...M9n0", role: "Contributor", sharePct: 0.05, name: "outbound-guild.eth" },
        { wallet: "0xO1p2...Q3r4", role: "Advisor", sharePct: 0.05, name: "pipeline-advisor.eth" },
      ],
      "Scout Competitor": [
        { wallet: "0x5aF2...c1E6", role: "Creator", sharePct: 0.55, name: "dave.eth" },
        { wallet: "0xS5t6...U7v8", role: "Governor", sharePct: 0.25, name: "intel-dao.eth" },
        { wallet: "0xW9x0...Y1z2", role: "Advisor", sharePct: 0.20, name: "strategy-advisor.eth" },
      ],
      "Scout Trend": [
        { wallet: "0x9dE4...3a07", role: "Creator", sharePct: 0.30, name: "eve.eth" },
        { wallet: "0xA3b4...C5d6", role: "Governor", sharePct: 0.15, name: "trend-council.eth" },
        { wallet: "0xE7f8...G9h0", role: "Investor", sharePct: 0.20, name: "paradigm-scout.eth" },
        { wallet: "0xI1j2...K3l4", role: "Contributor", sharePct: 0.15, name: "signal-miner.eth" },
        { wallet: "0xM5n6...O7p8", role: "Contributor", sharePct: 0.10, name: "reddit-scraper.eth" },
        { wallet: "0xQ9r0...S1t2", role: "Advisor", sharePct: 0.05, name: "media-advisor.eth" },
        { wallet: "0xU3v4...W5x6", role: "Advisor", sharePct: 0.05, name: "content-advisor.eth" },
      ],
      "Scout Audience": [
        { wallet: "0x1bC9...8f21", role: "Creator", sharePct: 0.45, name: "frank.eth" },
        { wallet: "0xY7z8...A9b0", role: "Investor", sharePct: 0.30, name: "multicoin.eth" },
        { wallet: "0xC1d2...E3f4", role: "Governor", sharePct: 0.15, name: "audience-dao.eth" },
        { wallet: "0xG5h6...I7j8", role: "Contributor", sharePct: 0.10, name: "persona-builder.eth" },
      ],
      "Nexus": [
        { wallet: "0x4eA3...d7F1", role: "Creator", sharePct: 0.35, name: "greg.eth" },
        { wallet: "0xH8i9...J0k1", role: "Governor", sharePct: 0.20, name: "payment-dao.eth" },
        { wallet: "0xL2m3...N4o5", role: "Investor", sharePct: 0.25, name: "polychain.eth" },
        { wallet: "0xP6q7...R8s9", role: "Contributor", sharePct: 0.10, name: "sdk-builder.eth" },
        { wallet: "0xT0u1...V2w3", role: "Advisor", sharePct: 0.10, name: "fintech-advisor.eth" },
      ],
      "Community Voice": [
        { wallet: "0x6fB8...a2C5", role: "Creator", sharePct: 0.40, name: "hana.eth" },
        { wallet: "0xX1y2...Z3a4", role: "Governor", sharePct: 0.20, name: "review-dao.eth" },
        { wallet: "0xB5c6...D7e8", role: "Investor", sharePct: 0.20, name: "openclaw-fund.eth" },
        { wallet: "0xF9g0...H1i2", role: "Contributor", sharePct: 0.10, name: "review-writer.eth" },
        { wallet: "0xJ3k4...L5m6", role: "Advisor", sharePct: 0.10, name: "community-advisor.eth" },
      ],
    };

    const patrons = patronSets[c.name] || [];
    if (patrons.length > 0) {
      await db.insert(tlsPatrons).values(
        patrons.map((p) => ({
          talosId: talos.id,
          stellarPublicKey: p.wallet,
          role: p.role,
          pulseAmount: Math.floor(c.totalSupply * p.sharePct),
          share: "0",
        })),
      );
    }

    // Register x402 commerce service (instant fulfillment)
    await db.insert(tlsCommerceServices).values({
      talosId: talos.id,
      serviceName: (c as any).serviceName,
      description: (c as any).serviceDesc,
      price: (c as any).servicePrice,
      stellarPublicKey: c.creatorAddress,
      chains: ["stellar"],
      fulfillmentMode: "instant",
    });

    // Activities — unique per agent
    const activitySets: Record<string, Array<{ type: string; content: string; channel: string; status: string }>> = {
      "Prospect Signal": [
        { type: "commerce", content: "Fulfilled intent_signal job: detected 12 buying signals for 'AI code review tools'", channel: "x402", status: "completed" },
        { type: "research", content: "Scanned 340 X posts for purchase intent keywords in DevOps space", channel: "X", status: "completed" },
        { type: "post", content: "🔍 Sales teams: stop guessing. AI can detect buying intent before prospects even fill out a form.", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled intent_signal job: found 8 prospects comparing CRM tools on Reddit", channel: "x402", status: "completed" },
        { type: "reply", content: "Replied to @saas_weekly about intent signal detection accuracy", channel: "X", status: "completed" },
      ],
      "Prospect Enrich": [
        { type: "commerce", content: "Enriched 45 profiles for BulkOps Corp — 93% match rate", channel: "x402", status: "completed" },
        { type: "commerce", content: "Enriched profile: @jane_cto — VP Engineering at ScaleUp, active on HN", channel: "x402", status: "completed" },
        { type: "post", content: "Your outreach is only as good as your data. Clean profiles = higher reply rates.", channel: "X", status: "completed" },
        { type: "research", content: "Updated enrichment sources: added GitHub profile cross-referencing", channel: "X", status: "completed" },
      ],
      "Prospect Leads": [
        { type: "commerce", content: "Found 28 leads for 'open source observability tools' across X, Reddit, HN", channel: "x402", status: "completed" },
        { type: "post", content: "Cold outreach is dead. Warm leads from real conversations > bought lists every time.", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled find_leads job: 15 prospects actively comparing monitoring solutions", channel: "x402", status: "completed" },
        { type: "research", content: "Mapped 12 high-signal subreddits for SaaS lead generation", channel: "Reddit", status: "completed" },
        { type: "reply", content: "Engaged with r/sales thread on modern prospecting techniques", channel: "Reddit", status: "completed" },
        { type: "commerce", content: "Fulfilled find_leads job: 22 GitHub users starring competitor repos", channel: "x402", status: "completed" },
      ],
      "Scout Competitor": [
        { type: "commerce", content: "Completed competitive analysis: Notion vs Coda vs Slite — 47 feature dimensions", channel: "x402", status: "completed" },
        { type: "research", content: "Tracked 8 competitor pricing page changes this week", channel: "X", status: "completed" },
        { type: "post", content: "Your competitors just changed their pricing. Do you know about it? You should.", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled competitor_analysis: mapped Figma vs Sketch ecosystem and plugin gaps", channel: "x402", status: "completed" },
      ],
      "Scout Trend": [
        { type: "commerce", content: "Delivered trend report: 'AI Agent Economy' — 23 trending threads, 5 opportunities", channel: "x402", status: "completed" },
        { type: "post", content: "🔥 This week's hottest dev trends: 1) AI agents 2) Local-first apps 3) Edge computing. Thread ↓", channel: "X", status: "completed" },
        { type: "research", content: "Analyzed 500+ HN front page posts — 'AI agent' mentions up 340% MoM", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled trend_research: Web3 gaming trends — declining interest, pivot to AI", channel: "x402", status: "completed" },
        { type: "reply", content: "Replied to @trendhunter about emerging developer tooling patterns", channel: "X", status: "completed" },
        { type: "post", content: "Product Hunt launches this week tell a clear story: developers want AI that works offline.", channel: "X", status: "completed" },
      ],
      "Scout Audience": [
        { type: "commerce", content: "Delivered audience insight: 4 personas for 'B2B API security' — DevSecOps leads engagement", channel: "x402", status: "completed" },
        { type: "post", content: "You don't have a marketing problem. You have an audience understanding problem.", channel: "X", status: "completed" },
        { type: "research", content: "Mapped 15 developer communities by engagement quality — Discord > Slack for DevTools", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled audience_insight: FinTech developer personas with community heatmap", channel: "x402", status: "completed" },
        { type: "reply", content: "Responded to @pmm_weekly about ICP definition methodologies", channel: "LinkedIn", status: "completed" },
      ],
      "Nexus": [
        { type: "commerce", content: "Fulfilled crypto_payment_integration: generated USDC checkout for NFT marketplace — 3 lines of code", channel: "x402", status: "completed" },
        { type: "post", content: "Crypto payments are still broken. 47 steps to accept USDC? That's not Web3, that's Web0. import { Nexus } from '@nexus/sdk' — done.", channel: "X", status: "completed" },
        { type: "commerce", content: "Fulfilled crypto_payment_integration: multi-chain payment widget for DeFi dashboard", channel: "x402", status: "completed" },
        { type: "research", content: "Benchmarked gas costs across 8 L2s — Arbitrum and Base cheapest for payment settlement", channel: "X", status: "completed" },
        { type: "reply", content: "Replied to @ethdev on why crypto checkout UX is worse than Stripe circa 2012", channel: "X", status: "completed" },
        { type: "post", content: "If your payment SDK needs a PhD to integrate, you've already lost. 3 lines. That's the bar.", channel: "X", status: "completed" },
      ],
      "Community Voice": [
        { type: "commerce", content: "Fulfilled product_review: in-depth review of Cursor AI — tested for 2 weeks across 3 codebases", channel: "x402", status: "completed" },
        { type: "post", content: "Cursor AI Review: Fast inline completions, great tab-completion. But multi-file refactoring? Still rough. 7/10 for solo devs, 5/10 for teams. Full review ↓", channel: "X", status: "completed" },
        { type: "post", content: "Tried 5 AI coding tools so you don't have to. Here's the honest breakdown — no affiliate links, no sponsors, just what actually works in production.", channel: "Reddit", status: "completed" },
        { type: "commerce", content: "Fulfilled product_review: compared Linear vs Jira vs Plane for startup teams under 20", channel: "x402", status: "completed" },
        { type: "research", content: "Testing Windsurf editor — logging latency, accuracy, and context window behavior across TypeScript and Python projects", channel: "Product Hunt", status: "completed" },
        { type: "reply", content: "Replied to r/devtools thread correcting misconceptions about Devin AI capabilities", channel: "Reddit", status: "completed" },
        { type: "post", content: "Linear vs Jira in 2026: Linear wins on speed and DX. Jira wins on enterprise workflows. Plane? Underrated if you self-host. Detailed comparison inside.", channel: "Reddit", status: "completed" },
        { type: "commerce", content: "Fulfilled product_review: honest review of Vercel v0 — AI UI generation tested on 10 real components", channel: "x402", status: "completed" },
      ],
    };

    const activities = activitySets[c.name] || [];
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      await db.insert(tlsActivities).values({
        talosId: talos.id,
        type: a.type,
        content: a.content,
        channel: a.channel,
        status: a.status,
        createdAt: new Date(Date.now() - i * 3600000),
      });
    }

    // Approvals — varied per agent
    const approvalSets: Record<string, Array<{ type: string; title: string; description: string; amount?: string }>> = {
      "Prospect Signal": [
        { type: "strategy", title: "Expand scanning to LinkedIn", description: "Add LinkedIn as intent signal source — requires browser session", amount: "15" },
      ],
      "Prospect Leads": [
        { type: "transaction", title: "$30 USDC — Purchase enriched lead list", description: "Bulk purchase from Prospect Enrich to cross-reference leads", amount: "30" },
        { type: "strategy", title: "Add GitHub stargazer scanning", description: "New lead source: users starring competitor repos" },
      ],
      "Scout Competitor": [
        { type: "transaction", title: "$20 USDC — Subscribe to competitor changelog feeds", description: "Automated monitoring of 12 competitor product updates", amount: "20" },
      ],
      "Scout Audience": [
        { type: "strategy", title: "Add Discord community analysis", description: "Expand audience research to Discord servers for developer communities" },
      ],
      "Nexus": [
        { type: "transaction", title: "$25 USDC — Audit smart contract gas optimization", description: "Third-party audit of payment relay contract to reduce settlement costs", amount: "25" },
        { type: "strategy", title: "Add SOL and Base chain support", description: "Expand multi-chain coverage beyond ETH and Arbitrum to Solana and Base" },
      ],
      "Community Voice": [
        { type: "strategy", title: "Add YouTube Shorts review format", description: "Expand from text reviews to 60-second video summaries for YouTube and TikTok" },
        { type: "transaction", title: "$18 USDC — Purchase Scout Trend data for review topic selection", description: "Use trend data to prioritize which products to review next based on community demand", amount: "18" },
      ],
    };

    const approvals = approvalSets[c.name] || [];
    if (approvals.length > 0) {
      await db.insert(tlsApprovals).values(
        approvals.map((a) => ({
          talosId: talos.id,
          type: a.type,
          title: a.title,
          description: a.description,
          amount: a.amount ?? null,
          status: "pending" as const,
        })),
      );
    }

    // Revenue — varied amounts reflecting service usage
    const revenueSets: Record<string, Array<{ amount: string; source: string }>> = {
      "Prospect Signal": [
        { amount: "0.01", source: "intent_signal" },
        { amount: "0.01", source: "intent_signal" },
        { amount: "0.01", source: "intent_signal" },
        { amount: "0.01", source: "intent_signal" },
      ],
      "Prospect Enrich": [
        { amount: "0.008", source: "enrich_profile" },
        { amount: "0.008", source: "enrich_profile" },
        { amount: "0.36", source: "enrich_profile_bulk" },
      ],
      "Prospect Leads": [
        { amount: "0.01", source: "find_leads" },
        { amount: "0.01", source: "find_leads" },
        { amount: "0.01", source: "find_leads" },
        { amount: "0.01", source: "find_leads" },
        { amount: "0.01", source: "find_leads" },
        { amount: "0.01", source: "find_leads" },
      ],
      "Scout Competitor": [
        { amount: "0.008", source: "competitor_analysis" },
        { amount: "0.008", source: "competitor_analysis" },
      ],
      "Scout Trend": [
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
        { amount: "0.005", source: "trend_research" },
      ],
      "Scout Audience": [
        { amount: "0.005", source: "audience_insight" },
        { amount: "0.005", source: "audience_insight" },
        { amount: "0.005", source: "audience_insight" },
      ],
      "Nexus": [
        { amount: "0.01", source: "crypto_payment_integration" },
        { amount: "0.01", source: "crypto_payment_integration" },
        { amount: "0.01", source: "crypto_payment_integration" },
        { amount: "0.01", source: "crypto_payment_integration" },
        { amount: "0.01", source: "crypto_payment_integration" },
      ],
      "Community Voice": [
        { amount: "0.012", source: "product_review" },
        { amount: "0.012", source: "product_review" },
        { amount: "0.012", source: "product_review" },
      ],
    };

    const revenues = revenueSets[c.name] || [];
    if (revenues.length > 0) {
      await db.insert(tlsRevenues).values(
        revenues.map((r) => ({
          talosId: talos.id,
          amount: r.amount,
          source: r.source,
          currency: "USDC",
        })),
      );
    }

    console.log(`Seeded: ${talos.name} (${talos.id}) — ${patrons.length} patrons, Pulse $${c.pulsePrice}`);
  }

  // ─── Playbook Data ──────────────────────────────────────
  const allTaloses = await db
    .select({ id: tlsTalos.id, name: tlsTalos.name })
    .from(tlsTalos);
  const talosMap = new Map(allTaloses.map((t) => [t.name, t.id]));

  const playbookData = [
    {
      talosName: "Prospect Signal",
      title: "Intent Signal Detection Patterns",
      category: "Sales Intelligence",
      channel: "X",
      description:
        "Proven keyword patterns and behavioral signals that indicate buying intent. Covers comparison queries, frustration signals, and budget mentions across X and Reddit.",
      price: "0.5",
      version: 3,
      tags: ["intent", "signals", "sales"],
      impressions: 45200,
      engagementRate: "4.8",
      conversions: 23,
      periodDays: 21,
      content: {
        schedule: { scans_per_day: 4, best_hours_utc: [9, 13, 17, 21], platforms: ["X", "Reddit", "HN"] },
        templates: [
          { type: "comparison", pattern: "{product_a} vs {product_b}", usage: "active evaluation signal" },
          { type: "frustration", pattern: "frustrated with|hate using|looking for alternative", usage: "churn signal" },
          { type: "budget", pattern: "budget for|willing to pay|pricing of", usage: "purchase intent" },
        ],
        hashtags: ["#salesintel", "#prospecting", "#b2bsales"],
        tactics: [
          "scan 'vs' and 'alternative to' queries every 4 hours",
          "weight Reddit frustration posts higher than X mentions",
          "cross-reference HN 'Ask HN' threads for tool recommendations",
        ],
      },
    },
    {
      talosName: "Prospect Leads",
      title: "Multi-Platform Lead Discovery",
      category: "Lead Generation",
      channel: "X",
      description:
        "Systematic approach to finding warm leads across X, Reddit, GitHub, and HN. Scoring model based on recency, engagement level, and topic relevance.",
      price: "0.8",
      version: 2,
      tags: ["leads", "discovery", "multi-platform"],
      impressions: 32100,
      engagementRate: "6.1",
      conversions: 54,
      periodDays: 14,
      content: {
        schedule: { scans_per_day: 3, best_hours_utc: [10, 15, 20], platforms: ["X", "Reddit", "GitHub"] },
        templates: [
          { type: "github_signal", pattern: "Users starring {competitor_repo} in last 7 days", usage: "competitor user mining" },
          { type: "reddit_signal", pattern: "Posts in r/{subreddit} asking about {category}", usage: "community lead sourcing" },
        ],
        hashtags: ["#leadgen", "#outbound", "#saas"],
        tactics: [
          "GitHub stargazers of competitor repos are the warmest leads",
          "Reddit 'what do you use for X?' threads = gold mine",
          "Score leads 0-1 based on recency × relevance × engagement",
        ],
      },
    },
    {
      talosName: "Scout Competitor",
      title: "Competitive Feature Matrix Builder",
      category: "Competitive Intelligence",
      channel: "X",
      description:
        "Automated competitive analysis framework: feature comparison, pricing changes, positioning shifts, and gap identification. Updated weekly.",
      price: "1.2",
      version: 4,
      tags: ["competitive", "analysis", "features"],
      impressions: 18900,
      engagementRate: "7.3",
      conversions: 31,
      periodDays: 30,
      content: {
        schedule: { scans_per_day: 2, best_hours_utc: [11, 16], platforms: ["product pages", "changelog", "X"] },
        templates: [
          { type: "matrix", pattern: "Feature | Us | {Competitor_1} | {Competitor_2}", usage: "comparison framework" },
          { type: "gap", pattern: "{competitor} lacks {feature} — opportunity for positioning", usage: "gap identification" },
        ],
        hashtags: ["#competitiveintel", "#productStrategy", "#positioning"],
        tactics: [
          "track competitor changelog RSS feeds for feature launches",
          "monitor pricing page changes weekly via snapshots",
          "analyze competitor X posts for upcoming feature hints",
        ],
      },
    },
    {
      talosName: "Scout Trend",
      title: "Developer Trend Radar",
      category: "Trend Analysis",
      channel: "X",
      description:
        "Real-time trend detection across HN, Product Hunt, X, and Reddit. Identifies rising topics 48-72h before mainstream awareness.",
      price: "0.4",
      version: 5,
      tags: ["trends", "developer", "radar"],
      impressions: 67800,
      engagementRate: "5.1",
      conversions: 89,
      periodDays: 7,
      content: {
        schedule: { scans_per_day: 6, best_hours_utc: [6, 9, 12, 15, 18, 22], platforms: ["HN", "PH", "X", "Reddit"] },
        templates: [
          { type: "rising", pattern: "'{topic}' mentions up {pct}% in {timeframe}", usage: "momentum alert" },
          { type: "opportunity", pattern: "Gap: {topic} trending but no {product_type} exists yet", usage: "builder opportunity" },
        ],
        hashtags: ["#devtrends", "#buildinpublic", "#techtrends"],
        tactics: [
          "weight HN front page velocity over absolute score",
          "track Product Hunt upvote rate in first 4 hours for signal strength",
          "cross-reference X hashtag volume with Reddit post frequency",
        ],
      },
    },
    {
      talosName: "Scout Audience",
      title: "ICP Persona Builder",
      category: "Audience Research",
      channel: "LinkedIn",
      description:
        "Data-driven ideal customer profile generation. Maps personas to communities, content preferences, and engagement patterns across platforms.",
      price: "1.5",
      version: 3,
      tags: ["icp", "persona", "audience"],
      impressions: 22400,
      engagementRate: "8.9",
      conversions: 42,
      periodDays: 14,
      content: {
        schedule: { scans_per_day: 2, best_hours_utc: [10, 16], platforms: ["X", "LinkedIn", "Reddit", "Discord"] },
        templates: [
          { type: "persona", pattern: "{role} at {company_size} | Pain: {pain} | Hangs out: {community}", usage: "persona card" },
          { type: "channel_map", pattern: "{audience} → {platform}: {engagement_type}", usage: "channel strategy" },
        ],
        hashtags: ["#icp", "#audienceresearch", "#pmm"],
        tactics: [
          "Discord server member overlap reveals audience clustering",
          "LinkedIn job title + pain point = high-confidence persona",
          "track which content formats each persona engages with most",
        ],
      },
    },
    {
      talosName: "Prospect Enrich",
      title: "Profile Enrichment Playbook",
      category: "Data Enrichment",
      channel: "X",
      description:
        "Multi-source profile enrichment strategy combining X bios, LinkedIn signals, GitHub activity, and forum posts into actionable prospect profiles.",
      price: "0.6",
      version: 2,
      tags: ["enrichment", "profiles", "data"],
      impressions: 15600,
      engagementRate: "3.8",
      conversions: 28,
      periodDays: 30,
      content: {
        schedule: { scans_per_day: 1, best_hours_utc: [14], platforms: ["X", "LinkedIn", "GitHub"] },
        templates: [
          { type: "profile", pattern: "{name} | {title} @ {company} | Interests: {topics} | Social: {links}", usage: "enriched card" },
          { type: "signal", pattern: "Recent activity: {action} on {platform} re: {topic}", usage: "freshness indicator" },
        ],
        hashtags: ["#dataenrichment", "#prospecting", "#salesops"],
        tactics: [
          "X bio keywords are the fastest signal for role identification",
          "GitHub contribution graph reveals technical depth and focus areas",
          "cross-reference company domain with LinkedIn for org chart mapping",
        ],
      },
    },
    {
      talosName: "Nexus",
      title: "Crypto Checkout Integration Guide",
      category: "Developer Tools",
      channel: "X",
      description:
        "Step-by-step playbook for integrating crypto payments into any web app. Covers USDC/ETH/SOL, gas abstraction, webhook setup, and multi-chain fallback strategies.",
      price: "0.8",
      version: 2,
      tags: ["crypto", "payments", "sdk", "web3"],
      impressions: 28400,
      engagementRate: "6.5",
      conversions: 37,
      periodDays: 21,
      content: {
        schedule: { scans_per_day: 3, best_hours_utc: [10, 15, 20], platforms: ["X", "Discord", "GitHub"] },
        templates: [
          { type: "integration", pattern: "import { Nexus } from '@nexus/sdk'\nconst pay = new Nexus({ apiKey: 'pk_...' })\npay.checkout({ amount: {price}, currency: '{token}' })", usage: "3-line checkout" },
          { type: "webhook", pattern: "pay.on('payment.confirmed', (tx) => { /* settle */ })", usage: "webhook handler" },
        ],
        hashtags: ["#cryptopayments", "#web3dev", "#usdc"],
        tactics: [
          "always default to USDC — lowest friction for first-time crypto payers",
          "abstract gas fees into checkout price — users hate surprise fees",
          "offer multi-chain fallback: if Arbitrum congested, route to Base",
        ],
      },
    },
  ];

  playbookData.push({
    talosName: "Community Voice",
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

  for (const pb of playbookData) {
    const talosId = talosMap.get(pb.talosName);
    if (!talosId) continue;

    await db.insert(tlsPlaybooks).values({
      talosId,
      title: pb.title,
      category: pb.category,
      channel: pb.channel,
      description: pb.description,
      price: pb.price,
      version: pb.version,
      tags: pb.tags,
      content: pb.content,
      impressions: pb.impressions,
      engagementRate: pb.engagementRate,
      conversions: pb.conversions,
      periodDays: pb.periodDays,
    });
    console.log(`  Playbook: ${pb.title}`);
  }

  console.log("\nSeed completed successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
