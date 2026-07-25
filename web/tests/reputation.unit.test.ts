import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mock Rate Limit Module ──────────────────────────────────────────────────

vi.mock("@/lib/rate-limit", () => {
  return {
    rateLimit: vi.fn(),
    rateLimitResponse: vi.fn(),
    applyRateLimitHeaders: vi.fn(),
  };
});

// ─── Mock Database Module ────────────────────────────────────────────────────

vi.mock("@/db", () => {
  const mockCacheQueue: any[][] = [];
  const mockJobsQueue: any[][] = [];
  const mockServicesResults = { value: [] as any[] };
  const mockInsertedValues: any[] = [];
  const mockUpdatedValues: any[] = [];
  const mockFindFirstResult = { value: null as any };

  let lastTableQueried: any = null;

  const mockQueryBuilder = {
    select: vi.fn().mockImplementation(() => mockQueryBuilder),
    from: vi.fn().mockImplementation((table) => {
      lastTableQueried = table;
      return mockQueryBuilder;
    }),
    innerJoin: vi.fn().mockImplementation(() => mockQueryBuilder),
    where: vi.fn().mockImplementation(() => mockQueryBuilder),
    orderBy: vi.fn().mockImplementation(() => mockQueryBuilder),
    limit: vi.fn().mockImplementation(() => mockQueryBuilder),
    then: vi.fn().mockImplementation((resolve) => {
      const tableName = lastTableQueried ? lastTableQueried[Symbol.for("drizzle:Name")] : null;
      
      let result: any[] = [];
      if (tableName === "tls_commerce_services") {
        result = mockServicesResults.value;
      } else if (tableName === "tls_reputations") {
        result = mockCacheQueue.shift() || [];
      } else if (tableName === "tls_commerce_jobs") {
        result = mockJobsQueue.shift() || [];
      }
      return Promise.resolve(resolve(result));
    }),
  };

  const mockInsertBuilder = {
    values: vi.fn().mockImplementation((val) => {
      mockInsertedValues.push(val);
      return mockInsertBuilder;
    }),
    then: vi.fn().mockImplementation((resolve) => {
      return Promise.resolve(resolve(mockInsertedValues));
    }),
  };

  const mockUpdateBuilder = {
    set: vi.fn().mockImplementation((val) => {
      mockUpdatedValues.push(val);
      return mockUpdateBuilder;
    }),
    where: vi.fn().mockImplementation(() => mockUpdateBuilder),
    then: vi.fn().mockImplementation((resolve) => {
      return Promise.resolve(resolve(mockUpdatedValues));
    }),
  };

  return {
    db: {
      select: () => mockQueryBuilder,
      insert: () => mockInsertBuilder,
      update: () => mockUpdateBuilder,
      query: {
        tlsTalos: {
          findFirst: vi.fn().mockImplementation(async () => mockFindFirstResult.value),
        },
      },
      // Expose variables for test configurations
      __cacheQueue: mockCacheQueue,
      __jobsQueue: mockJobsQueue,
      __servicesResults: mockServicesResults,
      __insertedValues: mockInsertedValues,
      __updatedValues: mockUpdatedValues,
      __findFirstResult: mockFindFirstResult,
    },
  };
});

// Import route handlers, db and helpers AFTER mocks are defined
import { rateLimit, rateLimitResponse, applyRateLimitHeaders } from "@/lib/rate-limit";
import { db } from "@/db";
import { GET as getReputation } from "@/app/api/reputation/route";
import { GET as getServices } from "@/app/api/services/route";
import { getOrCreateReputation } from "@/lib/reputation";

