import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  responses: [] as unknown[][],
  whereArgs: [] as unknown[],
  queries: [] as Record<string, unknown>[],
}));

function makeQuery(index: number) {
  const query: Record<string, unknown> = {};
  state.queries.push(query);
  for (const method of ["from", "orderBy"]) query[method] = vi.fn(() => query);
  query.where = vi.fn((condition: unknown) => {
    state.whereArgs.push(condition);
    return query;
  });
  query.limit = vi.fn(() => Promise.resolve(state.responses[index]));
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(state.responses[index]).then(resolve, reject);
  return query;
}

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/db", () => ({ db: mockDb }));

import { getAgentAuditReviewBundle } from "@/lib/audit-log/store";

function auditRow(talosId: string, id: string) {
  return {
    id,
    talosId,
    method: "POST",
    path: "/api/talos/agent-1/transfer",
    statusCode: 200,
    denialReason: null,
    scopesRequired: ["wallet:sign"],
    ipAddress: "127.0.0.1",
    sequenceNumber: 1,
    previousHash: "previous",
    entryHash: "entry",
    chainVersion: "1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    apiKey: "must-not-be-returned",
    requestBody: { secret: "must-not-be-returned" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.responses = [];
  state.whereArgs = [];
  state.queries = [];
  mockDb.select.mockImplementation(() => makeQuery(mockDb.select.mock.calls.length - 1));
});

describe("getAgentAuditReviewBundle", () => {
  it("bounds references, scopes all queries to the requested agent, and omits credentials", async () => {
    state.responses = [
      [auditRow("agent-1", "audit-1"), auditRow("agent-1", "audit-2")],
      [{ entryHash: "chain-root", chainVersion: "1" }],
      [{ total: 4 }],
    ];

    const result = await getAgentAuditReviewBundle("agent-1", 1, "2025-12-31T00:00:00.000Z");

    expect(state.queries[0].limit).toHaveBeenCalledWith(2);
    expect(state.queries[1].limit).toHaveBeenCalledWith(1);
    expect(result.auditReferences).toHaveLength(1);
    expect(result.auditReferences[0].id).toBe("audit-1");
    expect(result.nextCursor).toBe("2026-01-01T00:00:00.000Z");
    expect(result.checkpoint).toMatchObject({ chainRoot: "chain-root", totalEntries: 4, chainVersion: "1" });
    expect(JSON.stringify(result)).not.toMatch(/apiKey|requestBody|must-not-be-returned/);
    expect(state.whereArgs).toHaveLength(3);
    for (const condition of state.whereArgs) {
      expect(new PgDialect().sqlToQuery(condition as SQL).params).toContain("agent-1");
    }
    const referenceQuery = new PgDialect().sqlToQuery(state.whereArgs[0] as SQL);
    expect(referenceQuery.sql).toContain('"createdAt" <');
    expect(referenceQuery.params.some((value) => String(value).startsWith("2025-12-31"))).toBe(true);
  });

  it("returns an empty checkpoint for an agent with no chained records", async () => {
    state.responses = [[], [], [{ total: 0 }]];

    const result = await getAgentAuditReviewBundle("agent-empty", 50);

    expect(result.auditReferences).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.checkpoint).toMatchObject({ chainRoot: null, totalEntries: 0, chainVersion: null });
  });
});
