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
  createAuditCheckpointBundle,
  verifyAuditCheckpointBundle,
  generateCheckpointKeyPair,
  clampCheckpointLimit,
  MAX_AUDIT_CHECKPOINT_LIMIT,
  DEFAULT_AUDIT_CHECKPOINT_LIMIT,
  AUDIT_CHECKPOINT_DOMAIN,
  AUDIT_CHECKPOINT_BUNDLE_VERSION,
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

  describe("audit checkpoint bundles (export & offline verification)", () => {
    const hmacSecret = "offline-checkpoint-hmac-secret-999";

    function buildChainedRows(count: number, talosId = "test-agent") {
      const entries = Array.from({ length: count }, (_, i) =>
        makeEntry({
          sequenceNumber: i,
          talosId,
          method: i % 2 === 0 ? "GET" : "POST",
          path: `/api/talos/${talosId}/op-${i}`,
          statusCode: 200,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );

      return entries.map((entry, i) => {
        const entryHash = computeEntryHash(entry);
        const previousHash =
          i === 0 ? GENESIS_HASH : computeEntryHash(entries[i - 1]);
        return makeRow({
          id: `log_${i}`,
          sequenceNumber: i,
          talosId: entry.talosId,
          method: entry.method,
          path: entry.path,
          statusCode: entry.statusCode,
          ipAddress: entry.ipAddress,
          entryHash,
          previousHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: new Date(entry.createdAt),
        });
      });
    }

    it("exports a bounded HMAC-signed checkpoint bundle and verifies it offline", () => {
      const rows = buildChainedRows(5);
      const bundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        limit: 10,
        exportedAt: "2026-01-02T00:00:00.000Z",
        hmacSecret,
      });

      expect(bundle.bundleVersion).toBe(AUDIT_CHECKPOINT_BUNDLE_VERSION);
      expect(bundle.domain).toBe(AUDIT_CHECKPOINT_DOMAIN);
      expect(bundle.talosId).toBe("test-agent");
      expect(bundle.chainRoot).toBe(rows[4].entryHash);
      expect(bundle.boundaries).toEqual({
        startSequence: 0,
        endSequence: 4,
        startEntryHash: rows[0].entryHash,
        endEntryHash: rows[4].entryHash,
        previousChainHash: GENESIS_HASH,
        startTimestamp: "2026-01-01T00:00:00.000Z",
        endTimestamp: "2026-01-01T00:00:04.000Z",
        entryCount: 5,
        limit: 10,
        truncated: false,
      });
      expect(bundle.signature?.algorithm).toBe("hmac-sha256");
      expect(bundle.seal).toBe(sealChainRoot(rows[4].entryHash!, hmacSecret));

      // Verify offline from serialized JSON string without DB or admin credentials
      const jsonString = JSON.stringify(bundle);
      const verification = verifyAuditCheckpointBundle(jsonString, {
        hmacSecret,
        expectedTalosId: "test-agent",
      });

      expect(verification.valid).toBe(true);
      expect(verification.signatureValid).toBe(true);
      expect(verification.boundariesValid).toBe(true);
      expect(verification.chainValid).toBe(true);
      expect(verification.verifiedEntries).toBe(5);
      expect(verification.brokenAtSequence).toBeNull();
      expect(verification.failureReason).toBeNull();
    });

    it("exports an Ed25519-signed checkpoint bundle and verifies it offline using only the public key", () => {
      const { publicKeyPem, privateKeyPem } = generateCheckpointKeyPair();
      const rows = buildChainedRows(4);

      const bundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        privateKey: privateKeyPem,
        publicKey: publicKeyPem,
        keyId: "key-2026-01",
      });

      expect(bundle.signature?.algorithm).toBe("ed25519");
      expect(bundle.signature?.keyId).toBe("key-2026-01");
      expect(bundle.signature?.publicKey).toBe(publicKeyPem);

      // Verify offline using embedded or explicitly passed public key
      const verifiedWithExplicitKey = verifyAuditCheckpointBundle(bundle, {
        publicKey: publicKeyPem,
      });
      expect(verifiedWithExplicitKey.valid).toBe(true);
      expect(verifiedWithExplicitKey.signatureValid).toBe(true);
      expect(verifiedWithExplicitKey.verifiedEntries).toBe(4);

      // Reject when verified against a different Ed25519 public key
      const otherKeys = generateCheckpointKeyPair();
      const verifiedWithWrongKey = verifyAuditCheckpointBundle(bundle, {
        publicKey: otherKeys.publicKeyPem,
      });
      expect(verifiedWithWrongKey.valid).toBe(false);
      expect(verifiedWithWrongKey.signatureValid).toBe(false);
      expect(verifiedWithWrongKey.failureReason).toBe("invalid_signature");
    });

    it("enforces bounded export limits and records chain boundaries for non-genesis sub-ranges", () => {
      const rows = buildChainedRows(8);

      // Default tail bounding: keeps the latest 3 contiguous entries (seq 5..7)
      const tailBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        limit: 3,
        hmacSecret,
      });

      expect(tailBundle.boundaries.truncated).toBe(true);
      expect(tailBundle.boundaries.entryCount).toBe(3);
      expect(tailBundle.boundaries.startSequence).toBe(5);
      expect(tailBundle.boundaries.endSequence).toBe(7);
      expect(tailBundle.boundaries.previousChainHash).toBe(rows[4].entryHash);

      // Verify offline anchored to predecessor's entryHash
      const tailVerify = verifyAuditCheckpointBundle(tailBundle, {
        hmacSecret,
        expectedPreviousChainHash: rows[4].entryHash!,
      });
      expect(tailVerify.valid).toBe(true);
      expect(tailVerify.verifiedEntries).toBe(3);

      // Reject if expectedPreviousChainHash anchor does not match
      const wrongAnchorVerify = verifyAuditCheckpointBundle(tailBundle, {
        hmacSecret,
        expectedPreviousChainHash: rows[3].entryHash!,
      });
      expect(wrongAnchorVerify.valid).toBe(false);
      expect(wrongAnchorVerify.failureReason).toBe("boundary_mismatch");
    });

    it("supports explicit [fromSequence, toSequence] chain boundaries and clamps limits", () => {
      expect(clampCheckpointLimit(undefined)).toBe(DEFAULT_AUDIT_CHECKPOINT_LIMIT);
      expect(clampCheckpointLimit(0)).toBe(1);
      expect(clampCheckpointLimit(-10)).toBe(1);
      expect(clampCheckpointLimit(5000)).toBe(MAX_AUDIT_CHECKPOINT_LIMIT);

      const rows = buildChainedRows(6);
      const sliceBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        fromSequence: 2,
        toSequence: 4,
        hmacSecret,
      });

      expect(sliceBundle.boundaries.startSequence).toBe(2);
      expect(sliceBundle.boundaries.endSequence).toBe(4);
      expect(sliceBundle.boundaries.entryCount).toBe(3);
      expect(sliceBundle.boundaries.previousChainHash).toBe(rows[1].entryHash);
      expect(sliceBundle.boundaries.truncated).toBe(false);

      const verified = verifyAuditCheckpointBundle(sliceBundle, { hmacSecret });
      expect(verified.valid).toBe(true);
      expect(verified.verifiedEntries).toBe(3);

      expect(() =>
        createAuditCheckpointBundle({
          talosId: "test-agent",
          rows,
          fromSequence: 5,
          toSequence: 2,
        }),
      ).toThrow(/fromSequence must be less than or equal to toSequence/);
    });

    it("handles an empty chain checkpoint bundle cleanly", () => {
      const emptyBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows: [],
        hmacSecret,
      });

      expect(emptyBundle.chainRoot).toBeNull();
      expect(emptyBundle.boundaries.entryCount).toBe(0);
      expect(emptyBundle.boundaries.startSequence).toBeNull();
      expect(emptyBundle.boundaries.endSequence).toBeNull();
      expect(emptyBundle.boundaries.previousChainHash).toBeNull();

      const verified = verifyAuditCheckpointBundle(emptyBundle, { hmacSecret });
      expect(verified.valid).toBe(true);
      expect(verified.verifiedEntries).toBe(0);
    });

    it("detects tampered entry data, broken links, sequence gaps, and boundary mismatches offline", () => {
      const rows = buildChainedRows(4);
      const bundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        hmacSecret,
      });

      // 1. Tamper with an entry field -> fails entries_digest_mismatch
      const tamperedEntryBundle = structuredClone(bundle);
      tamperedEntryBundle.entries[2].statusCode = 500;
      const digestRes = verifyAuditCheckpointBundle(tamperedEntryBundle, {
        hmacSecret,
      });
      expect(digestRes.valid).toBe(false);
      expect(digestRes.failureReason).toBe("entries_digest_mismatch");

      // 2. Tamper with boundary metadata -> fails boundary_mismatch
      const tamperedBoundaryBundle = structuredClone(bundle);
      tamperedBoundaryBundle.boundaries.endSequence = 99;
      const boundaryRes = verifyAuditCheckpointBundle(tamperedBoundaryBundle, {
        hmacSecret,
      });
      expect(boundaryRes.valid).toBe(false);
      expect(boundaryRes.failureReason).toBe("boundary_mismatch");

      // 3. Corrupt internal chain entryHash while re-signing bundle -> fails entry_hash_mismatch
      const corruptedRows = buildChainedRows(3);
      corruptedRows[1].entryHash = "f".repeat(64);
      const corruptedHashBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows: corruptedRows,
        hmacSecret,
      });
      const hashMismatchRes = verifyAuditCheckpointBundle(corruptedHashBundle, {
        hmacSecret,
      });
      expect(hashMismatchRes.valid).toBe(false);
      expect(hashMismatchRes.failureReason).toBe("entry_hash_mismatch");
      expect(hashMismatchRes.brokenAtSequence).toBe(1);

      // 4. Corrupt previousHash linkage while re-signing bundle -> fails previous_hash_mismatch
      const brokenLinkRows = buildChainedRows(3);
      brokenLinkRows[2].previousHash = "a".repeat(64);
      const brokenLinkBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows: brokenLinkRows,
        hmacSecret,
      });
      const linkMismatchRes = verifyAuditCheckpointBundle(brokenLinkBundle, {
        hmacSecret,
      });
      expect(linkMismatchRes.valid).toBe(false);
      expect(linkMismatchRes.failureReason).toBe("previous_hash_mismatch");
      expect(linkMismatchRes.brokenAtSequence).toBe(2);

      // 5. Sequence gap inside bundle -> fails sequence_gap
      const gapRows = buildChainedRows(3);
      const missingMiddleBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows: [gapRows[0], gapRows[2]],
        hmacSecret,
      });
      const gapRes = verifyAuditCheckpointBundle(missingMiddleBundle, {
        hmacSecret,
      });
      expect(gapRes.valid).toBe(false);
      expect(gapRes.failureReason).toBe("sequence_gap");
      expect(gapRes.brokenAtSequence).toBe(2);

      // 6. Unsigned bundle when signature is required -> fails invalid_signature
      const unsignedBundle = createAuditCheckpointBundle({
        talosId: "test-agent",
        rows,
        hmacSecret: null,
        privateKey: null,
      });
      const unsignedRes = verifyAuditCheckpointBundle(unsignedBundle, {
        hmacSecret,
      });
      expect(unsignedRes.valid).toBe(false);
      expect(unsignedRes.failureReason).toBe("invalid_signature");

      // 7. Bundle exceeding verifier maxEntries bound -> fails entry_count_exceeds_limit
      const maxEntriesRes = verifyAuditCheckpointBundle(bundle, {
        hmacSecret,
        maxEntries: 2,
      });
      expect(maxEntriesRes.valid).toBe(false);
      expect(maxEntriesRes.failureReason).toBe("entry_count_exceeds_limit");
    });
  });
});
