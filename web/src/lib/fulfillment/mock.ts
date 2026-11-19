/**
 * Mock fulfillment handlers for FULFILLMENT_MODE=mock.
 *
 * Returns deterministic, clearly-labelled fixture outputs so contributors
 * can exercise the full commerce flow locally without Tavily or LLM keys.
 *
 * NOTE: Mock mode is refused when NODE_ENV=production (see assertNotProduction).
 */

import type { FulfillmentPayload, FulfillmentResult } from "./index";

// ── Production guard ─────────────────────────────────────────────────────────

/**
 * Throws if the current runtime is a production environment.
 * Called once at module evaluation so the error surfaces at startup, not at
 * request time.
 */
export function assertNotProduction(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FULFILLMENT_MODE=mock is not allowed in production. " +
        "Remove the FULFILLMENT_MODE variable from your production environment.",
    );
  }
}

// ── Individual mock handlers ──────────────────────────────────────────────────

export function mockTrendResearch(payload: FulfillmentPayload): FulfillmentResult {
  const topic = (payload.topic as string) || "technology";
  const audience = (payload.audience as string) || "developers";
  return {
    _mock: true,
    trends: [
      {
        title: `[MOCK] The rise of AI-native tooling in ${topic}`,
        description: `Developers building for ${audience} are rapidly adopting AI-first workflows.`,
        momentum: "rising",
      },
      {
        title: `[MOCK] Open-source renaissance around ${topic}`,
        description: "Community-led projects are outpacing proprietary alternatives.",
        momentum: "rising",
      },
      {
        title: `[MOCK] Legacy ${topic} frameworks stabilising`,
        description: "Established tools are entering maintenance mode as newer options emerge.",
        momentum: "stable",
      },
    ],
    hot_topics: [
      {
        topic: `[MOCK] ${topic} + AI agents`,
        platform: "Hacker News",
        engagement: "1 200 comments",
        url: "https://news.ycombinator.com/mock",
      },
      {
        topic: `[MOCK] Weekend ${topic} launches`,
        platform: "Product Hunt",
        engagement: "850 upvotes",
        url: "https://producthunt.com/mock",
      },
    ],
    opportunities: [
      {
        gap: `[MOCK] No good open-source ${topic} monitoring tool for ${audience}`,
        suggestion: "Build a lightweight, self-hosted dashboard.",
      },
    ],
    summary: `[MOCK] ${topic} is trending strongly among ${audience}. This is fixture data — set FULFILLMENT_MODE=real and provide API keys for live results.`,
  };
}

export function mockCompetitorAnalysis(payload: FulfillmentPayload): FulfillmentResult {
  const product = (payload.product as string) || "your product";
  const category = (payload.category as string) || "SaaS";
  return {
    _mock: true,
    competitors: [
      {
        name: "[MOCK] AlphaApp",
        url: "https://alphaapp.example",
        description: `A leading ${category} tool with broad feature coverage.`,
        pricing: "$49/mo per seat",
        strengths: ["Strong brand", "Wide integrations"],
        weaknesses: ["Expensive", "Slow support"],
      },
      {
        name: "[MOCK] BetaSuite",
        url: "https://betasuite.example",
        description: `An emerging ${category} challenger focused on simplicity.`,
        pricing: "Free tier + $19/mo",
        strengths: ["Great DX", "Fast onboarding"],
        weaknesses: ["Limited enterprise features", "Small community"],
      },
    ],
    feature_comparison: [
      {
        feature: "[MOCK] API access",
        our_product: "Full REST API",
        competitors: { AlphaApp: "REST + GraphQL", BetaSuite: "REST only" },
      },
    ],
    gaps: [
      {
        gap: `[MOCK] No competitor offers real-time ${category} sync`,
        opportunity: `${product} could differentiate with sub-second updates.`,
      },
    ],
    positioning: {
      recommendation: `[MOCK] Position ${product} as the developer-first ${category} tool.`,
      differentiators: ["Open-source core", "No vendor lock-in"],
      messaging_angle: "Built by developers, for developers.",
    },
  };
}

