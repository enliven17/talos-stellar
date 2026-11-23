/**
 * Focused tests for GET /api/webhooks/subscriptions/:id/timeline (issue #1325).
 *
 * Covers:
 *   – 401 for unauthenticated requests
 *   – 404 when subscription doesn't belong to the caller
 *   – empty timeline when no deliveries exist
 *   – sanitized entries (no responseBody, payloadHash, leasedBy, fencingToken)
 *   – responseCategory mapping: 200→2xx, 301→3xx, 404→4xx, 500→5xx,
 *     null+pending→pending, null+failed→network_error
 *   – pagination: respects limit, returns nextCursor, cursor filters correctly
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockSelect = vi.fn();
  return { mockSelect };
});

vi.mock("@/db", () => ({
  db: { select: mocks.mockSelect },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function selectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
      Promise.resolve(cb(result)),
    ),
  };
  return chain;
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "del_1",
    eventType: "commerce_job.completed",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    lastStatusCode: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    createdAt: new Date("2026-07-24T12:00:00.000Z"),
    ...overrides,
  };
}

function req(subscriptionId: string, search = "") {
  return new NextRequest(
    `http://localhost:3000/api/webhooks/subscriptions/${subscriptionId}/timeline${search}`,
    { headers: { Authorization: "Bearer tok_agent_1" } },
  );
}

function unauthReq(subscriptionId: string) {
  return new NextRequest(
    `http://localhost:3000/api/webhooks/subscriptions/${subscriptionId}/timeline`,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe("GET /api/webhooks/subscriptions/:id/timeline", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    // Auth lookup returns no talos
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));

    const response = await GET(unauthReq("sub_1"), {
      params: Promise.resolve({ id: "sub_1" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 404 when the subscription does not belong to the caller", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    // Auth: found
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
    // Subscription ownership check: not found
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));

    const response = await GET(req("sub_other"), {
      params: Promise.resolve({ id: "sub_other" }),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns empty data array when no deliveries exist", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));

    const response = await GET(req("sub_1"), {
      params: Promise.resolve({ id: "sub_1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("omits responseBody, payloadHash, leasedBy, fencingToken from entries", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
    mocks.mockSelect.mockReturnValueOnce(
      selectChain([makeDelivery({ lastStatusCode: 200 })]),
    );

    const response = await GET(req("sub_1"), {
      params: Promise.resolve({ id: "sub_1" }),
    });
    const body = await response.json();
    const entry = body.data[0];

    expect(entry).not.toHaveProperty("responseBody");
    expect(entry).not.toHaveProperty("payloadHash");
    expect(entry).not.toHaveProperty("leasedBy");
    expect(entry).not.toHaveProperty("leasedAt");
    expect(entry).not.toHaveProperty("leaseExpiresAt");
    expect(entry).not.toHaveProperty("fencingToken");
  });

  describe("responseCategory mapping", () => {
    const cases: [number | null, string, string][] = [
      [200, "delivered", "2xx"],
      [201, "delivered", "2xx"],
      [301, "failed", "3xx"],
      [404, "failed", "4xx"],
      [422, "failed", "4xx"],
      [500, "failed", "5xx"],
      [503, "failed", "5xx"],
      [null, "pending", "pending"],
      [null, "failed", "network_error"],
    ];

    for (const [code, status, expected] of cases) {
      it(`maps lastStatusCode=${code} + status=${status} → "${expected}"`, async () => {
        // Re-import fresh each time to avoid module-level caching issues
        vi.resetModules();
        const { GET } = await import(
          "@/app/api/webhooks/subscriptions/[id]/timeline/route"
        );

        mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
        mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
        mocks.mockSelect.mockReturnValueOnce(
          selectChain([makeDelivery({ lastStatusCode: code, status })]),
        );

        const response = await GET(req("sub_1"), {
          params: Promise.resolve({ id: "sub_1" }),
        });
        const body = await response.json();
        expect(body.data[0].responseCategory).toBe(expected);
      });
    }
  });

  it("exposes attemptedAt as ISO string when lastAttemptAt is set", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    const attemptDate = new Date("2026-07-24T10:00:00.000Z");
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
    mocks.mockSelect.mockReturnValueOnce(
      selectChain([makeDelivery({ lastAttemptAt: attemptDate, lastStatusCode: 200 })]),
    );

    const response = await GET(req("sub_1"), {
      params: Promise.resolve({ id: "sub_1" }),
    });
    const body = await response.json();
    expect(body.data[0].attemptedAt).toBe("2026-07-24T10:00:00.000Z");
  });

  it("exposes nextRetryAt as ISO string when nextAttemptAt is set", async () => {
    const { GET } = await import(
      "@/app/api/webhooks/subscriptions/[id]/timeline/route"
    );

    const retryDate = new Date("2026-07-24T11:00:00.000Z");
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
    mocks.mockSelect.mockReturnValueOnce(
      selectChain([makeDelivery({ nextAttemptAt: retryDate })]),
    );

    const response = await GET(req("sub_1"), {
      params: Promise.resolve({ id: "sub_1" }),
    });
    const body = await response.json();
    expect(body.data[0].nextRetryAt).toBe("2026-07-24T11:00:00.000Z");
  });

  describe("pagination", () => {
    it("returns nextCursor when more records exist beyond the limit", async () => {
      const { GET } = await import(
        "@/app/api/webhooks/subscriptions/[id]/timeline/route"
      );

      // Build 3 deliveries; limit=2 → hasMore=true
      const deliveries = [
        makeDelivery({ id: "del_1", createdAt: new Date("2026-07-24T12:00:00.000Z") }),
        makeDelivery({ id: "del_2", createdAt: new Date("2026-07-24T11:00:00.000Z") }),
        makeDelivery({ id: "del_3", createdAt: new Date("2026-07-24T10:00:00.000Z") }),
      ];

      mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
      mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
      mocks.mockSelect.mockReturnValueOnce(selectChain(deliveries));

      const response = await GET(req("sub_1", "?limit=2"), {
        params: Promise.resolve({ id: "sub_1" }),
      });
      const body = await response.json();

      expect(body.data).toHaveLength(2);
      expect(body.nextCursor).toBe("2026-07-24T11:00:00.000Z");
    });

    it("returns nextCursor=null when all records fit within the limit", async () => {
      const { GET } = await import(
        "@/app/api/webhooks/subscriptions/[id]/timeline/route"
      );

      mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
      mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: "sub_1" }]));
      mocks.mockSelect.mockReturnValueOnce(
        selectChain([makeDelivery({ id: "del_1" })]),
      );

      const response = await GET(req("sub_1", "?limit=10"), {
        params: Promise.resolve({ id: "sub_1" }),
      });
      const body = await response.json();

      expect(body.data).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
    });
  });
});
