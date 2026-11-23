/**
 * Unit tests for reproducible quota-window usage statements
 * (buildQuotaWindowStatement, exportQuotaWindowStatement, and
 * GET /api/talos/:id/quota?format=statement).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const makeSelectChain = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  };

  return {
    makeSelectChain,
    dbSelect: vi.fn(),
    verifyAgentApiKey: vi.fn(),
  };
});

vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
}));

vi.mock("@/lib/with-request-id", () => ({
  withRequestId: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import {
  buildQuotaWindowStatement,
  QUOTA_POLICY_VERSION,
  QUOTA_STATEMENT_SCHEMA_VERSION,
  type QuotaWindowStatementResourceInput,
} from "@/lib/quota";
import { GET } from "@/app/api/talos/[id]/quota/route";

const TALOS_ID = "talos_agent_01";

describe("buildQuotaWindowStatement", () => {
  it("produces byte-for-byte reproducible statements and identical digests across timestamps in the same UTC window", () => {
    const resourcesA: QuotaWindowStatementResourceInput[] = [
      {
        resource: "revenue_writes",
        windowSize: "daily",
        enabled: true,
        policySource: "platform_default",
        limit: 500,
        used: 120,
      },
      {
        resource: "activity_writes",
        windowSize: "daily",
        enabled: true,
        policySource: "agent_override",
        limit: 1000,
        used: 250,
      },
    ];

    // Reversed input order + different time within the same UTC day
    const resourcesB = [...resourcesA].reverse();

    const stmt1 = buildQuotaWindowStatement({
      talosId: TALOS_ID,
      asOf: new Date("2026-07-24T00:05:12.345Z"),
      resources: resourcesA,
    });

    const stmt2 = buildQuotaWindowStatement({
      talosId: TALOS_ID,
      asOf: new Date("2026-07-24T23:59:59.999Z"),
      resources: resourcesB,
    });

    expect(JSON.stringify(stmt1)).toBe(JSON.stringify(stmt2));
    expect(stmt1.digest).toBe(stmt2.digest);
    expect(stmt1.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stmt1.schemaVersion).toBe(QUOTA_STATEMENT_SCHEMA_VERSION);
    expect(stmt1.sourcePolicyVersion).toBe(QUOTA_POLICY_VERSION);
    // Canonical resource ordering (activity_writes before revenue_writes)
    expect(stmt1.entries.map((e) => e.resource)).toEqual([
      "activity_writes",
      "revenue_writes",
    ]);
  });

  it("computes stable UTC window boundaries and strict integer units for hourly, daily, and monthly windows", () => {
    const stmt = buildQuotaWindowStatement({
      talosId: TALOS_ID,
      asOf: new Date("2026-12-31T23:45:30.500Z"),
      sourcePolicyVersion: "quota-policy/v2",
      resources: [
        {
          resource: "sse_connections",
          windowSize: "hourly",
          enabled: true,
          policySource: "platform_default",
          limit: 10,
          used: 10,
        },
        {
          resource: "activity_writes",
          windowSize: "daily",
          enabled: true,
          policySource: "agent_override",
          limit: 100,
          used: 125,
        },
        {
          resource: "job_writes",
          windowSize: "monthly",
          enabled: false,
          policySource: "fallback",
          limit: 10_000,
          used: 0,
        },
      ],
    });

    expect(stmt.sourcePolicyVersion).toBe("quota-policy/v2");

    const byResource = Object.fromEntries(stmt.entries.map((e) => [e.resource, e]));

    // Hourly boundary
    expect(byResource.sse_connections.windowStart).toBe("2026-12-31T23:00:00.000Z");
    expect(byResource.sse_connections.windowEnd).toBe("2027-01-01T00:00:00.000Z");
    expect(byResource.sse_connections.remaining).toBe(0);
    expect(byResource.sse_connections.overage).toBe(0);
    expect(byResource.sse_connections.withinQuota).toBe(true);

    // Daily boundary with overage
    expect(byResource.activity_writes.windowStart).toBe("2026-12-31T00:00:00.000Z");
    expect(byResource.activity_writes.windowEnd).toBe("2027-01-01T00:00:00.000Z");
    expect(byResource.activity_writes.remaining).toBe(0);
    expect(byResource.activity_writes.overage).toBe(25);
    expect(byResource.activity_writes.withinQuota).toBe(false);

    // Monthly boundary rolling over year
    expect(byResource.job_writes.windowStart).toBe("2026-12-01T00:00:00.000Z");
    expect(byResource.job_writes.windowEnd).toBe("2027-01-01T00:00:00.000Z");
    expect(byResource.job_writes.remaining).toBe(10_000);
    expect(byResource.job_writes.overage).toBe(0);
    expect(byResource.job_writes.withinQuota).toBe(true);

    // All numeric fields are safe integers
    for (const entry of stmt.entries) {
      expect(Number.isSafeInteger(entry.windowStartMs)).toBe(true);
      expect(Number.isSafeInteger(entry.windowEndMs)).toBe(true);
      expect(Number.isSafeInteger(entry.limit)).toBe(true);
      expect(Number.isSafeInteger(entry.used)).toBe(true);
      expect(Number.isSafeInteger(entry.remaining)).toBe(true);
      expect(Number.isSafeInteger(entry.overage)).toBe(true);
      expect(entry.unit).toBe("requests");
    }

    expect(stmt.totals).toEqual({
      resources: 3,
      limit: 10_110,
      used: 135,
      remaining: 10_000,
      overage: 25,
    });
  });

  it("omits private request payloads and free-form notes from the exported statement", () => {
    const leakyInput = {
      resource: "activity_writes" as const,
      windowSize: "daily" as const,
      enabled: true,
      policySource: "agent_override" as const,
      limit: 500,
      used: 10,
      notes: "secret internal operator note",
      requestBody: { prompt: "private user payload" },
      payload: "sensitive-body",
      headers: { authorization: "Bearer super-secret-token" },
      apiKey: "sk_live_secret",
    } as QuotaWindowStatementResourceInput;

    const stmt = buildQuotaWindowStatement({
      talosId: TALOS_ID,
      asOf: new Date("2026-07-24T12:00:00.000Z"),
      resources: [leakyInput],
    });

    const serialized = JSON.stringify(stmt);
    expect(serialized).not.toContain("secret internal operator note");
    expect(serialized).not.toContain("private user payload");
    expect(serialized).not.toContain("sensitive-body");
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("sk_live_secret");
  });

  it("rejects invalid agent id, non-integer counts, negative counts, and invalid dates", () => {
    const validResource: QuotaWindowStatementResourceInput = {
      resource: "activity_writes",
      windowSize: "daily",
      enabled: true,
      policySource: "platform_default",
      limit: 100,
      used: 5,
    };

    expect(() =>
      buildQuotaWindowStatement({
        talosId: "   ",
        asOf: new Date("2026-07-24T12:00:00.000Z"),
        resources: [validResource],
      }),
    ).toThrow(/talosId/);

    expect(() =>
      buildQuotaWindowStatement({
        talosId: TALOS_ID,
        asOf: new Date("not-a-date"),
        resources: [validResource],
      }),
    ).toThrow(/asOf/);

    expect(() =>
      buildQuotaWindowStatement({
        talosId: TALOS_ID,
        asOf: new Date("2026-07-24T12:00:00.000Z"),
        resources: [{ ...validResource, used: 1.5 }],
      }),
    ).toThrow(/non-negative safe integer/);

    expect(() =>
      buildQuotaWindowStatement({
        talosId: TALOS_ID,
        asOf: new Date("2026-07-24T12:00:00.000Z"),
        resources: [{ ...validResource, limit: -1 }],
      }),
    ).toThrow(/non-negative safe integer/);

    expect(() =>
      buildQuotaWindowStatement({
        talosId: TALOS_ID,
        asOf: new Date("2026-07-24T12:00:00.000Z"),
        resources: [validResource, validResource],
      }),
    ).toThrow(/Duplicate quota resource/);
  });
});

describe("GET /api/talos/:id/quota?format=statement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the caller is not authorized for the agent", async () => {
    mocks.verifyAgentApiKey.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const req = new NextRequest(
      `http://localhost/api/talos/${TALOS_ID}/quota?format=statement`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: TALOS_ID }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 when asOf query parameter is invalid", async () => {
    mocks.verifyAgentApiKey.mockResolvedValueOnce({ ok: true });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([{ id: TALOS_ID }]));

    const req = new NextRequest(
      `http://localhost/api/talos/${TALOS_ID}/quota?format=statement&asOf=invalid-date`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: TALOS_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid asOf/);
  });

  it("returns a reproducible statement with digest header for one authorized agent", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: true });
    mocks.dbSelect
      .mockReturnValueOnce(mocks.makeSelectChain([{ id: TALOS_ID }]))
      .mockImplementation(() => mocks.makeSelectChain([]));

    const req = new NextRequest(
      `http://localhost/api/talos/${TALOS_ID}/quota?format=statement&asOf=2026-07-24T12:30:00Z`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: TALOS_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json();
    expect(body.talosId).toBe(TALOS_ID);
    expect(body.sourcePolicyVersion).toBe(QUOTA_POLICY_VERSION);
    expect(body.entries).toHaveLength(4);
    expect(res.headers.get("X-Quota-Statement-Digest")).toBe(body.digest);
  });
});
