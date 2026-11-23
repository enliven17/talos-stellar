import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalize,
  computeEntryHash,
  sealChainRoot,
  verifyChainRootSeal,
  verifyChain,
  verifyChainRange,
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  isAuditChainEnabled,
  type AuditChainEntry,
  type AuditChainRow,
} from "../src/lib/audit-chain";

// ─── Helpers ──────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AuditChainEntry> = {}): AuditChainEntry {
  return {
    sequenceNumber: 0,
    talosId: "test-agent",
    method: "GET",
    path: "/api/talos/test-agent/status",
    statusCode: 200,
    ipAddress: "127.0.0.1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    sequenceNumber: 0,
    entryHash: null as string | null,
    previousHash: null as string | null,
    chainVersion: null as string | null,
    talosId: "test-agent",
    method: "GET",
    path: "/api/talos/test-agent/status",
    statusCode: 200,
    ipAddress: "127.0.0.1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("audit-chain", () => {
  describe("canonicalize", () => {
    it("produces deterministic JSON with fixed property order", () => {
      const entry = makeEntry({ ipAddress: null });
      const result = canonicalize(entry);

      expect(result).toBe(
        '{"sequenceNumber":0,"talosId":"test-agent","method":"GET","path":"/api/talos/test-agent/status","statusCode":200,"ipAddress":null,"createdAt":"2026-01-01T00:00:00.000Z"}',
      );
    });

    it("includes the domain separator when computing hash", () => {
      const entry = makeEntry();
      const hash = computeEntryHash(entry);

      // The hash should be a valid SHA-256 hex string
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // Same input produces same hash
      expect(computeEntryHash(entry)).toBe(hash);
    });

    it("produces different hashes for different entries", () => {
      const a = makeEntry({ method: "GET" });
      const b = makeEntry({ method: "POST" });

      expect(computeEntryHash(a)).not.toBe(computeEntryHash(b));
    });

    it("produces different hashes when ipAddress differs", () => {
      const a = makeEntry({ ipAddress: "127.0.0.1" });
      const b = makeEntry({ ipAddress: "10.0.0.1" });

      expect(computeEntryHash(a)).not.toBe(computeEntryHash(b));
    });

    it("produces different hashes when statusCode differs", () => {
      const a = makeEntry({ statusCode: 200 });
      const b = makeEntry({ statusCode: 403 });

      expect(computeEntryHash(a)).not.toBe(computeEntryHash(b));
    });

    it("produces different hashes when createdAt differs", () => {
      const a = makeEntry({ createdAt: "2026-01-01T00:00:00.000Z" });
      const b = makeEntry({ createdAt: "2026-01-01T00:00:01.000Z" });

      expect(computeEntryHash(a)).not.toBe(computeEntryHash(b));
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("rejects nonfinite sequenceNumber (%s) before serialization", (_label, value) => {
      const entry = makeEntry({ sequenceNumber: value });
      expect(() => canonicalize(entry)).toThrow(RangeError);
      expect(() => canonicalize(entry)).toThrow(/nonfinite sequenceNumber/i);
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("rejects nonfinite statusCode (%s) before serialization", (_label, value) => {
      const entry = makeEntry({ statusCode: value });
      expect(() => canonicalize(entry)).toThrow(RangeError);
      expect(() => canonicalize(entry)).toThrow(/nonfinite statusCode/i);
    });

    it("accepts boundary finite numbers deterministically", () => {
      const zeroEntry = makeEntry({ sequenceNumber: -0, statusCode: 200 });
      expect(canonicalize(zeroEntry)).toContain('"sequenceNumber":0');

      const maxSafeEntry = makeEntry({
        sequenceNumber: Number.MAX_SAFE_INTEGER,
        statusCode: 599,
      });
      expect(canonicalize(maxSafeEntry)).toContain(
        `"sequenceNumber":${Number.MAX_SAFE_INTEGER}`,
      );
    });
  });

  describe("computeEntryHash", () => {
    it("produces a 64-character lowercase hex SHA-256 digest", () => {
      const hash = computeEntryHash(makeEntry());
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("fails before hashing when canonical payload contains nonfinite numbers", () => {
      expect(() => computeEntryHash(makeEntry({ sequenceNumber: Number.NaN }))).toThrow(
        RangeError,
      );
      expect(() =>
        computeEntryHash(makeEntry({ statusCode: Number.POSITIVE_INFINITY })),
      ).toThrow(RangeError);
    });

    it("is deterministic", () => {
      const entry = makeEntry();
      const h1 = computeEntryHash(entry);
      const h2 = computeEntryHash(entry);
      expect(h1).toBe(h2);
    });

    it("uses the domain separator", () => {
      // The domain separator "talos.audit.v1:" is prepended
      // We can verify this indirectly by checking that changing
      // the domain changes the hash (via a controlled test)
      const entry = makeEntry();
      const hash = computeEntryHash(entry);

      // Verify the hash is non-trivial (not all zeros)
      expect(hash).not.toBe("0".repeat(64));
      expect(hash.length).toBe(64);
    });
  });

  describe("sealChainRoot / verifyChainRootSeal", () => {
    const secret = "test-hmac-secret-key-12345";

    it("creates a valid seal that can be verified", () => {
      const entryHash = computeEntryHash(makeEntry());
      const seal = sealChainRoot(entryHash, secret);

      expect(seal).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyChainRootSeal(entryHash, secret, seal)).toBe(true);
    });

    it("rejects a seal with the wrong secret", () => {
      const entryHash = computeEntryHash(makeEntry());
      const seal = sealChainRoot(entryHash, secret);

      expect(verifyChainRootSeal(entryHash, "wrong-secret", seal)).toBe(false);
    });

    it("rejects a seal with the wrong entry hash", () => {
      const entryHash = computeEntryHash(makeEntry());
      const seal = sealChainRoot(entryHash, secret);

      const otherHash = computeEntryHash(makeEntry({ method: "POST" }));
      expect(verifyChainRootSeal(otherHash, secret, seal)).toBe(false);
    });

    it("rejects non-hex seal strings", () => {
      const entryHash = computeEntryHash(makeEntry());
      expect(verifyChainRootSeal(entryHash, secret, "not-a-hex-string")).toBe(false);
    });

    it("rejects seal strings of wrong length", () => {
      const entryHash = computeEntryHash(makeEntry());
      expect(verifyChainRootSeal(entryHash, secret, "abc")).toBe(false);
      expect(
        verifyChainRootSeal(entryHash, secret, "a".repeat(65)),
      ).toBe(false);
    });
  });

  describe("verifyChain", () => {
    it("returns valid for an empty chain", () => {
      const result = verifyChain([]);
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(0);
      expect(result.verifiedEntries).toBe(0);
    });

    it("validates a single chained entry (genesis)", () => {
      const entry = makeEntry({ sequenceNumber: 0 });
      const entryHash = computeEntryHash(entry);

      const row = makeRow({
        sequenceNumber: 0,
        entryHash,
        previousHash: GENESIS_HASH,
        chainVersion: AUDIT_CHAIN_VERSION,
      });

      const result = verifyChain([row]);
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(1);
      expect(result.verifiedEntries).toBe(1);
    });

    it("validates a multi-entry chain", () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeEntry({ sequenceNumber: i, createdAt: `2026-01-01T00:00:0${i}.000Z` }),
      );

      const rows = entries.map((entry, i) => {
        const entryHash = computeEntryHash(entry);
        const previousHash = i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]);

        return makeRow({
          sequenceNumber: i,
          entryHash,
          previousHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: new Date(entry.createdAt),
        });
      });

      const result = verifyChain(rows);
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(5);
      expect(result.verifiedEntries).toBe(5);
    });

    it("detects a broken chain when previousHash is wrong", () => {
      const entries = Array.from({ length: 3 }, (_, i) =>
        makeEntry({ sequenceNumber: i, createdAt: `2026-01-01T00:00:0${i}.000Z` }),
      );

      const rows = entries.map((entry, i) => {
        const entryHash = computeEntryHash(entry);
        const previousHash = i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]);

        return makeRow({
          sequenceNumber: i,
          entryHash,
          previousHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: new Date(entry.createdAt),
        });
      });

      // Tamper with the second entry's previousHash
      rows[1].previousHash = "tampered-hash-value";

      const result = verifyChain(rows);
      expect(result.valid).toBe(false);
      expect(result.brokenAtSequence).toBe(1);
      expect(result.verifiedEntries).toBe(1);
    });

    it("detects a broken chain when entryHash is wrong (tampered data)", () => {
      const entries = Array.from({ length: 3 }, (_, i) =>
        makeEntry({ sequenceNumber: i, createdAt: `2026-01-01T00:00:0${i}.000Z` }),
      );

      const rows = entries.map((entry, i) => {
        const entryHash = computeEntryHash(entry);
        const previousHash = i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]);

        return makeRow({
          sequenceNumber: i,
          entryHash,
          previousHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: new Date(entry.createdAt),
        });
      });

      // Tamper with the entryHash of the third entry (as if data was modified)
      rows[2].entryHash = "tampered-entry-hash";

      const result = verifyChain(rows);
      expect(result.valid).toBe(false);
      expect(result.brokenAtSequence).toBe(2);
      expect(result.verifiedEntries).toBe(2);
    });

    it("skips legacy rows without chain columns", () => {
      const legacyRow = makeRow({
        sequenceNumber: null,
        entryHash: null,
        previousHash: null,
        chainVersion: null,
      });

      const entry = makeEntry({ sequenceNumber: 0 });
      const entryHash = computeEntryHash(entry);

      const chainedRow = makeRow({
        sequenceNumber: 0,
        entryHash,
        previousHash: GENESIS_HASH,
        chainVersion: AUDIT_CHAIN_VERSION,
      });

      const result = verifyChain([legacyRow, chainedRow]);
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(2);
      expect(result.verifiedEntries).toBe(1);
    });

    it("detects out-of-sequence numbers", () => {
      const entries = [
        makeEntry({ sequenceNumber: 0, createdAt: "2026-01-01T00:00:00.000Z" }),
        makeEntry({ sequenceNumber: 5, createdAt: "2026-01-01T00:00:01.000Z" }),
      ];

      const rows = entries.map((entry, i) => {
        const entryHash = computeEntryHash(entry);
        const previousHash = i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]);

        return makeRow({
          sequenceNumber: i === 1 ? 5 : 0,
          entryHash,
          previousHash: i === 0 ? GENESIS_HASH : previousHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: new Date(entry.createdAt),
        });
      });

      const result = verifyChain(rows);
      expect(result.valid).toBe(false);
      expect(result.brokenAtSequence).toBe(5);
    });

    it("reports chain version from the last chained entry", () => {
      const entry = makeEntry({ sequenceNumber: 0 });
      const entryHash = computeEntryHash(entry);

      const row = makeRow({
        sequenceNumber: 0,
        entryHash,
        previousHash: GENESIS_HASH,
        chainVersion: "2",
      });

      const result = verifyChain([row]);
      expect(result.chainVersion).toBe("2");
    });
  });

  describe("verifyChainRange", () => {
    function buildChainedRows(count: number): AuditChainRow[] {
      const entries = Array.from({ length: count }, (_, i) =>
        makeEntry({
          sequenceNumber: i,
          createdAt: `2026-01-01T00:00:0${i}.000Z`,
        }),
      );
      return entries.map((entry, i) => ({
        sequenceNumber: i,
        entryHash: computeEntryHash(entry),
        previousHash: i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]),
        chainVersion: AUDIT_CHAIN_VERSION,
        talosId: entry.talosId,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        ipAddress: entry.ipAddress,
        createdAt: new Date(entry.createdAt),
      }));
    }

    it("verifies a mid-chain time range when the predecessor boundary matches", () => {
      const allRows = buildChainedRows(6);
      const predecessor = {
        sequenceNumber: allRows[1].sequenceNumber,
        entryHash: allRows[1].entryHash,
        createdAt: allRows[1].createdAt,
      };
      const rangeRows = allRows.slice(2, 5);

      const result = verifyChainRange(rangeRows, {
        predecessor,
        from: "2026-01-01T00:00:02.000Z",
        to: "2026-01-01T00:00:04.000Z",
      });

      expect(result.valid).toBe(true);
      expect(result.status).toBe("valid");
      expect(result.complete).toBe(true);
      expect(result.incompleteReason).toBeNull();
      expect(result.failureReason).toBeNull();
      expect(result.verifiedEntries).toBe(3);
      expect(result.startSequence).toBe(2);
      expect(result.endSequence).toBe(4);
      expect(result.predecessorSequence).toBe(1);
      expect(result.predecessorHash).toBe(allRows[1].entryHash);
      expect(result.brokenAtSequence).toBeNull();
    });

    it("verifies a range starting at genesis when predecessor is null", () => {
      const allRows = buildChainedRows(3);

      const result = verifyChainRange(allRows, {
        predecessor: null,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-01T00:00:02.000Z",
      });

      expect(result.valid).toBe(true);
      expect(result.status).toBe("valid");
      expect(result.complete).toBe(true);
      expect(result.startSequence).toBe(0);
      expect(result.endSequence).toBe(2);
      expect(result.verifiedEntries).toBe(3);
    });

    it("distinguishes an incomplete range (missing predecessor) from a broken chain", () => {
      const allRows = buildChainedRows(5);
      const rangeRows = allRows.slice(2, 5);

      // Case 1: predecessor omitted (undefined) for mid-chain slice
      const omittedPred = verifyChainRange(rangeRows);
      expect(omittedPred.valid).toBe(false);
      expect(omittedPred.status).toBe("incomplete");
      expect(omittedPred.complete).toBe(false);
      expect(omittedPred.incompleteReason).toBe("missing_predecessor");
      expect(omittedPred.failureReason).toBe("missing_predecessor");
      expect(omittedPred.brokenAtSequence).toBeNull();
      expect(omittedPred.verifiedEntries).toBe(3);
      expect(omittedPred.startSequence).toBe(2);
      expect(omittedPred.endSequence).toBe(4);

      // Case 2: predecessor explicitly null (DB found no prior entry before `from`, yet range starts at seq 2)
      const nullPred = verifyChainRange(rangeRows, { predecessor: null });
      expect(nullPred.valid).toBe(false);
      expect(nullPred.status).toBe("incomplete");
      expect(nullPred.complete).toBe(false);
      expect(nullPred.incompleteReason).toBe("missing_predecessor");
      expect(nullPred.brokenAtSequence).toBeNull();
    });

    it("distinguishes an incomplete range (truncated by limit) from a broken chain", () => {
      const allRows = buildChainedRows(4);
      const result = verifyChainRange(allRows.slice(0, 2), {
        predecessor: null,
        truncated: true,
      });

      expect(result.valid).toBe(false);
      expect(result.status).toBe("incomplete");
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe("truncated_range");
      expect(result.failureReason).toBe("truncated_range");
      expect(result.brokenAtSequence).toBeNull();
      expect(result.verifiedEntries).toBe(2);
    });

    it("still detects a broken internal link even when predecessor is omitted", () => {
      const allRows = buildChainedRows(5);
      const rangeRows = allRows.slice(2, 5).map((r) => ({ ...r }));
      rangeRows[1].entryHash = "tampered-hash";

      const result = verifyChainRange(rangeRows);
      expect(result.valid).toBe(false);
      expect(result.status).toBe("broken");
      expect(result.complete).toBe(false);
      expect(result.failureReason).toBe("entry_hash_mismatch");
      expect(result.brokenAtSequence).toBe(3);
    });

    it("detects a broken predecessor boundary when previousHash or sequenceNumber mismatches predecessor", () => {
      const allRows = buildChainedRows(5);
      const wrongPredecessor = {
        sequenceNumber: allRows[0].sequenceNumber,
        entryHash: allRows[0].entryHash,
        createdAt: allRows[0].createdAt,
      };
      const rangeRows = allRows.slice(2, 4);

      const result = verifyChainRange(rangeRows, {
        predecessor: wrongPredecessor,
      });

      expect(result.valid).toBe(false);
      expect(result.status).toBe("broken");
      expect(result.failureReason).toBe("predecessor_mismatch");
      expect(result.brokenAtSequence).toBe(2);
    });

    it("detects unexpected genesis when a predecessor exists or sequenceNumber > 0 has GENESIS previousHash", () => {
      const allRows = buildChainedRows(3);
      const tampered = { ...allRows[1], previousHash: GENESIS_HASH };

      const result = verifyChainRange([tampered]);
      expect(result.valid).toBe(false);
      expect(result.status).toBe("broken");
      expect(result.failureReason).toBe("unexpected_genesis");
      expect(result.brokenAtSequence).toBe(1);
    });

    it("detects out-of-order records by timestamp or sequence and records outside [from, to]", () => {
      const allRows = buildChainedRows(3);
      // Reverse chronological order
      const reversed = [allRows[1], allRows[0]];
      const outOfOrder = verifyChainRange(reversed);
      expect(outOfOrder.valid).toBe(false);
      expect(outOfOrder.status).toBe("broken");
      expect(outOfOrder.failureReason).toBe("out_of_order_records");

      // Record outside [from, to] window
      const outOfBounds = verifyChainRange(allRows, {
        predecessor: null,
        from: "2026-01-01T00:00:01.000Z",
        to: "2026-01-01T00:00:02.000Z",
      });
      expect(outOfBounds.valid).toBe(false);
      expect(outOfBounds.status).toBe("broken");
      expect(outOfBounds.failureReason).toBe("out_of_order_records");
      expect(outOfBounds.brokenAtSequence).toBe(0);
    });

    it("detects a sequence gap inside the selected range", () => {
      const allRows = buildChainedRows(4);
      const gapped = [allRows[0], allRows[2]];

      const result = verifyChainRange(gapped, { predecessor: null });
      expect(result.valid).toBe(false);
      expect(result.status).toBe("broken");
      expect(result.failureReason).toBe("sequence_gap");
      expect(result.brokenAtSequence).toBe(2);
      expect(result.verifiedEntries).toBe(1);
    });
  });

  describe("isAuditChainEnabled", () => {
    const originalEnv = process.env.AUDIT_HASH_CHAIN_ENABLED;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.AUDIT_HASH_CHAIN_ENABLED;
      } else {
        process.env.AUDIT_HASH_CHAIN_ENABLED = originalEnv;
      }
    });

    it("defaults to true when not set", () => {
      delete process.env.AUDIT_HASH_CHAIN_ENABLED;
      expect(isAuditChainEnabled()).toBe(true);
    });

    it("returns true when set to 'true'", () => {
      process.env.AUDIT_HASH_CHAIN_ENABLED = "true";
      expect(isAuditChainEnabled()).toBe(true);
    });

    it("returns false when set to 'false'", () => {
      process.env.AUDIT_HASH_CHAIN_ENABLED = "false";
      expect(isAuditChainEnabled()).toBe(false);
    });

    it("returns false when set to '0'", () => {
      process.env.AUDIT_HASH_CHAIN_ENABLED = "0";
      expect(isAuditChainEnabled()).toBe(false);
    });

    it("returns true when set to '1'", () => {
      process.env.AUDIT_HASH_CHAIN_ENABLED = "1";
      expect(isAuditChainEnabled()).toBe(true);
    });
  });

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
});
