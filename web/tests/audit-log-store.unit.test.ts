import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import {
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  computeEntryHash,
  type AuditChainEntry,
} from "../src/lib/audit-chain";
import { listAuditLogs, verifyAuditChainRange } from "../src/lib/audit-log/store";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  },
}));

vi.mock("@/db", () => ({
  db: mockDb,
}));

describe("listAuditLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns formatted logs and nextCursor when there are more results", async () => {
    const mockDate = new Date("2026-10-17T12:00:00.000Z");
    const mockRows = [
      {
        id: "1",
        talosId: "t-1",
        method: "GET",
        path: "/api/test",
        statusCode: 200,
        denialReason: null,
        scopesRequired: null,
        ipAddress: "127.0.0.1",
        sequenceNumber: 1,
        previousHash: "hash1",
        entryHash: "hash2",
        chainVersion: "1",
        createdAt: mockDate,
      },
      {
        id: "2",
        talosId: "t-1",
        method: "GET",
        path: "/api/test2",
        statusCode: 200,
        denialReason: null,
        scopesRequired: null,
        ipAddress: "127.0.0.1",
        sequenceNumber: 1,
        previousHash: "hash1",
        entryHash: "hash2",
        chainVersion: "1",
        createdAt: new Date("2026-10-17T11:00:00.000Z"),
      },
    ];

    // Return 2 rows when limit is 1 (limit + 1 = 2), meaning hasMore is true
    mockDb.limit.mockResolvedValueOnce(mockRows);

    const result = await listAuditLogs({ limit: 1 });

    expect(mockDb.limit).toHaveBeenCalledWith(2);
    expect(result.logs).toHaveLength(1);
    expect(result.nextCursor).toBe(mockDate.toISOString());
    expect(result.logs[0]).toMatchObject({
      id: "1",
      method: "GET",
      path: "/api/test",
      createdAt: mockDate.toISOString(),
    });
  });

  it("returns null nextCursor when there are no more results", async () => {
    const mockRows = [
      {
        id: "1",
        talosId: "t-1",
        method: "GET",
        path: "/api/test",
        statusCode: 200,
        denialReason: null,
        scopesRequired: null,
        ipAddress: null,
        sequenceNumber: 1,
        previousHash: "hash1",
        entryHash: "hash2",
        chainVersion: "1",
        createdAt: new Date(),
      },
    ];

    // Return 1 row when limit is 50 (50 + 1 = 51), meaning hasMore is false
    mockDb.limit.mockResolvedValueOnce(mockRows);

    const result = await listAuditLogs({ limit: 50 });

    expect(result.logs).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("applies all filters correctly", async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    const date = new Date().toISOString();

    await listAuditLogs({
      talosId: "t-1",
      method: "POST",
      statusCode: 404,
      denialReason: "unauthorized",
      q: "test",
      from: date,
      to: date,
      cursor: date,
      limit: 10,
    });

    // We expect the where clause to have been called with a complex SQL object
    expect(mockDb.where).toHaveBeenCalledTimes(1);
    // Verify it's building a valid condition (not undefined)
    expect(mockDb.where.mock.calls[0][0]).toBeDefined();
  });

  it("uses a default limit of 50 and clamps to 200", async () => {
    mockDb.limit.mockResolvedValue([]);

    // Default limit
    await listAuditLogs({});
    expect(mockDb.limit).toHaveBeenCalledWith(51);

    // Exceeding max limit
    await listAuditLogs({ limit: 500 });
    expect(mockDb.limit).toHaveBeenCalledWith(201);
  });

  it("propagates database errors", async () => {
    mockDb.limit.mockRejectedValueOnce(new Error("Database connection failed"));

    await expect(listAuditLogs({})).rejects.toThrow("Database connection failed");
  });
});

