/**
 * Unit tests for web/src/lib/idempotency/reservation-store.ts
 *
 * Covers:
 *   1. First reservation of a fresh key → "ok"
 *   2. Replay of a completed key → "replay" + stored result
 *   3. In-flight conflict (reserved, not yet completed) → "conflict"
 *   4. Payload-hash mismatch on an existing key → "hash_mismatch"
 *   5. Expired key reuse → "ok" (old row removed, fresh reservation inserted)
 *   6. complete() transitions reserved → completed
 *   7. release() removes a reserved key so it can be retried
 *   8. purgeExpired() deletes only expired rows
 *
 * Postgres is never touched — all drizzle calls are intercepted via
 * vi.mock("@/db"). Fake timers drive expiry semantics.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  function makeSelectChain(rows: Record<string, unknown>[]) {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(rows)),
    };
  }

  function makeInsertChain() {
    return { values: vi.fn().mockResolvedValue([]) };
  }

  function makeUpdateChain() {
    return {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
  }

  function makeDeleteChain() {
    return { where: vi.fn().mockResolvedValue([]) };
  }

  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  return { mockDb, makeSelectChain, makeInsertChain, makeUpdateChain, makeDeleteChain };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

vi.mock("@/db/schema", () => ({
  tlsIdempotencyKeys: { _: "tls_idempotency_keys" },
}));

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { reserve, complete, release, purgeExpired, hashPayload } from "@/lib/idempotency/reservation-store";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const KEY = "tx_abc123";
const PAYLOAD = { buyerPublicKey: "GBUYER", amount: 10 };
const HASH = hashPayload(PAYLOAD);
const TTL_MS = 60_000;

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "row_1",
    key: KEY,
    payloadHash: HASH,
    status: "reserved",
    result: null,
    expiresAt: new Date(Date.now() + TTL_MS),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. First reservation ─────────────────────────────────────────────────────

describe("reserve — first reservation of a fresh key", () => {
  it('returns { status: "ok" } and inserts a reserved row', async () => {
    mocks.mockDb.select.mockReturnValueOnce(mocks.makeSelectChain([]));
    mocks.mockDb.insert.mockReturnValueOnce(mocks.makeInsertChain());

    const result = await reserve(KEY, HASH, TTL_MS);

    expect(result.status).toBe("ok");
    expect(mocks.mockDb.insert).toHaveBeenCalledTimes(1);
    const inserted = mocks.mockDb.insert.mock.results[0].value.values.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.key).toBe(KEY);
    expect(inserted.payloadHash).toBe(HASH);
    expect(inserted.status).toBe("reserved");
    expect(inserted.expiresAt).toBeInstanceOf(Date);
  });
});

// ─── 2. Replay of completed result ───────────────────────────────────────────

describe("reserve — replay of a completed key", () => {
  it('returns { status: "replay", result } without inserting', async () => {
    const storedResult = { mitosTxHash: "mitos_xyz", totalCost: 5 };
    mocks.mockDb.select.mockReturnValueOnce(
      mocks.makeSelectChain([makeRow({ status: "completed", result: storedResult })]),
    );

    const result = await reserve(KEY, HASH, TTL_MS);

    expect(result.status).toBe("replay");
    if (result.status === "replay") expect(result.result).toEqual(storedResult);
    expect(mocks.mockDb.insert).not.toHaveBeenCalled();
  });

  it("replays even when the caller sends a different TTL on retry", async () => {
    const storedResult = { jobId: "job_1", status: "completed" };
    mocks.mockDb.select.mockReturnValueOnce(
      mocks.makeSelectChain([makeRow({ status: "completed", result: storedResult })]),
    );

    const result = await reserve(KEY, HASH, 999_999);

    expect(result.status).toBe("replay");
    if (result.status === "replay") expect(result.result).toEqual(storedResult);
  });
});

// ─── 3. In-flight conflict ───────────────────────────────────────────────────

describe("reserve — in-flight conflict", () => {
  it('returns { status: "conflict" } when the key is already reserved', async () => {
    mocks.mockDb.select.mockReturnValueOnce(
      mocks.makeSelectChain([makeRow({ status: "reserved" })]),
    );

    const result = await reserve(KEY, HASH, TTL_MS);

    expect(result.status).toBe("conflict");
    expect(mocks.mockDb.insert).not.toHaveBeenCalled();
  });
});

// ─── 4. Payload-hash mismatch ────────────────────────────────────────────────

describe("reserve — payload-hash mismatch", () => {
  it('returns { status: "hash_mismatch" } when hash differs', async () => {
    const differentHash = hashPayload({ buyerPublicKey: "GOTHER", amount: 99 });
    mocks.mockDb.select.mockReturnValueOnce(
      mocks.makeSelectChain([makeRow({ status: "reserved", payloadHash: HASH })]),
    );

    const result = await reserve(KEY, differentHash, TTL_MS);

    expect(result.status).toBe("hash_mismatch");
    expect(mocks.mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects hash mismatch even on a completed row", async () => {
    const attackerHash = hashPayload({ buyerPublicKey: "GATTACKER", amount: 1 });
    mocks.mockDb.select.mockReturnValueOnce(
      mocks.makeSelectChain([makeRow({ status: "completed", result: { ok: true }, payloadHash: HASH })]),
    );

    const result = await reserve(KEY, attackerHash, TTL_MS);

    expect(result.status).toBe("hash_mismatch");
  });
});

// ─── 5. Expired key reuse ────────────────────────────────────────────────────

describe("reserve — expired key reuse", () => {
  it('returns { status: "ok" } and replaces the expired row', async () => {
    vi.advanceTimersByTime(TTL_MS + 1);
    const expiredRow = makeRow({ expiresAt: new Date(Date.now() - 1) });

    mocks.mockDb.select.mockReturnValueOnce(mocks.makeSelectChain([expiredRow]));
    mocks.mockDb.delete.mockReturnValueOnce(mocks.makeDeleteChain());
    mocks.mockDb.insert.mockReturnValueOnce(mocks.makeInsertChain());

    const result = await reserve(KEY, HASH, TTL_MS);

    expect(result.status).toBe("ok");
    expect(mocks.mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mocks.mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("treats an expired completed row as free", async () => {
    vi.advanceTimersByTime(TTL_MS + 1);
    const expiredCompleted = makeRow({
      status: "completed",
      result: { mitosTxHash: "old_tx" },
      expiresAt: new Date(Date.now() - 1),
    });

    mocks.mockDb.select.mockReturnValueOnce(mocks.makeSelectChain([expiredCompleted]));
    mocks.mockDb.delete.mockReturnValueOnce(mocks.makeDeleteChain());
    mocks.mockDb.insert.mockReturnValueOnce(mocks.makeInsertChain());

    const result = await reserve(KEY, HASH, TTL_MS);

    expect(result.status).toBe("ok");
    expect(mocks.mockDb.delete).toHaveBeenCalledTimes(1);
  });
});

// ─── 6. complete() ───────────────────────────────────────────────────────────

describe("complete()", () => {
  it("updates the row from reserved to completed with the given result", async () => {
    const completionResult = { jobId: "job_99", txHash: "stellar_tx_1" };
    mocks.mockDb.update.mockReturnValueOnce(mocks.makeUpdateChain());

    await complete(KEY, completionResult);

    expect(mocks.mockDb.update).toHaveBeenCalledTimes(1);
    const setArg = mocks.mockDb.update.mock.results[0].value.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe("completed");
    expect(setArg.result).toEqual(completionResult);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("is a no-op when called on an already-completed key", async () => {
    mocks.mockDb.update.mockReturnValueOnce(mocks.makeUpdateChain());
    await expect(complete(KEY, { ok: true })).resolves.toBeUndefined();
  });
});

// ─── 7. release() ────────────────────────────────────────────────────────────

describe("release()", () => {
  it("deletes the reserved row so the key can be retried", async () => {
    mocks.mockDb.delete.mockReturnValueOnce(mocks.makeDeleteChain());

    await release(KEY);

    expect(mocks.mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mocks.mockDb.delete.mock.results[0].value.where).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. purgeExpired() ───────────────────────────────────────────────────────

describe("purgeExpired()", () => {
  it("deletes rows where expiresAt < now", async () => {
    mocks.mockDb.delete.mockReturnValueOnce(mocks.makeDeleteChain());

    await purgeExpired();

    expect(mocks.mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mocks.mockDb.delete.mock.results[0].value.where).toHaveBeenCalledTimes(1);
  });
});

// ─── 9. hashPayload() ────────────────────────────────────────────────────────

describe("hashPayload()", () => {
  it("returns a 64-char hex string (SHA-256)", () => {
    expect(hashPayload({ foo: "bar" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashPayload({ amount: 10, buyerPublicKey: "GBUYER" }))
      .toBe(hashPayload({ amount: 10, buyerPublicKey: "GBUYER" }));
  });

  it("is sensitive to payload changes", () => {
    expect(hashPayload({ amount: 10 })).not.toBe(hashPayload({ amount: 11 }));
  });
});
