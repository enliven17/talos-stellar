/**
 * Unit tests verifying public CDN cache headers and authenticated bypass
 * across public read endpoints:
 *  - /api/ecosystem-intelligence
 *  - /api/leaderboard
 *  - /api/services
 *  - /api/playbooks
 *  - /api/proposals
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Shared DB mock ─────────────────────────────────────────────────────────────
function buildSelectChain(rows: unknown[] = []) {
  const obj: Record<string, unknown> = {};
  const passthrough = [
    "from",
    "where",
    "orderBy",
    "leftJoin",
    "innerJoin",
    "groupBy",
    "as",
  ];
  for (const m of passthrough) {
    obj[m] = vi.fn(() => obj);
  }
  obj.limit = vi.fn(() => obj);
  obj.then = vi.fn((onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled(rows)),
  );
  return obj;
}

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    query: {
      tlsTalos: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      tlsPatrons: { findMany: vi.fn().mockResolvedValue([]) },
      tlsRevenues: { findMany: vi.fn().mockResolvedValue([]) },
      tlsCommerceServices: { findMany: vi.fn().mockResolvedValue([]) },
      tlsCommerceJobs: { findMany: vi.fn().mockResolvedValue([]) },
      tlsPlaybooks: { findMany: vi.fn().mockResolvedValue([]) },
      tlsPlaybookPurchases: { findMany: vi.fn().mockResolvedValue([]) },
      tlsActivities: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
  verifyAgentApiKey: vi
    .fn()
    .mockResolvedValue({
      ok: true,
      talos: { id: "test-agent", apiKey: "valid-key" },
    }),
  fetchReputations: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
  resolveTalosFromRequest: mocks.verifyAgentApiKey,
}));
vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: mocks.fetchReputations,
}));
vi.mock("@/lib/webhooks/delivery", () => ({
  emitWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import { GET as getEcosystemIntelligence } from "@/app/api/ecosystem-intelligence/route";
import { GET as getLeaderboard } from "@/app/api/leaderboard/route";
import { GET as getServices } from "@/app/api/services/route";
import { GET as getPlaybooks } from "@/app/api/playbooks/route";
import { GET as getProposals } from "@/app/api/proposals/route";

function createReq(
  path: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers });
}

describe("Public Read Endpoints Cache-Control Headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDb.select.mockImplementation(() => buildSelectChain([]));
  });

  describe("GET /api/ecosystem-intelligence", () => {
    it("sets public s-maxage and stale-while-revalidate for anonymous request", async () => {
      const req = createReq("/api/ecosystem-intelligence");
      const res = await getEcosystemIntelligence(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=30, s-maxage=30, stale-while-revalidate=60",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    });

    it("sets private, no-store for authenticated request", async () => {
      const req = createReq("/api/ecosystem-intelligence", {
        Authorization: "Bearer test-key",
      });
      const res = await getEcosystemIntelligence(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });

  describe("GET /api/leaderboard", () => {
    it("sets public s-maxage and stale-while-revalidate for anonymous request", async () => {
      const req = createReq("/api/leaderboard");
      const res = await getLeaderboard(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    });

    it("sets private, no-store for authenticated request", async () => {
      const req = createReq("/api/leaderboard", {
        Authorization: "Bearer test-key",
      });
      const res = await getLeaderboard(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });

  describe("GET /api/services", () => {
    it("sets public s-maxage and stale-while-revalidate for anonymous request", async () => {
      const req = createReq("/api/services");
      const res = await getServices(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    });

    it("sets private, no-store for authenticated request", async () => {
      const req = createReq("/api/services", {
        Authorization: "Bearer test-key",
      });
      const res = await getServices(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });

  describe("GET /api/playbooks", () => {
    it("sets public s-maxage and stale-while-revalidate for anonymous request", async () => {
      const req = createReq("/api/playbooks");
      const res = await getPlaybooks(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    });

    it("sets private, no-store for authenticated request", async () => {
      const req = createReq("/api/playbooks", {
        Authorization: "Bearer test-key",
      });
      const res = await getPlaybooks(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });

  describe("GET /api/proposals", () => {
    it("sets public s-maxage and stale-while-revalidate for anonymous request", async () => {
      const req = createReq("/api/proposals");
      const res = await getProposals(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=30, stale-while-revalidate=60",
      );
    });

    it("sets private, no-store for authenticated request", async () => {
      const req = createReq("/api/proposals", {
        Authorization: "Bearer test-key",
      });
      const res = await getProposals(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });
});