export function mockFindLeads(payload: FulfillmentPayload): FulfillmentResult {
  const product = (payload.product as string) || "your product";
  const target = (payload.target as string) || "developers";
  return {
    _mock: true,
    leads: [
      {
        name: "[MOCK] Alice Dev",
        handle: "@alice_dev",
        platform: "X",
        title: "Senior Engineer",
        relevance_score: 0.92,
        reason: `Posted about needing a better ${product} alternative.`,
        recent_activity: `"Anyone know a good ${product} for ${target}? Tired of X."`,
      },
      {
        name: "[MOCK] Bob Builder",
        handle: "u/bob_builder",
        platform: "Reddit",
        title: "Indie Hacker",
        relevance_score: 0.85,
        reason: "Actively evaluating tools in this space.",
        recent_activity: `Asked for recommendations in r/webdev: "switching from legacy stack to modern ${product}".`,
      },
      {
        name: "[MOCK] Carol PM",
        handle: "@carol_pm",
        platform: "X",
        title: "Product Manager",
        relevance_score: 0.78,
        reason: "Expressed frustration with current vendor.",
        recent_activity: `"Our ${product} vendor just raised prices 40%. Time to look at alternatives."`,
      },
    ],
    search_summary: `[MOCK] Found 3 high-relevance leads for "${product}" targeting "${target}". This is fixture data.`,
    recommended_approach: `[MOCK] Reach out with a personalised message highlighting ${product}'s value for ${target}.`,
  };
}

export function mockAudienceInsight(payload: FulfillmentPayload): FulfillmentResult {
  const product = (payload.product as string) || "your product";
  const category = (payload.category as string) || "SaaS";
  return {
    _mock: true,
    personas: [
      {
        name: "[MOCK] The Pragmatic Engineer",
        description: `A mid-level engineer who adopts ${product} to solve a specific workflow pain point.`,
        pain_points: ["Too much context-switching", "Poor observability", "Brittle CI pipelines"],
      },
      {
        name: "[MOCK] The Startup CTO",
        description: `A technical founder evaluating ${category} tools to move fast without breaking things.`,
        pain_points: ["Limited engineering bandwidth", "Cost uncertainty", "Vendor lock-in"],
      },
    ],
    communities: [
      {
        platform: "Reddit",
        name: `r/${category.replace(/\s+/g, "")}`,
        url: `https://reddit.com/r/${category.toLowerCase().replace(/\s+/g, "")}`,
        relevance: "High — active discussion of tools similar to your product",
      },
      {
        platform: "Discord",
        name: "[MOCK] DevTools Community",
        url: "https://discord.gg/mock-devtools",
        relevance: "Medium — general developer tool discussion",
      },
    ],
    channels: [
      { platform: "X/Twitter", strategy: "[MOCK] Share dev tips and changelogs targeting #buildinpublic" },
      { platform: "Hacker News", strategy: "[MOCK] Submit Show HN posts for major launches" },
    ],
    key_pain_points: [
      `[MOCK] Existing ${category} solutions are too complex to onboard`,
      "[MOCK] No good free tier to evaluate before committing",
      "[MOCK] Poor documentation and lack of real-world examples",
    ],
  };
}

export function mockIntentSignal(payload: FulfillmentPayload): FulfillmentResult {
  const topic = (payload.topic as string) || "unknown topic";
  const product = (payload.product as string) || "";
  return {
    _mock: true,
    signals: [
      {
        user: "[MOCK] Dave Engineer",
        handle: "@dave_eng",
        platform: "X",
        content_snippet: `Looking for alternatives to our current ${topic} provider — open to suggestions`,
        intent_type: "seeking",
        intent_score: 0.95,
        url: "https://x.com/mock/1",
        posted_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        user: "[MOCK] Eve Startup",
        handle: "u/eve_startup",
        platform: "Reddit",
        content_snippet: `We've been evaluating ${topic} tools. ${product ? `${product} looks promising` : "Haven't found the right one yet"}.`,
        intent_type: "evaluating",
        intent_score: 0.88,
        url: "https://reddit.com/r/mock/2",
        posted_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      },
      {
        user: "[MOCK] Frank Frustrated",
        handle: "@frank_dev",
        platform: "X",
        content_snippet: `Switching from our old ${topic} stack — anyone recommend something better?`,
        intent_type: "switching",
        intent_score: 0.82,
        url: "https://x.com/mock/3",
        posted_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      },
    ],
    summary: `[MOCK] Found 3 intent signals for "${topic}". This is fixture data — provide API keys for live results.`,
    recommended_actions: [
      {
        signal_user: "@dave_eng",
        action: "Direct outreach",
        message_template: `Hi Dave! Saw you're looking for ${topic} alternatives. ${product ? `${product} might be a great fit` : "Happy to share some options"} — want a quick demo?`,
      },
    ],
  };
}

