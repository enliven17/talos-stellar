/**
 * Unit tests for FULFILLMENT_MODE=mock (issue #899).
 *
 * Covers:
 *  - Every service type returns a valid result without network access
 *  - Results are labelled as mock data (_mock: true)
 *  - Production guard throws when NODE_ENV=production
 *  - isMockMode() helper reads env correctly
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotProduction,
  fulfillMock,
  mockAudienceInsight,
  mockCompetitorAnalysis,
  mockEnrichProfile,
  mockFindLeads,
  mockIntentSignal,
  mockProductReview,
  mockTrendResearch,
} from "../src/lib/fulfillment/mock";
import { fulfillInstant, isMockMode } from "../src/lib/fulfillment/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ── isMockMode ────────────────────────────────────────────────────────────────

describe("isMockMode()", () => {
  it("returns true when FULFILLMENT_MODE=mock", () => {
    withEnv({ FULFILLMENT_MODE: "mock" }, () => {
      expect(isMockMode()).toBe(true);
    });
  });

  it("returns false when FULFILLMENT_MODE is unset", () => {
    withEnv({ FULFILLMENT_MODE: undefined }, () => {
      expect(isMockMode()).toBe(false);
    });
  });

  it("returns false when FULFILLMENT_MODE=real", () => {
    withEnv({ FULFILLMENT_MODE: "real" }, () => {
      expect(isMockMode()).toBe(false);
    });
  });
});

// ── Production guard ──────────────────────────────────────────────────────────

describe("assertNotProduction()", () => {
  it("does not throw in development", () => {
    withEnv({ NODE_ENV: "development" }, () => {
      expect(() => assertNotProduction()).not.toThrow();
    });
  });

  it("does not throw when NODE_ENV is test", () => {
    withEnv({ NODE_ENV: "test" }, () => {
      expect(() => assertNotProduction()).not.toThrow();
    });
  });

  it("throws when NODE_ENV=production", () => {
    withEnv({ NODE_ENV: "production" }, () => {
      expect(() => assertNotProduction()).toThrowError(
        /FULFILLMENT_MODE=mock is not allowed in production/,
      );
    });
  });
});

// ── fulfillMock router ────────────────────────────────────────────────────────

describe("fulfillMock()", () => {
  it("throws for an unknown service name", async () => {
    await expect(fulfillMock("does_not_exist", {})).rejects.toThrow(
      /No mock fulfillment handler for service: does_not_exist/,
    );
  });

  it("routes to the correct handler for every registered service", async () => {
    const services = [
      "trend_research",
      "competitor_analysis",
      "find_leads",
      "audience_insight",
      "intent_signal",
      "enrich_profile",
      "product_review",
    ];
    for (const svc of services) {
      const result = await fulfillMock(svc, { topic: "test", product: "TestProduct", handle: "alice" });
      expect(result).toMatchObject({ _mock: true });
    }
  });
});

// ── fulfillInstant with FULFILLMENT_MODE=mock ─────────────────────────────────

describe("fulfillInstant() in mock mode", () => {
  it("returns a mocked result without calling external APIs", async () => {
    await withEnv({ FULFILLMENT_MODE: "mock", NODE_ENV: "test" }, async () => {
      const result = await fulfillInstant("trend_research", { topic: "AI" });
      expect(result).toMatchObject({ _mock: true });
    });
  });

  it("throws in mock mode when NODE_ENV=production", async () => {
    await expect(
      withEnv({ FULFILLMENT_MODE: "mock", NODE_ENV: "production" }, async () => {
        return fulfillInstant("trend_research", {});
      }),
    ).rejects.toThrow(/FULFILLMENT_MODE=mock is not allowed in production/);
  });
});

// ── Individual mock handlers ──────────────────────────────────────────────────

describe("mockTrendResearch()", () => {
  it("returns trends, hot_topics, opportunities, and summary", () => {
    const result = mockTrendResearch({ topic: "blockchain", audience: "CTOs" });
    expect(result._mock).toBe(true);
    expect(Array.isArray(result.trends)).toBe(true);
    expect(Array.isArray(result.hot_topics)).toBe(true);
    expect(Array.isArray(result.opportunities)).toBe(true);
    expect(typeof result.summary).toBe("string");
  });

  it("uses default values when payload is empty", () => {
    const result = mockTrendResearch({});
    expect(result.summary).toMatch(/technology/);
  });

  it("interpolates the topic into the output", () => {
    const result = mockTrendResearch({ topic: "quantum computing" }) as Record<string, unknown>;
    const summary = result.summary as string;
    expect(summary).toMatch(/quantum computing/i);
  });
});

describe("mockCompetitorAnalysis()", () => {
  it("returns competitors, feature_comparison, gaps, and positioning", () => {
    const result = mockCompetitorAnalysis({ product: "SuperCRM", category: "CRM" });
    expect(result._mock).toBe(true);
    expect(Array.isArray(result.competitors)).toBe(true);
    expect(Array.isArray(result.feature_comparison)).toBe(true);
    expect(Array.isArray(result.gaps)).toBe(true);
    expect(result.positioning).toBeTruthy();
  });

  it("includes product name in positioning recommendation", () => {
    const result = mockCompetitorAnalysis({ product: "MyCRM" }) as Record<string, unknown>;
    const pos = result.positioning as Record<string, unknown>;
    expect(pos.recommendation as string).toContain("MyCRM");
  });
});

describe("mockFindLeads()", () => {
  it("returns a list of leads with required fields", () => {
    const result = mockFindLeads({ product: "DevTool", target: "engineers" });
    expect(result._mock).toBe(true);
    expect(Array.isArray(result.leads)).toBe(true);
    const leads = result.leads as Array<Record<string, unknown>>;
    for (const lead of leads) {
      expect(lead).toHaveProperty("name");
      expect(lead).toHaveProperty("handle");
      expect(lead).toHaveProperty("platform");
      expect(lead).toHaveProperty("relevance_score");
      expect(typeof lead.relevance_score).toBe("number");
      const score = lead.relevance_score as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("mockAudienceInsight()", () => {
  it("returns personas, communities, channels, and key_pain_points", () => {
    const result = mockAudienceInsight({ product: "LogTool", category: "Observability" });
    expect(result._mock).toBe(true);
    expect(Array.isArray(result.personas)).toBe(true);
    expect(Array.isArray(result.communities)).toBe(true);
    expect(Array.isArray(result.channels)).toBe(true);
    expect(Array.isArray(result.key_pain_points)).toBe(true);
  });
});

describe("mockIntentSignal()", () => {
  it("returns signals with required fields", () => {
    const result = mockIntentSignal({ topic: "data pipelines", product: "PipeCo" });
    expect(result._mock).toBe(true);
    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) {
      expect(sig).toHaveProperty("user");
      expect(sig).toHaveProperty("intent_type");
      expect(sig).toHaveProperty("intent_score");
      const score = sig.intent_score as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("signal posted_at is a valid ISO date string", () => {
    const result = mockIntentSignal({ topic: "AI" });
    const signals = result.signals as Array<Record<string, unknown>>;
    for (const sig of signals) {
      expect(() => new Date(sig.posted_at as string)).not.toThrow();
      expect(isNaN(new Date(sig.posted_at as string).getTime())).toBe(false);
    }
  });
});

describe("mockEnrichProfile()", () => {
  it("returns an error when both handle and name are missing", () => {
    const result = mockEnrichProfile({});
    expect(result).toHaveProperty("error");
  });

  it("returns a full profile when a handle is supplied", () => {
    const result = mockEnrichProfile({ handle: "@alice", platform: "x" });
    expect(result._mock).toBe(true);
    expect(result.handle).toBeTruthy();
    expect(result.socials).toBeTruthy();
    const socials = result.socials as Record<string, unknown>;
    expect(socials).toHaveProperty("x");
    expect(socials).toHaveProperty("github");
  });

  it("returns a full profile when a name is supplied instead of handle", () => {
    const result = mockEnrichProfile({ name: "Alice Smith" });
    expect(result._mock).toBe(true);
    expect(result.name as string).toContain("Alice Smith");
  });
});

describe("mockProductReview()", () => {
  it("returns product, rating, pros, cons, verdict, community_posts", () => {
    const result = mockProductReview({ product_name: "AwesomeApp", category: "Analytics" });
    expect(result._mock).toBe(true);
    expect(typeof result.rating).toBe("number");
    expect(Array.isArray(result.pros)).toBe(true);
    expect(Array.isArray(result.cons)).toBe(true);
    expect(typeof result.verdict).toBe("string");
    expect(Array.isArray(result.community_posts)).toBe(true);
  });

  it("accepts the legacy productName payload key", () => {
    const result = mockProductReview({ productName: "LegacyApp" });
    expect(result.product).toBe("LegacyApp");
  });

  it("includes a post for every requested channel", () => {
    const channels = ["X", "Reddit", "LinkedIn"];
    const result = mockProductReview({ product_name: "MultiApp", channels });
    const posts = result.community_posts as Array<Record<string, unknown>>;
    expect(posts.map((p) => p.channel)).toEqual(channels);
  });
});