describe("Reputation APIs and Planner Constraints", () => {
  const mockDb = db as any;

  beforeEach(() => {
    mockDb.__cacheQueue.length = 0;
    mockDb.__jobsQueue.length = 0;
    mockDb.__servicesResults.value = [];
    mockDb.__insertedValues.length = 0;
    mockDb.__updatedValues.length = 0;
    mockDb.__findFirstResult.value = null;

    vi.mocked(rateLimit).mockReset();
    vi.mocked(rateLimit).mockReturnValue({ ok: true, limit: 100, remaining: 99, resetAt: Date.now() + 60000 });
    
    vi.mocked(rateLimitResponse).mockReset();
    vi.mocked(rateLimitResponse).mockImplementation(() => new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }));
    
    vi.mocked(applyRateLimitHeaders).mockReset();
    vi.mocked(applyRateLimitHeaders).mockImplementation((response, result) => {
      response.headers.set("X-RateLimit-Limit", String(result.limit));
      response.headers.set("X-RateLimit-Remaining", String(result.remaining));
      response.headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
      return response;
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── 1. Authorization & Rate Limiting ──────────────────────────────────────

  describe("GET /api/reputation - Auth & Rate Limiting", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/reputation");
      const res = await getReputation(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Authorization header");
    });

    it("returns 401 when Authorization token is invalid/unknown", async () => {
      mockDb.__findFirstResult.value = null;
      const req = new NextRequest("http://localhost:3000/api/reputation", {
        headers: { Authorization: "Bearer bad-key" },
      });
      const res = await getReputation(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 200 when valid Authorization header is passed", async () => {
      mockDb.__findFirstResult.value = { id: "agent-1", apiKey: "valid-key" };
      mockDb.__servicesResults.value = [];
      const req = new NextRequest("http://localhost:3000/api/reputation", {
        headers: { Authorization: "Bearer valid-key" },
      });
      const res = await getReputation(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    });

    it("rate limits and returns 429 when quota is exceeded", async () => {
      mockDb.__findFirstResult.value = { id: "agent-1", apiKey: "valid-key" };
      vi.mocked(rateLimit).mockReturnValue({ ok: false, limit: 100, remaining: 0, resetAt: Date.now() + 60000 });

      const req = new NextRequest("http://localhost:3000/api/reputation", {
        headers: { Authorization: "Bearer valid-key" },
      });
      const res = await getReputation(req);
      expect(res.status).toBe(429);
    });
  });

  // ─── 2. getOrCreateReputation Logic (Computation & Caching) ────────────────

  describe("getOrCreateReputation core calculation and cache management", () => {
    it("returns cold-start defaults if no jobs exist", async () => {
      mockDb.__cacheQueue.push([]); // Cache check: empty
      mockDb.__jobsQueue.push([]);  // Jobs check: empty

      const rep = await getOrCreateReputation("agent-1", "Translation");

      expect(rep.samples).toBe(0);
      expect(rep.score).toBe(1.0);
      expect(rep.confidence).toBe(0.0);
      expect(rep.safeReason.safe).toBe(true);
      expect(rep.safeReason.reasons[0]).toContain("Cold-start");

      expect(mockDb.__insertedValues[0]).toMatchObject({
        talosId: "agent-1",
        serviceName: "Translation",
        score: "1",
        confidence: "0",
        samples: 0,
      });
    });

    it("calculates score and confidence correctly from completed and failed jobs", async () => {
      mockDb.__cacheQueue.push([]); // Cache check: empty
      mockDb.__jobsQueue.push([
        { status: "completed", leaseExpiresAt: null },
        { status: "completed", leaseExpiresAt: null },
        { status: "completed", leaseExpiresAt: null },
        { status: "failed", leaseExpiresAt: null },
      ]);

      const rep = await getOrCreateReputation("agent-1", "Translation");

      expect(rep.samples).toBe(4);
      expect(rep.score).toBe(0.75);
      expect(rep.confidence).toBe(4 / 7);
      expect(rep.safeReason.safe).toBe(false);
      expect(rep.safeReason.reasons).toContain("Unsafe: low completion rate");
    });

    it("treats expired leased jobs as failed", async () => {
      vi.setSystemTime(new Date("2026-07-25T08:00:00.000Z"));
      
      mockDb.__cacheQueue.push([]); // Cache check: empty
      mockDb.__jobsQueue.push([
        { status: "completed", leaseExpiresAt: null },
        { status: "pending", leaseExpiresAt: new Date("2026-07-25T07:59:00.000Z") },
      ]);

      const rep = await getOrCreateReputation("agent-1", "Translation");

      expect(rep.samples).toBe(2);
      expect(rep.score).toBe(0.5);
    });

    it("uses cached values if cache is fresh", async () => {
      const freshness = new Date("2026-07-25T07:59:30.000Z");
      vi.setSystemTime(new Date("2026-07-25T08:00:00.000Z"));

      mockDb.__cacheQueue.push([
        {
          talosId: "agent-1",
          serviceName: "Translation",
          score: "0.95",
          confidence: "0.85",
          samples: 10,
          freshness,
          version: "1.0.0",
          safeReason: { safe: true, reasons: ["Consistent"] },
        },
      ]);

      const rep = await getOrCreateReputation("agent-1", "Translation");
      expect(rep.samples).toBe(10);
      expect(rep.score).toBe(0.95);
      expect(mockDb.__insertedValues.length).toBe(0);
      expect(mockDb.__updatedValues.length).toBe(0);
    });

    it("recalculates and updates cache if cache is stale", async () => {
      const freshness = new Date("2026-07-25T07:55:00.000Z");
      vi.setSystemTime(new Date("2026-07-25T08:00:00.000Z"));

      const cachedRow = {
        id: "rep-1",
        talosId: "agent-1",
        serviceName: "Translation",
        score: "0.95",
        confidence: "0.85",
        samples: 10,
        freshness,
        version: "1.0.0",
        safeReason: { safe: true, reasons: ["Consistent"] },
      };

      mockDb.__cacheQueue.push([cachedRow]);
      mockDb.__jobsQueue.push([{ status: "completed", leaseExpiresAt: null }]);

      const rep = await getOrCreateReputation("agent-1", "Translation");
      expect(rep.samples).toBe(1);
      expect(rep.score).toBe(1.0);
      expect(mockDb.__updatedValues.length).toBe(1);
    });
  });

  // ─── 3. Filtering constraints & Cold-Start protection ─────────────────────

  describe("GET /api/reputation - Filtering and Cold-Start Protection", () => {
    it("filters list by minConfidence/minEvidence but does NOT hide cold-start providers", async () => {
      mockDb.__findFirstResult.value = { id: "agent-1", apiKey: "valid-key" };

      mockDb.__servicesResults.value = [
        { id: "s-1", talosId: "agent-1", serviceName: "ServiceA", createdAt: new Date() },
        { id: "s-2", talosId: "agent-2", serviceName: "ServiceB", createdAt: new Date() },
      ];

      // ServiceA: Cache miss, then 10 completed jobs (samples = 10, confidence = 10/13 = ~0.77)
      mockDb.__cacheQueue.push([]);
      mockDb.__jobsQueue.push(Array(10).fill({ status: "completed", leaseExpiresAt: null }));

      // ServiceB: Cache miss, then 0 jobs (cold-start)
      mockDb.__cacheQueue.push([]);
      mockDb.__jobsQueue.push([]);

      const req = new NextRequest("http://localhost:3000/api/reputation?minConfidence=0.5&minEvidence=5", {
        headers: { Authorization: "Bearer valid-key" },
      });
      const res = await getReputation(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data.length).toBe(2); // ServiceA (meets filter) + ServiceB (cold start bypasses filter)
    });
  });

  // ─── 4. Planner Constraints Integration in Services Discovery ──────────────

  describe("GET /api/services - Planner Constraints Integration", () => {
    it("applies minScore, minConfidence, minEvidence constraints in discovery but preserves cold start", async () => {
      mockDb.__servicesResults.value = [
        { id: "s-1", talosId: "agent-1", talosName: "A1", talosCategory: "Ops", serviceName: "S1", description: "", price: "10", currency: "USDC", chains: ["stellar"], createdAt: new Date() },
        { id: "s-2", talosId: "agent-2", talosName: "A2", talosCategory: "Ops", serviceName: "S2", description: "", price: "10", currency: "USDC", chains: ["stellar"], createdAt: new Date() },
        { id: "s-3", talosId: "agent-3", talosName: "A3", talosCategory: "Ops", serviceName: "S3", description: "", price: "10", currency: "USDC", chains: ["stellar"], createdAt: new Date() },
      ];

      // S1 Cache: fresh cache with 12 completed jobs (score = 1.0, confidence = 12/15 = 0.8, samples = 12)
      mockDb.__cacheQueue.push([
        {
          talosId: "agent-1",
          serviceName: "S1",
          score: "1.0",
          confidence: "0.8",
          samples: 12,
          freshness: new Date(),
          version: "1.0.0",
          safeReason: { safe: true, reasons: [] },
        }
      ]);

      // S2 Cache: fresh cache with 12 jobs but low score (score = 0.5, confidence = 0.8, samples = 12)
      mockDb.__cacheQueue.push([
        {
          talosId: "agent-2",
          serviceName: "S2",
          score: "0.5",
          confidence: "0.8",
          samples: 12,
          freshness: new Date(),
          version: "1.0.0",
          safeReason: { safe: false, reasons: [] },
        }
      ]);

      // S3 Cache: fresh cache with cold start (score = 1.0, confidence = 0.0, samples = 0)
      mockDb.__cacheQueue.push([
        {
          talosId: "agent-3",
          serviceName: "S3",
          score: "1.0",
          confidence: "0.0",
          samples: 0,
          freshness: new Date(),
          version: "1.0.0",
          safeReason: { safe: true, reasons: ["Cold-start"] },
        }
      ]);

      const req = new NextRequest("http://localhost:3000/api/services?minScore=0.8&minConfidence=0.5");
      const res = await getServices(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      const serviceNames = body.data.map((s: any) => s.serviceName);
      expect(serviceNames).toContain("S1");
      expect(serviceNames).toContain("S3");
      expect(serviceNames).not.toContain("S2");
    });
  });
});
