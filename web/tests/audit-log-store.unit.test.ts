import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import {
  exportAuditLogs,
  listAuditLogs,
  serializeAuditLogExport,
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

describe("exportAuditLogs / serializeAuditLogExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates a bounded safe filename from validated identifiers while preserving Unicode inside exported data", async () => {
    const mockDate = new Date("2026-10-17T12:00:00.000Z");
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "audit_1",
        talosId: "tal_valid_1",
        method: "POST",
        path: "/api/talos/tal_valid_1/sign?note=こんにちは-🚀",
        statusCode: 403,
        denialReason: "insufficient_scopes: Ωμέγα-अभिनेता",
        scopesRequired: ["wallet:sign", "commerce:write"],
        ipAddress: "127.0.0.1",
        sequenceNumber: 0,
        previousHash: "GENESIS",
        entryHash: "a".repeat(64),
        chainVersion: "1",
        createdAt: mockDate,
      },
    ]);

    const jsonBundle = await exportAuditLogs(
      {
        talosId: "tal_valid_1",
        q: "こんにちは-🚀",
        denialReason: "insufficient_scopes: Ωμέγα-अभिनेता",
      },
      {
        format: "json",
        exportedAt: mockDate,
      },
    );

    expect(jsonBundle.filename).toBe("audit-logs-tal_valid_1-20261017T120000Z.json");
    expect(jsonBundle.contentDisposition).toBe(
      'attachment; filename="audit-logs-tal_valid_1-20261017T120000Z.json"',
    );
    expect(jsonBundle.contentType).toBe("application/json; charset=utf-8");
    expect(jsonBundle.filename).not.toContain("こんにちは");
    expect(jsonBundle.filename).not.toContain("🚀");
    expect(jsonBundle.filename).not.toContain("Ωμέγα");

    // Unicode is preserved inside the exported JSON payload
    expect(jsonBundle.data).toContain("こんにちは-🚀");
    expect(jsonBundle.data).toContain("Ωμέγα-अभिनेता");
  });

  it("strips untrusted actor text or Unicode from filename when talosId filter contains untrusted input, preserving Unicode in CSV data", async () => {
    const mockDate = new Date("2026-10-17T12:00:00.000Z");
    const untrustedActorId = 'actor-🚀-Ümlaut"; filename="pwn.csv';
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "audit_2",
        talosId: untrustedActorId,
        method: "GET",
        path: "/api/talos/🚀/status",
        statusCode: 403,
        denialReason: "expired_key_🔑",
        scopesRequired: null,
        ipAddress: "10.0.0.1",
        sequenceNumber: 1,
        previousHash: "b".repeat(64),
        entryHash: "c".repeat(64),
        chainVersion: "1",
        createdAt: mockDate,
      },
    ]);

    const csvBundle = await exportAuditLogs(
      {
        talosId: untrustedActorId,
      },
      {
        format: "csv",
        exportedAt: mockDate,
      },
    );

    expect(csvBundle.filename).toBe("audit-logs-filtered-20261017T120000Z.csv");
    expect(csvBundle.contentDisposition).toBe(
      'attachment; filename="audit-logs-filtered-20261017T120000Z.csv"',
    );
    expect(csvBundle.contentType).toBe("text/csv; charset=utf-8");
    expect(csvBundle.filename).not.toContain("pwn.csv");
    expect(csvBundle.filename).not.toContain("🚀");
    expect(csvBundle.filename).not.toContain("Ümlaut");

    // Unicode and escaped quotes are preserved inside the CSV data payload
    expect(csvBundle.data).toContain("/api/talos/🚀/status");
    expect(csvBundle.data).toContain("expired_key_🔑");
    expect(csvBundle.data).toContain('actor-🚀-Ümlaut""; filename=""pwn.csv');
  });

  it("neutralizes spreadsheet formula prefixes in CSV cells while keeping Unicode intact", () => {
    const csv = serializeAuditLogExport(
      [
        {
          id: "audit_3",
          talosId: "tal_1",
          method: "POST",
          path: "=CMD|' /C calc'!A0_ユニコード",
          statusCode: 403,
          denialReason: "@SUM(1+1)_Δοκιμή",
          scopesRequired: ["admin"],
          ipAddress: "127.0.0.1",
          sequenceNumber: null,
          previousHash: null,
          entryHash: null,
          chainVersion: null,
          createdAt: "2026-10-17T12:00:00.000Z",
        },
      ],
      { format: "csv" },
    );

    expect(csv).toContain("\"'=CMD|' /C calc'!A0_ユニコード\"");
    expect(csv).toContain("\"'@SUM(1+1)_Δοκιμή\"");
  });
});
