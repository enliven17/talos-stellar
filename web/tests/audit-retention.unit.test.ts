import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  computeEntryHash,
  createAuditCheckpointBundle,
  verifyAuditCheckpointBundle,
  verifyChain,
  verifyChainRange,
  type AuditChainRow,
} from "../src/lib/audit-chain";
import {
  MAX_AUDIT_RETENTION_BATCH_SIZE,
  normalizeAuditRetentionPolicy,
  planAuditRetention,
  type AuditRetentionPolicy,
} from "../src/lib/audit-log/retention";
import { applyAuditRetention, AuditRetentionConflictError } from "../src/lib/audit-log/store";

const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    delete: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    transaction: vi.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
  };
  return { mockDb, mockTx };
});

vi.mock("@/db", () => ({ db: mockDb }));

// ─── Synthetic fixtures ─────────────────────────────────────────────────────

const TALOS = "agent-retention";
const SECRET = "synthetic-checkpoint-secret";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2025-01-01T00:00:00.000Z");
const NOW = new Date(T0 + 400 * DAY);

/** Build a valid chain; entry `i` is created `dayOf(i)` days after T0. */
function buildChain(
  count: number,
  dayOf: (i: number) => number = (i) => i,
  talosId = TALOS,
): AuditChainRow[] {
  const rows: AuditChainRow[] = [];
  for (let i = 0; i < count; i++) {
    const createdAt = new Date(T0 + dayOf(i) * DAY);
    const entryHash = computeEntryHash({
      sequenceNumber: i,
      talosId,
      method: "POST",
      path: `/api/talos/${talosId}/transfer`,
      statusCode: 200,
      ipAddress: "127.0.0.1",
      createdAt: createdAt.toISOString(),
    });
    rows.push({
      sequenceNumber: i,
      entryHash,
      previousHash: i === 0 ? GENESIS_HASH : rows[i - 1].entryHash,
      chainVersion: AUDIT_CHAIN_VERSION,
      talosId,
      method: "POST",
      path: `/api/talos/${talosId}/transfer`,
      statusCode: 200,
      ipAddress: "127.0.0.1",
      createdAt,
    });
  }
  return rows;
}

function checkpointFor(
  rows: AuditChainRow[],
  opts: { hmacSecret?: string | null; talosId?: string } = {},
) {
  return createAuditCheckpointBundle({
    talosId: opts.talosId ?? TALOS,
    rows,
    limit: 1000,
    fromSequence: rows[0]?.sequenceNumber ?? undefined,
    exportedAt: NOW,
    hmacSecret: opts.hmacSecret === undefined ? SECRET : opts.hmacSecret,
    privateKey: null,
    publicKey: null,
  });
}

const policy: AuditRetentionPolicy = {
  retentionMs: 365 * DAY,
  minRetainedEntries: 3,
  maxPruneBatch: 100,
};

function plan(
  rows: AuditChainRow[],
  checkpoint: unknown,
  overrides: Partial<AuditRetentionPolicy> = {},
  latestSequence: number | null = rows.length
    ? (rows[rows.length - 1].sequenceNumber as number)
    : null,
) {
  return planAuditRetention({
    talosId: TALOS,
    rows,
    latestSequence,
    checkpoint,
    checkpointVerification: { hmacSecret: SECRET },
    policy: { ...policy, ...overrides },
    now: NOW,
  });
}

function survivorsAfter(rows: AuditChainRow[], through: number) {
  return rows.filter((r) => (r.sequenceNumber as number) > through);
}

// ─── Planner ────────────────────────────────────────────────────────────────

