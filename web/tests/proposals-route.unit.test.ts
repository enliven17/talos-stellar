/**
 * Unit tests for GET /api/proposals filters + cursor pagination.
 * The db is mocked; we render the drizzle WHERE clause to SQL so we can assert
 * that each filter and the keyset cursor really reach the query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  proposalRows: [] as unknown[],
  talosRows: [] as unknown[],
  whereArgs: [] as unknown[],
  limitArgs: [] as number[],
  call: 0,
}));

function chain(kind: "proposals" | "talos") {
  const obj: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "groupBy", "orderBy"]) obj[m] = vi.fn(() => obj);
  obj.where = vi.fn((arg: unknown) => {
    state.whereArgs.push(arg);
    return obj;
  });
  obj.limit = vi.fn((n: number) => {
    state.limitArgs.push(n);
    return obj;
  });
  obj.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(kind === "proposals" ? state.proposalRows : state.talosRows).then(resolve);
  return obj;
}

vi.mock("@/db", () => ({
  db: {
    // 1st select() = proposals page, 2nd select() = talos facet
    select: vi.fn(() => chain(state.call++ === 0 ? "proposals" : "talos")),
  },
}));

import { GET } from "@/app/api/proposals/route";
import { decodeProposalCursor, encodeProposalCursor } from "@/app/api/proposals/cursor";

const dialect = new PgDialect();
const lastWhereSql = () => dialect.sqlToQuery(state.whereArgs[0] as SQL);

function req(query = "") {
  return new NextRequest(`http://localhost/api/proposals${query}`);
}

function row(n: number) {
  return {
    id: `p${n}`,
    talosId: "t1",
    talosName: "Alpha",
    type: "policy",
    title: `Proposal ${n}`,
    description: null,
    amount: null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    txHash: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - n)),
  };
}

beforeEach(() => {
  state.proposalRows = [];
  state.talosRows = [{ id: "t1", name: "Alpha" }];
  state.whereArgs = [];
  state.limitArgs = [];
  state.call = 0;
});

describe("GET /api/proposals — filters", () => {
  it("applies no WHERE clause when no filters are given", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(state.whereArgs[0]).toBeUndefined();
  });

  it("filters by talosId, type and status together", async () => {
    const res = await GET(req("?talosId=t1&type=policy&status=pending"));
    expect(res.status).toBe(200);
    const { sql, params } = lastWhereSql();
    expect(sql).toContain('"tls_approvals"."status" = $');
    expect(sql).toContain('"tls_approvals"."talosId" = $');
    expect(sql).toContain('"tls_approvals"."type" = $');
    expect(params).toEqual(expect.arrayContaining(["pending", "t1", "policy"]));
  });

  it("rejects an unknown type with 400", async () => {
    const res = await GET(req("?type=bogus"));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("type must be one of");
  });
});

describe("GET /api/proposals — cursor pagination", () => {
  it("returns a nextCursor when more rows exist and trims the extra row", async () => {
    state.proposalRows = [row(1), row(2), row(3)]; // limit 2 -> 3 fetched
    const body = await (await GET(req("?limit=2"))).json();

    expect(state.limitArgs[0]).toBe(3); // limit + 1
    expect(body.proposals.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);
    expect(decodeProposalCursor(body.nextCursor)).toEqual({
      createdAt: row(2).createdAt,
      id: "p2",
    });
  });

  it("returns nextCursor null on the last page", async () => {
    state.proposalRows = [row(1), row(2)];
    const body = await (await GET(req("?limit=2"))).json();
    expect(body.proposals).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("turns a cursor into a (createdAt, id) keyset condition", async () => {
    const cursor = encodeProposalCursor(row(2));
    const res = await GET(req(`?cursor=${cursor}&talosId=t1`));
    expect(res.status).toBe(200);
    const { sql, params } = lastWhereSql();
    expect(sql).toContain('"tls_approvals"."createdAt" <');
    expect(sql).toContain('"tls_approvals"."id" <');
    expect(params).toContain("p2");
    expect(params).toContain("t1"); // filters and cursor combine
  });

  it("includes the talos facet only on the first page", async () => {
    const first = await (await GET(req())).json();
    expect(first.talos).toEqual([{ id: "t1", name: "Alpha" }]);

    state.call = 0;
    const next = await (await GET(req(`?cursor=${encodeProposalCursor(row(2))}`))).json();
    expect(next.talos).toBeUndefined();
  });

  it.each(["not-base64-json", "e30", "x".repeat(600)])(
    "rejects malformed cursor %#",
    async (bad) => {
      const res = await GET(req(`?cursor=${bad}`));
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("Invalid cursor");
    },
  );

  it("still enforces the existing limit rules", async () => {
    expect((await GET(req("?limit=101"))).status).toBe(400);
    expect((await GET(req("?limit=0"))).status).toBe(400);
  });
});