describe("verifyAuditChainRange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeChainedRow(seq: number, prevHash: string, createdAtIso: string) {
    const entry: AuditChainEntry = {
      sequenceNumber: seq,
      talosId: "t-1",
      method: "POST",
      path: "/api/talos/t-1/sign",
      statusCode: 200,
      ipAddress: "127.0.0.1",
      createdAt: createdAtIso,
    };
    return {
      sequenceNumber: seq,
      previousHash: prevHash,
      entryHash: computeEntryHash(entry),
      chainVersion: AUDIT_CHAIN_VERSION,
      talosId: entry.talosId,
      method: entry.method,
      path: entry.path,
      statusCode: entry.statusCode,
      ipAddress: entry.ipAddress,
      createdAt: new Date(createdAtIso),
    };
  }

  it("queries predecessor before `from` and verifies a valid mid-chain range", async () => {
    const r0 = makeChainedRow(0, GENESIS_HASH, "2026-01-01T00:00:00.000Z");
    const r1 = makeChainedRow(1, r0.entryHash, "2026-01-01T00:00:01.000Z");
    const r2 = makeChainedRow(2, r1.entryHash, "2026-01-01T00:00:02.000Z");
    const r3 = makeChainedRow(3, r2.entryHash, "2026-01-01T00:00:03.000Z");

    // 1st query: predecessor before `from`
    mockDb.limit.mockResolvedValueOnce([
      {
        sequenceNumber: r1.sequenceNumber,
        entryHash: r1.entryHash,
        createdAt: r1.createdAt,
      },
    ]);
    // 2nd query: ordered rows in `[from, to]`
    mockDb.limit.mockResolvedValueOnce([r2, r3]);

    const result = await verifyAuditChainRange({
      talosId: "t-1",
      from: "2026-01-01T00:00:02.000Z",
      to: "2026-01-01T00:00:03.000Z",
      limit: 100,
    });

    expect(mockDb.limit).toHaveBeenNthCalledWith(1, 1);
    expect(mockDb.limit).toHaveBeenNthCalledWith(2, 101);
    expect(result.valid).toBe(true);
    expect(result.status).toBe("valid");
    expect(result.complete).toBe(true);
    expect(result.verifiedEntries).toBe(2);
    expect(result.predecessorSequence).toBe(1);
    expect(result.startSequence).toBe(2);
    expect(result.endSequence).toBe(3);
  });

  it("reports incomplete when predecessor is missing before `from` for non-genesis range", async () => {
    const r0 = makeChainedRow(0, GENESIS_HASH, "2026-01-01T00:00:00.000Z");
    const r1 = makeChainedRow(1, r0.entryHash, "2026-01-01T00:00:01.000Z");
    const r2 = makeChainedRow(2, r1.entryHash, "2026-01-01T00:00:02.000Z");

    // Predecessor missing from DB (e.g. pruned or incomplete store)
    mockDb.limit.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([r1, r2]);

    const result = await verifyAuditChainRange({
      talosId: "t-1",
      from: "2026-01-01T00:00:01.000Z",
      to: "2026-01-01T00:00:02.000Z",
    });

    expect(result.valid).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("missing_predecessor");
    expect(result.brokenAtSequence).toBeNull();
  });

  it("reports incomplete when the time range is truncated by limit", async () => {
    const r0 = makeChainedRow(0, GENESIS_HASH, "2026-01-01T00:00:00.000Z");
    const r1 = makeChainedRow(1, r0.entryHash, "2026-01-01T00:00:01.000Z");

    // No `from` filter -> no predecessor query; returns 2 rows for limit=1 (limit+1=2)
    mockDb.limit.mockResolvedValueOnce([r0, r1]);

    const result = await verifyAuditChainRange({
      talosId: "t-1",
      to: "2026-01-01T00:00:05.000Z",
      limit: 1,
    });

    expect(result.valid).toBe(false);
    expect(result.status).toBe("incomplete");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("truncated_range");
    expect(result.verifiedEntries).toBe(1);
    expect(result.brokenAtSequence).toBeNull();
  });

  it("reports broken when predecessor hash does not match the range start", async () => {
    const r0 = makeChainedRow(0, GENESIS_HASH, "2026-01-01T00:00:00.000Z");
    const r1 = makeChainedRow(1, r0.entryHash, "2026-01-01T00:00:01.000Z");

    mockDb.limit.mockResolvedValueOnce([
      {
        sequenceNumber: 0,
        entryHash: "tampered-predecessor-hash",
        createdAt: r0.createdAt,
      },
    ]);
    mockDb.limit.mockResolvedValueOnce([r1]);

    const result = await verifyAuditChainRange({
      talosId: "t-1",
      from: "2026-01-01T00:00:01.000Z",
    });

    expect(result.valid).toBe(false);
    expect(result.status).toBe("broken");
    expect(result.failureReason).toBe("predecessor_mismatch");
    expect(result.brokenAtSequence).toBe(1);
  });
});
