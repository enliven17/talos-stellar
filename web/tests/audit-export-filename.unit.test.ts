import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sanitizeAuditExportIdentifier,
  buildAuditExportFilename,
  MAX_AUDIT_FILENAME_SEGMENT_LENGTH,
  MAX_AUDIT_EXPORT_FILENAME_LENGTH,
} from "../src/lib/audit-chain";
import { exportAuditLogs, serializeAuditLogExport } from "../src/lib/audit-log/store";

// Regression coverage for #1543 (bounded safe audit export filenames).

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mockDb }));

describe("sanitizeAuditExportIdentifier / buildAuditExportFilename", () => {
  it("accepts and normalizes bounded valid ASCII identifiers", () => {
    expect(sanitizeAuditExportIdentifier("tal_Agent-01")).toBe("tal_agent-01");
    expect(sanitizeAuditExportIdentifier("cly123abc456def789")).toBe("cly123abc456def789");
    expect(
      sanitizeAuditExportIdentifier("a".repeat(MAX_AUDIT_FILENAME_SEGMENT_LENGTH)),
    ).toBe("a".repeat(MAX_AUDIT_FILENAME_SEGMENT_LENGTH));
  });

  it("rejects untrusted actor text, Unicode, path traversal, quotes, and oversized identifiers", () => {
    expect(sanitizeAuditExportIdentifier("")).toBeNull();
    expect(sanitizeAuditExportIdentifier("   ")).toBeNull();
    expect(sanitizeAuditExportIdentifier("../etc/passwd")).toBeNull();
    expect(sanitizeAuditExportIdentifier("agent/../../secret")).toBeNull();
    expect(sanitizeAuditExportIdentifier('actor"; filename="evil.sh')).toBeNull();
    expect(sanitizeAuditExportIdentifier("agent\r\nX-Injected: 1")).toBeNull();
    expect(sanitizeAuditExportIdentifier("talos-אгент-🚀")).toBeNull();
    expect(sanitizeAuditExportIdentifier("日本-agent")).toBeNull();
    expect(sanitizeAuditExportIdentifier("-leading-hyphen")).toBeNull();
    expect(
      sanitizeAuditExportIdentifier("a".repeat(MAX_AUDIT_FILENAME_SEGMENT_LENGTH + 1)),
    ).toBeNull();
  });

  it("generates bounded safe filenames from validated identifiers and timestamps", () => {
    const filename = buildAuditExportFilename({
      talosId: "tal_Agent_42",
      format: "csv",
      exportedAt: "2026-09-30T12:34:56.789Z",
    });

    expect(filename).toBe("audit-logs-tal_agent_42-20260930T123456Z.csv");
    expect(filename.length).toBeLessThanOrEqual(MAX_AUDIT_EXPORT_FILENAME_LENGTH);
    expect(filename).toMatch(/^[a-z0-9][A-Za-z0-9_-]*\.(json|csv)$/);
  });

  it("defaults to 'all' when no identifier is provided", () => {
    expect(buildAuditExportFilename({ format: "json" })).toBe("audit-logs-all.json");
  });

  it("falls back to 'filtered' instead of leaking untrusted actor text or Unicode into the filename", () => {
    const unicodeAttempt = buildAuditExportFilename({
      talosId: "actor-🚀-Ümlaut/../../pwn",
      format: "json",
      exportedAt: new Date("2026-09-30T00:00:00.000Z"),
    });

    expect(unicodeAttempt).toBe("audit-logs-filtered-20260930T000000Z.json");
    expect(unicodeAttempt).not.toContain("🚀");
    expect(unicodeAttempt).not.toContain("Ü");
    expect(unicodeAttempt).not.toContain("..");

    const oversizedAttempt = buildAuditExportFilename({
      talosId: "x".repeat(MAX_AUDIT_FILENAME_SEGMENT_LENGTH + 5),
      format: "csv",
    });
    expect(oversizedAttempt).toBe("audit-logs-filtered.csv");
  });

  it("throws on invalid identifiers or timestamps when strict mode is enabled", () => {
    expect(() =>
      buildAuditExportFilename({
        talosId: "untrusted actor text / 🚀",
        strict: true,
      }),
    ).toThrow(/Invalid audit export identifier/);

    expect(() =>
      buildAuditExportFilename({
        talosId: "tal_1",
        exportedAt: "not-a-valid-date",
        strict: true,
      }),
    ).toThrow(/Invalid audit export timestamp/);
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
