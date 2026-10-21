import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

const mocks = vi.hoisted(() => ({
  jobs: vi.fn(),
  agents: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      tlsCommerceJobs: { findMany: mocks.jobs },
      tlsTalos: { findMany: mocks.agents },
    },
  },
}));

function request(path = "") {
  return new Request(`http://localhost/api/ecosystem-intelligence/network${path}`);
}

function jobsForEdge(buyerId: string, sellerId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${buyerId}-${sellerId}-${index}`,
    requesterTalosId: buyerId,
    talosId: sellerId,
    amount: "2.5",
  }));
}

describe("GET /api/ecosystem-intelligence/network", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.jobs.mockResolvedValue([]);
    mocks.agents.mockResolvedValue([]);
  });

  it("aggregates eligible edges and suppresses edges below the privacy threshold", async () => {
    mocks.jobs.mockResolvedValue([
      ...jobsForEdge("buyer-visible", "seller-visible", 5),
      ...jobsForEdge("buyer-sparse", "seller-sparse", 4),
    ]);
    mocks.agents.mockResolvedValue([
      { id: "buyer-visible", name: "Buyer" },
      { id: "seller-visible", name: "Seller" },
    ]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.edges).toEqual([{
      buyer: { id: "buyer-visible", name: "Buyer" },
      seller: { id: "seller-visible", name: "Seller" },
      jobCount: 5,
      volume: 12.5,
    }]);
    expect(body.metadata.suppressedEdges).toBe(1);
  });

  it("bounds 500 eligible edges by node and edge caps", async () => {
    mocks.jobs.mockResolvedValue(Array.from({ length: 500 }, (_, index) =>
      jobsForEdge(`buyer-${index}`, `seller-${index}`, 5),
    ).flat());

    const response = await GET(request("?window=7"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.edges.length).toBeLessThanOrEqual(200);
    expect(body.metadata.nodeCount).toBeLessThanOrEqual(100);
    expect(body.metadata.truncated).toBe(true);
    expect(body.metadata.windowDays).toBe(7);
  });

  it("rejects unsupported time windows", async () => {
    const response = await GET(request("?window=14"));

    expect(response.status).toBe(400);
    expect(mocks.jobs).not.toHaveBeenCalled();
  });
});