import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  encodeRankedCursor,
  hashFilters,
} from "@/lib/marketplace-sort";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const selectMock = vi.fn();
  return { mockDb: { select: selectMock }, selectMock };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

vi.mock("@/lib/tracing", () => ({
  withTraceContext:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

vi.mock("@/lib/api-response", () => ({
  internalError: () =>
    Response.json({ error: "Internal server error" }, { status: 500 }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((cb: (r: unknown) => unknown) =>
    Promise.resolve(cb(result)),
  );
  return chain;
}

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/marketplace/search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

const NOW = new Date("2025-06-01T12:00:00.000Z");

function makeServiceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "svc_001",
    talosId: "talos_001",
    talosName: "My Agent",
    talosCategory: "automation",
    serviceName: "Test Service",
    description: "A service",
    price: "10.000000",
    currency: "USDC",
    chains: ["stellar"],
    createdAt: NOW,
    ...overrides,
  };
}

// ─── Route tests ──────────────────────────────────────────────────────────────

describe("GET /api/marketplace/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with empty data array when no services match", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns services with the correct shape", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([makeServiceRow()]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const svc = body.data[0];
    expect(svc).toHaveProperty("id", "svc_001");
    expect(svc).toHaveProperty("talosId", "talos_001");
    expect(svc).toHaveProperty("serviceName", "Test Service");
    expect(svc).toHaveProperty("price", 10);
    expect(svc).toHaveProperty("currency", "USDC");
    expect(typeof svc.createdAt).toBe("string");
  });

  it("returns nextCursor=null on the last page", async () => {
    // Only 2 rows returned, limit defaults to 20 → no more pages
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([makeServiceRow({ id: "svc_1" }), makeServiceRow({ id: "svc_2" })]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "5" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });

  it("returns nextCursor when there are more results", async () => {
    // Return limit+1 rows to signal there is a next page (limit=2 → 3 rows)
    const rows = [
      makeServiceRow({ id: "svc_1" }),
      makeServiceRow({ id: "svc_2" }),
      makeServiceRow({ id: "svc_3" }),
    ];
    mocks.selectMock.mockReturnValueOnce(makeSelectChain(rows));

    const { GET } = await import("../route");
    const res = await GET(makeRequest({ limit: "2" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
    expect(typeof body.nextCursor).toBe("string");
  });

  it("returns 400 on a malformed cursor", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ cursor: "not_valid_base64_cursor" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid|malformed/i);
  });

  it("returns 400 when cursor sort does not match current sort", async () => {
    const filterHash = hashFilters({ q: null, category: null, sort: "price", direction: "desc" });
    const staleCursor = encodeRankedCursor({
      sortField: "price",
      sortDirection: "desc",
      filterHash,
      createdAt: "10.000000",
      id: "svc_old",
    });

    const { GET } = await import("../route");
    // Request uses sort=createdAt but cursor was built for sort=price
    const res = await GET(makeRequest({ sort: "createdAt", cursor: staleCursor }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sort|filter|match/i);
  });

  it("returns 400 when cursor filter hash does not match current filters", async () => {
    // Cursor was built without a category filter
    const filterHash = hashFilters({ q: null, category: null, sort: "createdAt", direction: "desc" });
    const staleCursor = encodeRankedCursor({
      sortField: "createdAt",
      sortDirection: "desc",
      filterHash,
      createdAt: NOW.toISOString(),
      id: "svc_old",
    });

    const { GET } = await import("../route");
    // But now a category filter is added → hash mismatch
    const res = await GET(makeRequest({ category: "automation", cursor: staleCursor }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sort|filter|match/i);
  });

  it("accepts a valid cursor that matches sort and filters", async () => {
    const filterHash = hashFilters({ q: null, category: null, sort: "createdAt", direction: "desc" });
    const validCursor = encodeRankedCursor({
      sortField: "createdAt",
      sortDirection: "desc",
      filterHash,
      createdAt: NOW.toISOString(),
      id: "svc_prev",
    });
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest({ cursor: validCursor }));

    expect(res.status).toBe(200);
  });

  it("returns 400 for an invalid sort field", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ sort: "unknown_field" }));

    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid sort direction", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeRequest({ direction: "sideways" }));

    expect(res.status).toBe(400);
  });
});
