import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeEntryHash,
  GENESIS_HASH,
  AUDIT_CHAIN_VERSION,
  verifyAuditCheckpointBundle,
} from "../src/lib/audit-chain";
import {
  listAuditLogs,
  exportAuditCheckpointBundle,
} from "../src/lib/audit-log/store";

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

describe("exportAuditCheckpointBundle", () => {
  const hmacSecret = "store-checkpoint-secret-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSyntheticDbRows(count: number, talosId = "t-1") {
    const rows = [];
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < count; i++) {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 12, 0, i));
      const entryHash = computeEntryHash({
        sequenceNumber: i,
        talosId,
        method: "POST",
        path: `/api/talos/${talosId}/sign`,
        statusCode: 200,
        ipAddress: "127.0.0.1",
        createdAt: createdAt.toISOString(),
      });
      rows.push({
        id: `row_${i}`,
        talosId,
        method: "POST",
        path: `/api/talos/${talosId}/sign`,
        statusCode: 200,
        denialReason: null,
        scopesRequired: ["wallet:sign"],
        ipAddress: "127.0.0.1",
        sequenceNumber: i,
        previousHash: prevHash,
        entryHash,
        chainVersion: AUDIT_CHAIN_VERSION,
        createdAt,
      });
      prevHash = entryHash;
    }
    return rows;
  }

  it("queries bounded chained rows, builds a signed bundle, and verifies offline without DB access", async () => {
    const dbRows = makeSyntheticDbRows(3);
    // Descending order returned from DB when no lower bound is given
    mockDb.limit.mockResolvedValueOnce([...dbRows].reverse());

    const bundle = await exportAuditCheckpointBundle({
      talosId: "t-1",
      limit: 5,
      hmacSecret,
      exportedAt: "2026-01-01T13:00:00.000Z",
    });

    expect(mockDb.limit).toHaveBeenCalledWith(6);
    expect(bundle.talosId).toBe("t-1");
    expect(bundle.boundaries.entryCount).toBe(3);
    expect(bundle.boundaries.startSequence).toBe(0);
    expect(bundle.boundaries.endSequence).toBe(2);
    expect(bundle.boundaries.truncated).toBe(false);
    expect(bundle.chainRoot).toBe(dbRows[2].entryHash);

    const verified = verifyAuditCheckpointBundle(bundle, {
      hmacSecret,
      expectedTalosId: "t-1",
    });
    expect(verified.valid).toBe(true);
    expect(verified.verifiedEntries).toBe(3);
  });

  it("marks truncated=true when DB returns limit + 1 rows and preserves contiguous boundaries", async () => {
    const dbRows = makeSyntheticDbRows(4);
    // Simulate DB returning 3 rows (limit=2 -> limit+1=3) for tail query (seq 3, 2, 1)
    mockDb.limit.mockResolvedValueOnce([dbRows[3], dbRows[2], dbRows[1]]);

    const bundle = await exportAuditCheckpointBundle({
      talosId: "t-1",
      limit: 2,
      hmacSecret,
    });

    expect(mockDb.limit).toHaveBeenCalledWith(3);
    expect(bundle.boundaries.truncated).toBe(true);
    expect(bundle.boundaries.entryCount).toBe(2);
    expect(bundle.boundaries.startSequence).toBe(2);
    expect(bundle.boundaries.endSequence).toBe(3);
    expect(bundle.boundaries.previousChainHash).toBe(dbRows[1].entryHash);

    const verified = verifyAuditCheckpointBundle(bundle, {
      hmacSecret,
      expectedPreviousChainHash: dbRows[1].entryHash,
    });
    expect(verified.valid).toBe(true);
    expect(verified.verifiedEntries).toBe(2);
  });

  it("rejects invalid filter boundaries (empty talosId, negative sequence, reversed sequence or date range)", async () => {
    await expect(
      exportAuditCheckpointBundle({ talosId: "   " }),
    ).rejects.toThrow(/talosId is required/);

    await expect(
      exportAuditCheckpointBundle({ talosId: "t-1", fromSequence: -1 }),
    ).rejects.toThrow(/fromSequence must be a non-negative integer/);

    await expect(
      exportAuditCheckpointBundle({
        talosId: "t-1",
        fromSequence: 10,
        toSequence: 5,
      }),
    ).rejects.toThrow(/fromSequence must be less than or equal to toSequence/);

    await expect(
      exportAuditCheckpointBundle({
        talosId: "t-1",
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/from must be earlier than or equal to to/);
  });
});
