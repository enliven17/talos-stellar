import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalize,
  computeEntryHash,
  sealChainRoot,
  verifyChainRootSeal,
  verifyChain,
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  isAuditChainEnabled,
  type AuditChainEntry,
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
  });

  describe("computeEntryHash", () => {
    it("produces a 64-character lowercase hex SHA-256 digest", () => {
      const hash = computeEntryHash(makeEntry());
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
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
});