export function mockEnrichProfile(payload: FulfillmentPayload): FulfillmentResult {
  const handle = (payload.handle as string) || "";
  const name = (payload.name as string) || "Unknown";
  const platform = (payload.platform as string) || "x";
  const identifier = handle || name;

  if (!identifier || identifier === "Unknown") {
    return { error: "handle or name is required" };
  }

  return {
    _mock: true,
    name: `[MOCK] ${name || handle}`,
    handle: handle || `@${name.toLowerCase().replace(/\s+/g, "_")}`,
    platform,
    title: "[MOCK] Senior Software Engineer",
    company: "[MOCK] Acme Corp",
    bio: `[MOCK] Building developer tools. Open-source enthusiast. Found on ${platform}.`,
    interests: ["[MOCK] developer tools", "[MOCK] open source", "[MOCK] distributed systems"],
    recent_topics: ["[MOCK] AI agents", "[MOCK] CI/CD", "[MOCK] observability"],
    socials: {
      x: `https://x.com/${handle || "mock_user"}`,
      linkedin: "https://linkedin.com/in/mock-user",
      github: "https://github.com/mock-user",
      website: "https://mockuser.dev",
    },
    summary: `[MOCK] Profile for ${identifier} on ${platform}. This is fixture data — provide API keys for a live enrichment.`,
  };
}

export function mockProductReview(payload: FulfillmentPayload): FulfillmentResult {
  const productName =
    (payload.product_name as string) ||
    (payload.productName as string) ||
    "Unknown Product";
  const productUrl =
    (payload.product_url as string) || (payload.productUrl as string) || "";
  const category = (payload.category as string) || "Developer Tool";
  const channels = (payload.channels as string[]) || ["X", "Reddit", "Product Hunt"];

  const pros = [
    `[MOCK] Clean onboarding — got started with ${productName} in under 5 minutes`,
    "[MOCK] Solid documentation with real-world examples",
    "[MOCK] Active community and responsive maintainers",
  ];
  const cons = [
    "[MOCK] Pricing page could be clearer",
    "[MOCK] No native webhook support yet",
  ];

  return {
    _mock: true,
    product: productName,
    url: productUrl,
    category,
    rating: 4.2,
    pros,
    cons,
    verdict: `[MOCK] ${productName} is a solid pick for the ${category.toLowerCase()} space. This is fixture data.`,
    community_posts: channels.map((channel) => ({
      channel,
      status: "drafted",
      preview: `[MOCK] ${channel === "X" ? `🧵 Just spent a week with ${productName} (thread) 👇` : `[Review] ${productName} — mock fixture output`}`,
    })),
    review_status: "completed",
    published: false,
    note: "[MOCK] This is fixture data. Set FULFILLMENT_MODE=real and provide API keys for live results.",
  };
}

// ── Handler map ───────────────────────────────────────────────────────────────

const mockHandlers: Record<string, (payload: FulfillmentPayload) => FulfillmentResult> = {
  trend_research: mockTrendResearch,
  competitor_analysis: mockCompetitorAnalysis,
  find_leads: mockFindLeads,
  audience_insight: mockAudienceInsight,
  intent_signal: mockIntentSignal,
  enrich_profile: mockEnrichProfile,
  product_review: mockProductReview,
};

/**
 * Entry point used by fulfillInstant when FULFILLMENT_MODE=mock.
 * Wraps synchronous fixture handlers as async to match the Handler signature.
 */
export async function fulfillMock(
  serviceName: string,
  payload: FulfillmentPayload,
): Promise<FulfillmentResult> {
  const handler = mockHandlers[serviceName];
  if (!handler) {
    throw new Error(`No mock fulfillment handler for service: ${serviceName}`);
  }
  return handler(payload);
}
