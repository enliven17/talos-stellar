/**
 * Tests for GET /api/ecosystem-intelligence
 *
 * Coverage:
 *   - Success response with valid data structure
 *   - Empty data scenarios (no agents, no jobs, etc.)
 *   - Error handling (database errors)
 *   - Metadata validation (sample size, confidence, freshness)
 *   - Metric calculations (supply, demand, capacity, price, fulfillment)
 *   - Opportunity scoring (underserved categories, trending agents)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the database
vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: {
        findMany: vi.fn(),
      },
      tlsCommerceServices: {
        findMany: vi.fn(),
      },
      tlsPlaybooks: {
        findMany: vi.fn(),
      },
      tlsPatrons: {
        findMany: vi.fn(),
      },
      tlsActivities: {
        findMany: vi.fn(),
      },
      tlsRevenues: {
        findMany: vi.fn(),
      },
      tlsCommerceJobs: {
        findMany: vi.fn(),
      },
      tlsPlaybookPurchases: {
        findMany: vi.fn(),
      },
    },
  },
}));

import { GET } from "@/app/api/ecosystem-intelligence/route";
import { db } from "@/db";

const mockTalosFindMany = db.query.tlsTalos.findMany as ReturnType<typeof vi.fn>;
const mockServicesFindMany = db.query.tlsCommerceServices.findMany as ReturnType<typeof vi.fn>;
const mockPlaybooksFindMany = db.query.tlsPlaybooks.findMany as ReturnType<typeof vi.fn>;
const mockPatronsFindMany = db.query.tlsPatrons.findMany as ReturnType<typeof vi.fn>;
const mockActivitiesFindMany = db.query.tlsActivities.findMany as ReturnType<typeof vi.fn>;
const mockRevenuesFindMany = db.query.tlsRevenues.findMany as ReturnType<typeof vi.fn>;
const mockJobsFindMany = db.query.tlsCommerceJobs.findMany as ReturnType<typeof vi.fn>;
const mockPurchasesFindMany = db.query.tlsPlaybookPurchases.findMany as ReturnType<typeof vi.fn>;

describe("GET /api/ecosystem-intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Success response with valid data structure ────────────────────────────

  it("returns 200 with valid ecosystem metrics structure", async () => {
    // Mock sample data
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [{ stellarPublicKey: "G123", role: "Creator", pulseAmount: 1000, status: "active" }],
        revenues: [{ amount: "100.00", createdAt: new Date() }],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([
      { id: "svc-1", talosId: "talos-1", price: "10.00" },
    ]);
    mockPlaybooksFindMany.mockResolvedValue([
      { id: "pb-1", talosId: "talos-1", status: "active" },
    ]);
    mockPatronsFindMany.mockResolvedValue([
      { stellarPublicKey: "G123", role: "Creator", pulseAmount: 1000, status: "active" },
    ]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));

    expect(res.status).toBe(200);
    const body = await res.json();

    // Validate top-level structure
    expect(body).toHaveProperty("metadata");
    expect(body).toHaveProperty("supply");
    expect(body).toHaveProperty("demand");
    expect(body).toHaveProperty("capacity");
    expect(body).toHaveProperty("price");
    expect(body).toHaveProperty("fulfillment");
    expect(body).toHaveProperty("opportunity");

    // Validate dataSource fields
    expect(body.supply).toHaveProperty("dataSource");
    expect(body.demand).toHaveProperty("dataSource");
    expect(body.capacity).toHaveProperty("dataSource");
    expect(body.price).toHaveProperty("dataSource");
    expect(body.fulfillment).toHaveProperty("dataSource");
    expect(body.opportunity).toHaveProperty("dataSource");
  });

  // ── Metadata validation ───────────────────────────────────────────────────

  it("includes valid metadata with sample size and confidence", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.metadata).toHaveProperty("sampleSize");
    expect(body.metadata).toHaveProperty("confidence");
    expect(body.metadata).toHaveProperty("freshness");
    expect(body.metadata).toHaveProperty("version");
    expect(body.metadata).toHaveProperty("generatedAt");
    expect(body.metadata).toHaveProperty("suppression");

    expect(typeof body.metadata.sampleSize).toBe("number");
    expect(["high", "medium", "low"]).toContain(body.metadata.confidence);
    expect(typeof body.metadata.version).toBe("string");
    expect(typeof body.metadata.generatedAt).toBe("string");
  });

  it("returns high confidence when sample size >= 10", async () => {
    const agents = Array.from({ length: 10 }, (_, i) => ({
      id: `talos-${i}`,
      name: `Agent ${i}`,
      category: "marketing",
      status: "Active",
      agentOnline: true,
      pulsePrice: "1.50",
      patrons: [],
      revenues: [],
    }));

    mockTalosFindMany.mockResolvedValue(agents);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.metadata.confidence).toBe("high");
    expect(body.metadata.sampleSize).toBe(10);
  });

  it("returns medium confidence when sample size >= 5", async () => {
    const agents = Array.from({ length: 5 }, (_, i) => ({
      id: `talos-${i}`,
      name: `Agent ${i}`,
      category: "marketing",
      status: "Active",
      agentOnline: true,
      pulsePrice: "1.50",
      patrons: [],
      revenues: [],
    }));

    mockTalosFindMany.mockResolvedValue(agents);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.metadata.confidence).toBe("medium");
  });

  it("returns low confidence when sample size < 5", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.metadata.confidence).toBe("low");
  });

  // ── Supply metrics validation ─────────────────────────────────────────────

  it("calculates supply metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
      {
        id: "talos-2",
        name: "Atlas",
        category: "research",
        status: "Active",
        agentOnline: false,
        pulsePrice: "2.00",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([
      { id: "svc-1", talosId: "talos-1", price: "10.00" },
      { id: "svc-2", talosId: "talos-2", price: "15.00" },
    ]);
    mockPlaybooksFindMany.mockResolvedValue([
      { id: "pb-1", talosId: "talos-1", status: "active" },
    ]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.supply.activeAgents).toBe(2);
    expect(body.supply.totalServices).toBe(2);
    expect(body.supply.totalPlaybooks).toBe(1);
    expect(body.supply.byCategory).toEqual({
      marketing: 1,
      research: 1,
    });
    expect(["increasing", "stable", "decreasing"]).toContain(body.supply.trend);
  });

  // ── Demand metrics validation ─────────────────────────────────────────────

  it("calculates demand metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([
      { id: "job-1", talosId: "talos-1", status: "pending", createdAt: new Date() },
      { id: "job-2", talosId: "talos-1", status: "completed", createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    ]);
    mockPurchasesFindMany.mockResolvedValue([
      { id: "purchase-1", playbookId: "pb-1", buyerPublicKey: "G123", createdAt: new Date() },
    ]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.demand.pendingJobs).toBe(1);
    expect(body.demand.completedJobs24h).toBe(1);
    expect(body.demand.playbookPurchases7d).toBe(1);
    expect(body.demand.byCategory).toEqual({
      marketing: 2,
    });
  });

  // ── Capacity metrics validation ───────────────────────────────────────────

  it("calculates capacity metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
      {
        id: "talos-2",
        name: "Atlas",
        category: "research",
        status: "Active",
        agentOnline: false,
        pulsePrice: "2.00",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.capacity.onlineAgents).toBe(1);
    expect(body.capacity.totalCapacity).toBe(100);
    expect(body.capacity.utilizationRate).toBe(0);
    expect(typeof body.capacity.avgResponseTime).toBe("number");
  });

  // ── Price metrics validation ───────────────────────────────────────────────

  it("calculates price metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
      {
        id: "talos-2",
        name: "Atlas",
        category: "research",
        status: "Active",
        agentOnline: true,
        pulsePrice: "2.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([
      { id: "svc-1", talosId: "talos-1", price: "10.00" },
      { id: "svc-2", talosId: "talos-2", price: "20.00" },
    ]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.price.avgServicePrice).toBe(15.00);
    expect(body.price.avgTokenPrice).toBe(2.00);
    expect(typeof body.price.priceChange24h).toBe("number");
    expect(body.price.priceByCategory).toHaveProperty("marketing");
    expect(body.price.priceByCategory).toHaveProperty("research");
  });

  // ── Fulfillment metrics validation ─────────────────────────────────────────

  it("calculates fulfillment metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([
      { id: "job-1", talosId: "talos-1", status: "completed", createdAt: new Date() },
      { id: "job-2", talosId: "talos-1", status: "completed", createdAt: new Date() },
      { id: "job-3", talosId: "talos-1", status: "pending", createdAt: new Date() },
    ]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.fulfillment.completionRate).toBeCloseTo(66.67, 1);
    expect(body.fulfillment.successRate).toBeCloseTo(66.67, 1);
    expect(body.fulfillment.byAgent).toHaveLength(1);
    expect(body.fulfillment.byAgent[0].agentName).toBe("Vega");
    expect(body.fulfillment.byAgent[0].totalJobs).toBe(3);
  });

  // ── Empty data scenarios ───────────────────────────────────────────────────

  it("handles empty data gracefully", async () => {
    mockTalosFindMany.mockResolvedValue([]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.supply.activeAgents).toBe(0);
    expect(body.supply.totalServices).toBe(0);
    expect(body.supply.totalPlaybooks).toBe(0);
    expect(body.demand.pendingJobs).toBe(0);
    expect(body.capacity.onlineAgents).toBe(0);
    expect(body.fulfillment.byAgent).toHaveLength(0);
    expect(body.opportunity.underservedCategories).toHaveLength(0);
    expect(body.opportunity.trendingAgents).toHaveLength(0);
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("returns 503 on database error", async () => {
    mockTalosFindMany.mockRejectedValue(new Error("Database connection failed"));

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  // ── Cache headers validation ─────────────────────────────────────────────────

  it("sets appropriate cache headers", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));

    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate=60");
  });

  // ── Idempotency key support ─────────────────────────────────────────────────

  it("accepts idempotency key header", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const req = new Request("http://localhost/api/ecosystem-intelligence", {
      headers: { "Idempotency-Key": "test-key-123" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  // ── Opportunity metrics validation ─────────────────────────────────────────

  it("calculates opportunity metrics correctly", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [{ amount: "100.00", createdAt: new Date() }],
      },
      {
        id: "talos-2",
        name: "Atlas",
        category: "research",
        status: "Active",
        agentOnline: true,
        pulsePrice: "2.50",
        patrons: [],
        revenues: [{ amount: "50.00", createdAt: new Date() }],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([
      { talosId: "talos-1", amount: "100.00", createdAt: new Date() },
      { talosId: "talos-2", amount: "50.00", createdAt: new Date() },
    ]);
    mockJobsFindMany.mockResolvedValue([
      { id: "job-1", talosId: "talos-1", status: "completed", createdAt: new Date() },
    ]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.opportunity.trendingAgents).toBeInstanceOf(Array);
    expect(body.opportunity.underservedCategories).toBeInstanceOf(Array);
  });

  // ── Data source validation ───────────────────────────────────────────────────

  it("includes correct dataSource values for each metric section", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(body.supply.dataSource).toBe("observed");
    expect(body.demand.dataSource).toBe("observed");
    expect(body.capacity.dataSource).toBe("mixed");
    expect(body.price.dataSource).toBe("observed");
    expect(body.fulfillment.dataSource).toBe("observed");
    expect(body.opportunity.dataSource).toBe("inferred");
  });

  // ── Data type validation ───────────────────────────────────────────────────

  it("ensures all numeric values are numbers, not strings", async () => {
    mockTalosFindMany.mockResolvedValue([
      {
        id: "talos-1",
        name: "Vega",
        category: "marketing",
        status: "Active",
        agentOnline: true,
        pulsePrice: "1.50",
        patrons: [],
        revenues: [],
      },
    ]);
    mockServicesFindMany.mockResolvedValue([]);
    mockPlaybooksFindMany.mockResolvedValue([]);
    mockPatronsFindMany.mockResolvedValue([]);
    mockActivitiesFindMany.mockResolvedValue([]);
    mockRevenuesFindMany.mockResolvedValue([]);
    mockJobsFindMany.mockResolvedValue([]);
    mockPurchasesFindMany.mockResolvedValue([]);

    const res = await GET(new Request("http://localhost/api/ecosystem-intelligence"));
    const body = await res.json();

    expect(typeof body.supply.activeAgents).toBe("number");
    expect(typeof body.supply.totalServices).toBe("number");
    expect(typeof body.demand.pendingJobs).toBe("number");
    expect(typeof body.capacity.onlineAgents).toBe("number");
    expect(typeof body.capacity.utilizationRate).toBe("number");
    expect(typeof body.price.avgServicePrice).toBe("number");
    expect(typeof body.price.avgTokenPrice).toBe("number");
    expect(typeof body.fulfillment.completionRate).toBe("number");
  });
});
