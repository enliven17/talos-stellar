import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import { listAuditLogs } from "../src/lib/audit-log/store";

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
