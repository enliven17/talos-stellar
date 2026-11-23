import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((cb: (r: unknown) => unknown) =>
    Promise.resolve(cb(result)),
  );
  return chain;
}

function makeRequest(id: string) {
  return new NextRequest(
    `http://localhost:3000/api/talos/${id}/audit/integrity`,
  );
}

const NOW = new Date("2025-06-01T12:00:00.000Z");
const FRESH_TS = new Date(NOW.getTime() - 10 * 60 * 1_000); // 10 min ago
const STALE_TS = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000); // 2 hours ago

function makeAuditRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sequenceNumber: 0,
    entryHash: "aabbccdd".repeat(8),
    previousHash: "GENESIS",
    chainVersion: "1",
    talosId: "talos_1",
    method: "GET",
    path: "/api/test",
    statusCode: 200,
    ipAddress: null,
    createdAt: FRESH_TS,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/talos/[id]/audit/integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with status=ok when chain is valid and checkpoint is fresh", async () => {
    // agent exists
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_1" }]))
      // sampled entries (empty → chain trivially valid)
      .mockReturnValueOnce(makeSelectChain([]))
      // checkpoint row (fresh)
      .mockReturnValueOnce(makeSelectChain([{ createdAt: FRESH_TS }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_1"), {
      params: Promise.resolve({ id: "talos_1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Empty chain is valid; fresh checkpoint → "ok"
    expect(body.status).toBe("ok");
    expect(body.chainValid).toBe(true);
    expect(body.checkpointFresh).toBe(true);
  });

  it("returns 200 with status=checkpoint_stale when no checkpoint exists", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_2" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([])); // no checkpoint rows

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_2"), {
      params: Promise.resolve({ id: "talos_2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("checkpoint_stale");
    expect(body.checkpointStale).toBe(true);
    expect(body.lastCheckpointAt).toBeNull();
  });

  it("returns 200 with status=checkpoint_stale when checkpoint is old", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_3" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ createdAt: STALE_TS }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_3"), {
      params: Promise.resolve({ id: "talos_3" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("checkpoint_stale");
    expect(body.checkpointStale).toBe(true);
  });

  it("returns 200 with sampledEntries bounded by AUDIT_INTEGRITY_SAMPLE_SIZE", async () => {
    // The route queries with .limit(AUDIT_INTEGRITY_SAMPLE_SIZE) — verify the
    // returned report reflects the actual number of rows returned.
    const fakeRows = [makeAuditRow()];
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_4" }]))
      .mockReturnValueOnce(makeSelectChain(fakeRows))
      .mockReturnValueOnce(makeSelectChain([{ createdAt: FRESH_TS }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_4"), {
      params: Promise.resolve({ id: "talos_4" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // sampledEntries equals the number of rows returned from the DB
    expect(body.sampledEntries).toBe(fakeRows.length);
  });

  it("returns 200 with all required fields", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_5" }]))
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ createdAt: FRESH_TS }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_5"), {
      params: Promise.resolve({ id: "talos_5" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("chainValid");
    expect(body).toHaveProperty("checkpointFresh");
    expect(body).toHaveProperty("sampledEntries");
    expect(body).toHaveProperty("brokenAtSequence");
    expect(body).toHaveProperty("lastVerifiedAt");
    expect(body).toHaveProperty("lastCheckpointAt");
    expect(body).toHaveProperty("checkpointAgeMs");
    expect(body).toHaveProperty("checkpointStale");
    expect(body).toHaveProperty("status");
  });

  it("returns 404 when agent does not exist", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("nonexistent"), {
      params: Promise.resolve({ id: "nonexistent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});
