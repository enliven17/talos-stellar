import { describe, it, expect } from "vitest";
import {
  buildAuditIntegrityReport,
  AUDIT_CHECKPOINT_STALE_MS,
  AUDIT_INTEGRITY_SAMPLE_SIZE,
} from "@/lib/audit-log/integrity";
import type { ChainVerificationResult } from "@/lib/audit-chain";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date("2025-06-01T12:00:00.000Z");
const FRESH_CHECKPOINT = new Date(NOW.getTime() - 10 * 60 * 1_000).toISOString(); // 10 min ago
const STALE_CHECKPOINT = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000).toISOString(); // 2 hours ago

function validChain(entries = 5): ChainVerificationResult {
  return {
    valid: true,
    totalEntries: entries,
    verifiedEntries: entries,
    brokenAtSequence: null,
    chainVersion: "1",
  };
}

function brokenChain(breakAt = 3): ChainVerificationResult {
  return {
    valid: false,
    totalEntries: 5,
    verifiedEntries: breakAt,
    brokenAtSequence: breakAt,
    chainVersion: "1",
  };
}

// ─── Status matrix ────────────────────────────────────────────────────────────

describe("buildAuditIntegrityReport — status matrix", () => {
  it('returns status="ok" when chain is valid and checkpoint is fresh', () => {
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: FRESH_CHECKPOINT,
      now: NOW,
    });
    expect(report.status).toBe("ok");
    expect(report.chainValid).toBe(true);
    expect(report.checkpointFresh).toBe(true);
  });

  it('returns status="chain_broken" when chain breaks but checkpoint is fresh', () => {
    const report = buildAuditIntegrityReport({
      chainResult: brokenChain(3),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: FRESH_CHECKPOINT,
      now: NOW,
    });
    expect(report.status).toBe("chain_broken");
    expect(report.chainValid).toBe(false);
    expect(report.checkpointFresh).toBe(true);
    expect(report.brokenAtSequence).toBe(3);
  });

  it('returns status="checkpoint_stale" when chain is valid but checkpoint is old', () => {
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: STALE_CHECKPOINT,
      now: NOW,
    });
    expect(report.status).toBe("checkpoint_stale");
    expect(report.chainValid).toBe(true);
    expect(report.checkpointFresh).toBe(false);
    expect(report.checkpointStale).toBe(true);
  });

  it('returns status="degraded" when both chain breaks and checkpoint is stale', () => {
    const report = buildAuditIntegrityReport({
      chainResult: brokenChain(2),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: STALE_CHECKPOINT,
      now: NOW,
    });
    expect(report.status).toBe("degraded");
    expect(report.chainValid).toBe(false);
    expect(report.checkpointFresh).toBe(false);
  });

  it('returns status="checkpoint_stale" when no checkpoint exists', () => {
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: null,
      now: NOW,
    });
    expect(report.status).toBe("checkpoint_stale");
    expect(report.checkpointAgeMs).toBeNull();
    expect(report.checkpointStale).toBe(true);
    expect(report.lastCheckpointAt).toBeNull();
  });

  it('returns status="degraded" when no checkpoint and chain is broken', () => {
    const report = buildAuditIntegrityReport({
      chainResult: brokenChain(1),
      sampledEntries: 5,
      lastVerifiedAt: null,
      lastCheckpointAt: null,
      now: NOW,
    });
    expect(report.status).toBe("degraded");
  });
});

// ─── Checkpoint age calculation ───────────────────────────────────────────────

describe("buildAuditIntegrityReport — checkpoint age", () => {
  it("computes checkpointAgeMs correctly", () => {
    const ageMs = 30 * 60 * 1_000; // 30 minutes
    const checkpointAt = new Date(NOW.getTime() - ageMs).toISOString();
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: checkpointAt,
      now: NOW,
    });
    expect(report.checkpointAgeMs).toBe(ageMs);
  });

  it("treats checkpoint exactly at the stale threshold as fresh", () => {
    const checkpointAt = new Date(NOW.getTime() - AUDIT_CHECKPOINT_STALE_MS).toISOString();
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: checkpointAt,
      now: NOW,
    });
    // exactly at the threshold: age === STALE_MS, which is NOT > STALE_MS
    expect(report.checkpointStale).toBe(false);
  });

  it("treats checkpoint one millisecond past the stale threshold as stale", () => {
    const checkpointAt = new Date(NOW.getTime() - AUDIT_CHECKPOINT_STALE_MS - 1).toISOString();
    const report = buildAuditIntegrityReport({
      chainResult: validChain(),
      sampledEntries: 5,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: checkpointAt,
      now: NOW,
    });
    expect(report.checkpointStale).toBe(true);
  });
});

// ─── Report shape ─────────────────────────────────────────────────────────────

describe("buildAuditIntegrityReport — report shape", () => {
  it("includes all required fields", () => {
    const report = buildAuditIntegrityReport({
      chainResult: validChain(10),
      sampledEntries: 10,
      lastVerifiedAt: NOW.toISOString(),
      lastCheckpointAt: FRESH_CHECKPOINT,
      now: NOW,
    });
    expect(report).toHaveProperty("chainValid");
    expect(report).toHaveProperty("checkpointFresh");
    expect(report).toHaveProperty("sampledEntries", 10);
    expect(report).toHaveProperty("brokenAtSequence", null);
    expect(report).toHaveProperty("lastVerifiedAt", NOW.toISOString());
    expect(report).toHaveProperty("lastCheckpointAt", FRESH_CHECKPOINT);
    expect(report).toHaveProperty("checkpointAgeMs");
    expect(report).toHaveProperty("checkpointStale");
    expect(report).toHaveProperty("status");
  });

  it("sets sampledEntries correctly", () => {
    const report = buildAuditIntegrityReport({
      chainResult: validChain(42),
      sampledEntries: 42,
      lastVerifiedAt: null,
      lastCheckpointAt: null,
      now: NOW,
    });
    expect(report.sampledEntries).toBe(42);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("module constants", () => {
  it("AUDIT_INTEGRITY_SAMPLE_SIZE is a positive integer", () => {
    expect(Number.isInteger(AUDIT_INTEGRITY_SAMPLE_SIZE)).toBe(true);
    expect(AUDIT_INTEGRITY_SAMPLE_SIZE).toBeGreaterThan(0);
  });

  it("AUDIT_CHECKPOINT_STALE_MS is one hour", () => {
    expect(AUDIT_CHECKPOINT_STALE_MS).toBe(3_600_000);
  });
});