describe("planAuditRetention", () => {
  it("prunes a verified closed range and retains the anchor so the surviving chain still verifies (before/after)", () => {
    const rows = buildChain(10);
    const checkpoint = checkpointFor(rows);

    // Before: the full chain verifies from genesis.
    expect(verifyChain(rows).status).toBe("valid");

    const result = plan(rows, checkpoint);
    expect(result).toMatchObject({
      action: "prune",
      reason: null,
      pruneFromSequence: 0,
      pruneThroughSequence: 6,
      pruneCount: 7,
    });
    expect(result.anchor).toMatchObject({
      sequenceNumber: 7,
      entryHash: rows[7].entryHash,
      previousHash: rows[6].entryHash,
    });

    // After: the anchor (seq 7) is retained, and every surviving range that
    // follows it verifies as complete against the anchor.
    const survivors = survivorsAfter(rows, result.pruneThroughSequence!);
    expect(survivors.map((r) => r.sequenceNumber)).toEqual([7, 8, 9]);
    const after = verifyChainRange(survivors.slice(1), { predecessor: result.anchor });
    expect(after).toMatchObject({ valid: true, status: "valid", complete: true, verifiedEntries: 2 });

    // The anchor itself is attested by the signed checkpoint operators keep.
    const signedAnchor = checkpoint.entries.find((e) => e.sequenceNumber === 7);
    expect(signedAnchor?.entryHash).toBe(result.anchor!.entryHash);
    expect(verifyAuditCheckpointBundle(checkpoint, { hmacSecret: SECRET }).valid).toBe(true);
  });

  it("shows why the anchor must be kept: dropping it leaves the surviving chain unverifiable", () => {
    const rows = buildChain(10);
    // Naive prune of [0, 7] removes the predecessor evidence for seq 8.
    const naiveSurvivors = survivorsAfter(rows, 7);
    const naive = verifyChainRange(naiveSurvivors);
    expect(naive.status).toBe("incomplete");
    expect(naive.incompleteReason).toBe("missing_predecessor");
  });

  it("continues from the retained anchor on the next run", () => {
    const rows = buildChain(15);
    const checkpoint = checkpointFor(rows);
    const first = plan(rows.slice(0, 10), checkpoint, {}, 9);
    expect(first.pruneThroughSequence).toBe(6);

    // Next run: oldest stored row is the anchor (seq 7); more entries arrived.
    const stored = survivorsAfter(rows, 6);
    const second = plan(stored, checkpoint);
    expect(second).toMatchObject({
      action: "prune",
      pruneFromSequence: 7,
      pruneThroughSequence: 11,
      pruneCount: 5,
    });
    expect(second.anchor?.sequenceNumber).toBe(12);
    const after = verifyChainRange(survivorsAfter(rows, 12), { predecessor: second.anchor });
    expect(after.status).toBe("valid");
  });

  it("never prunes past the signed checkpoint: the open tail stays closed-off", () => {
    const rows = buildChain(10);
    const checkpoint = checkpointFor(rows.slice(0, 5)); // closes [0, 4] only

    const result = plan(rows, checkpoint, { minRetainedEntries: 1 });
    expect(result.action).toBe("prune");
    expect(result.pruneThroughSequence).toBe(3);
    expect(result.anchor?.sequenceNumber).toBe(4);
  });

  it("treats the retention cutoff as inclusive and never prunes newer entries", () => {
    // Entries 0..4 are old; entry 5 is exactly at the cutoff; 6..9 are recent.
    const cutoffDay = 400 - 365;
    const rows = buildChain(10, (i) => (i < 5 ? i : i === 5 ? cutoffDay : cutoffDay + i));
    const result = plan(rows, checkpointFor(rows), { minRetainedEntries: 1 });

    expect(result.cutoff).toBe(new Date(T0 + cutoffDay * DAY).toISOString());
    expect(result.pruneThroughSequence).toBe(5);
    expect(result.anchor?.sequenceNumber).toBe(6);
  });

  it("is a no-op when every entry is within the retention window", () => {
    const rows = buildChain(10, (i) => 390 + i / 10);
    const result = plan(rows, checkpointFor(rows));
    expect(result).toMatchObject({ action: "noop", reason: "within_retention_window", pruneCount: 0 });
  });

  it("is a no-op when pruning would leave fewer than minRetainedEntries", () => {
    const rows = buildChain(10);
    const result = plan(rows, checkpointFor(rows), { minRetainedEntries: 10 });
    expect(result).toMatchObject({ action: "noop", reason: "min_retained_entries" });
  });

  it("bounds each run by maxPruneBatch", () => {
    const rows = buildChain(10);
    const result = plan(rows, checkpointFor(rows), { maxPruneBatch: 2 });
    expect(result).toMatchObject({ pruneFromSequence: 0, pruneThroughSequence: 1, pruneCount: 2 });
    expect(result.anchor?.sequenceNumber).toBe(2);
  });

  describe("refuses to prune unverified evidence", () => {
    it("rejects an unsigned checkpoint", () => {
      const rows = buildChain(10);
      const result = plan(rows, checkpointFor(rows, { hmacSecret: null }));
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_invalid", pruneCount: 0 });
      expect(result.checkpointFailureReason).toBe("invalid_signature");
    });

    it("rejects a checkpoint signed with a different key", () => {
      const rows = buildChain(10);
      const result = plan(rows, checkpointFor(rows, { hmacSecret: "other-secret" }));
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_invalid" });
    });

    it("rejects a checkpoint for another agent", () => {
      const rows = buildChain(10);
      const other = checkpointFor(buildChain(10, undefined, "other-agent"), { talosId: "other-agent" });
      const result = plan(rows, other);
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_invalid" });
      expect(result.checkpointFailureReason).toBe("talos_id_mismatch");
    });

    it("rejects a tampered stored row", () => {
      const rows = buildChain(10);
      const checkpoint = checkpointFor(rows);
      const tampered = rows.map((r) => ({ ...r }));
      tampered[3].path = "/api/talos/agent-retention/rewritten";
      const result = plan(tampered, checkpoint);
      expect(result).toMatchObject({
        action: "refused",
        reason: "chain_unverified",
        brokenAtSequence: 3,
        chainFailureReason: "entry_hash_mismatch",
      });
    });

    it("rejects a gap in the stored chain", () => {
      const rows = buildChain(10);
      const gapped = rows.filter((r) => r.sequenceNumber !== 3);
      const result = plan(gapped, checkpointFor(rows));
      expect(result).toMatchObject({
        action: "refused",
        reason: "chain_unverified",
        chainFailureReason: "sequence_gap",
      });
    });

    it("rejects stored rows that are self-consistent but diverge from the checkpoint", () => {
      const rows = buildChain(10);
      const rewritten = buildChain(10, (i) => i + 0.5); // a fully re-hashed history
      const result = plan(rewritten, checkpointFor(rows));
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_mismatch", brokenAtSequence: 0 });
    });

    it("rejects a checkpoint that does not cover the oldest stored entry", () => {
      const rows = buildChain(10);
      const result = plan(rows, checkpointFor(rows.slice(2)));
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_not_covering" });
    });

    it("rejects an empty checkpoint", () => {
      const rows = buildChain(10);
      const result = plan(rows, checkpointFor([]));
      expect(result).toMatchObject({ action: "refused", reason: "checkpoint_empty" });
    });

    it("rejects an invalid policy", () => {
      const rows = buildChain(10);
      const result = plan(rows, checkpointFor(rows), { minRetainedEntries: 0 });
      expect(result).toMatchObject({ action: "refused", reason: "invalid_policy" });
    });
  });

  it("clamps the batch size to the checkpoint bound", () => {
    expect(normalizeAuditRetentionPolicy({ maxPruneBatch: 1_000_000 })?.maxPruneBatch).toBe(
      MAX_AUDIT_RETENTION_BATCH_SIZE,
    );
  });
});

// ─── Store ──────────────────────────────────────────────────────────────────

describe("applyAuditRetention", () => {
  const rows = buildChain(10);
  const checkpoint = checkpointFor(rows);
  const options = {
    talosId: TALOS,
    checkpoint,
    policy,
    now: NOW,
    hmacSecret: SECRET,
    publicKey: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUDIT_RETENTION_ENABLED = "true";
    mockDb.limit.mockResolvedValueOnce([{ sequenceNumber: 9 }]).mockResolvedValueOnce(rows);
  });

  afterEach(() => {
    delete process.env.AUDIT_RETENTION_ENABLED;
  });

  it("deletes exactly the verified range in a transaction and keeps the anchor", async () => {
    mockTx.returning.mockResolvedValueOnce(Array.from({ length: 7 }, (_, i) => ({ id: `id-${i}` })));

    const result = await applyAuditRetention(options);

    expect(result.deleted).toBe(7);
    expect(result.plan.anchor?.sequenceNumber).toBe(7);
    expect(mockDb.limit).toHaveBeenNthCalledWith(2, policy.maxPruneBatch + 1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the delete does not match the verified row set", async () => {
    mockTx.returning.mockResolvedValueOnce([{ id: "only-one" }]);
    await expect(applyAuditRetention(options)).rejects.toBeInstanceOf(AuditRetentionConflictError);
  });

  it("plans without deleting on a dry run", async () => {
    const result = await applyAuditRetention({ ...options, dryRun: true });
    expect(result.plan.action).toBe("prune");
    expect(result.deleted).toBe(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("never deletes while retention is disabled (the default)", async () => {
    delete process.env.AUDIT_RETENTION_ENABLED;
    const result = await applyAuditRetention(options);
    expect(result).toMatchObject({ enabled: false, deleted: 0 });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("never deletes when the plan is refused", async () => {
    const result = await applyAuditRetention({ ...options, hmacSecret: "wrong" });
    expect(result.plan.action).toBe("refused");
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
