import { vi, describe, it, expect, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
}));
vi.mock("@/db", () => ({ db: mocks.mockDb }));

import * as store from "../src/lib/outbox/store";

function chainable<T>(result: T) {
  const obj: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "set", "values"]) obj[method] = vi.fn(() => obj);
  obj.returning = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const { mockDb } = mocks;
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
});

function useAckFixture(
  row: {
    id: string;
    eventType: string;
    status: string;
    attempts: number;
    leaseId: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    dispatchedAt: Date | null;
  },
  databaseNow: Date,
) {
  mockDb.update.mockImplementation(() => {
    let updates: Record<string, unknown> = {};
    let condition: SQL | undefined;
    const query: Record<string, unknown> = {};
    query.set = vi.fn((values: Record<string, unknown>) => {
      updates = values;
      return query;
    });
    query.where = vi.fn((where: SQL) => {
      condition = where;
      return query;
    });
    query.returning = vi.fn(async () => {
      if (!condition) throw new Error("Ack update did not include a WHERE clause");

      const { sql, params } = dialect.sqlToQuery(condition);
      const predicates = [...sql.matchAll(/"tls_outbox_events"\."([^"]+)"\s*(=|>)\s*(\$\d+|now\(\))/g)];
      const matchesRow = predicates.length === 4 && predicates.every(([, column, operator, operand]) => {
        const left = row[column as keyof typeof row];
        const right = operand === "now()" ? databaseNow : params[Number(operand.slice(1)) - 1];
        if (operator === "=") return left === right;
        return left instanceof Date && right instanceof Date && left.getTime() > right.getTime();
      });

      if (!matchesRow) return [];
      Object.assign(row, updates);
      return [row];
    });
    return query;
  });
}

describe("outbox/store — writeOutboxEvent", () => {
  it("inserts within the given tx when no dedupeKey is given", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    const inserted = { id: "evt_1", eventType: "x", aggregateType: "y" };
    tx.insert.mockReturnValue({ values: vi.fn(() => chainable([inserted])) });

    const event = await store.writeOutboxEvent(tx as never, {
      aggregateType: "y",
      aggregateId: "1",
      eventType: "x",
      payload: {},
    });

    expect(event.id).toBe("evt_1");
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("returns the existing row instead of inserting when dedupeKey already exists", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select.mockReturnValue(chainable([{ id: "evt_existing" }]));

    const event = await store.writeOutboxEvent(tx as never, {
      aggregateType: "y",
      aggregateId: "1",
      eventType: "x",
      payload: {},
      dedupeKey: "k1",
    });

    expect(event.id).toBe("evt_existing");
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

describe("outbox/store — leaseBatch", () => {
  it("claims rows via db.execute and maps them", async () => {
    mockDb.execute.mockResolvedValue({ rows: [{ id: "evt_1", eventType: "x", leaseId: "l1", status: "leased" }] });
    const rows = await store.leaseBatch(10, "worker-1", 15_000);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it("returns [] without querying when limit <= 0", async () => {
    const rows = await store.leaseBatch(0);
    expect(rows).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});

describe("outbox/store — ack", () => {
  const databaseNow = new Date("2026-11-18T12:00:00.000Z");
  const makeAckRow = (overrides: Partial<Parameters<typeof useAckFixture>[0]> = {}) => ({
    id: "evt_1",
    eventType: "x",
    status: "leased",
    attempts: 1,
    leaseId: "lease_1",
    leaseOwner: "worker_1",
    leaseExpiresAt: new Date(databaseNow.getTime() + 1_000),
    dispatchedAt: null,
    ...overrides,
  });

  it("rejects an expired lease without changing the row", async () => {
    const row = makeAckRow({ leaseExpiresAt: new Date(databaseNow.getTime() - 1) });
    useAckFixture(row, databaseNow);

    const result = await store.ack("evt_1", "lease_1");

    expect(result).toBeNull();
    expect(row).toMatchObject({ status: "leased", leaseId: "lease_1", leaseOwner: "worker_1" });
  });

  it("rejects a lease whose deadline equals database time", async () => {
    const row = makeAckRow({ leaseExpiresAt: databaseNow });
    useAckFixture(row, databaseNow);

    const result = await store.ack("evt_1", "lease_1");

    expect(result).toBeNull();
    expect(row).toMatchObject({ status: "leased", leaseId: "lease_1", leaseOwner: "worker_1" });
  });

  it("preserves a newer worker's active lease when an old worker acknowledges", async () => {
    const row = makeAckRow({
      leaseId: "new_lease",
      leaseOwner: "worker_2",
      leaseExpiresAt: new Date(databaseNow.getTime() + 5_000),
    });
    useAckFixture(row, databaseNow);

    const result = await store.ack("evt_1", "old_lease");

    expect(result).toBeNull();
    expect(row).toMatchObject({ status: "leased", leaseId: "new_lease", leaseOwner: "worker_2" });
  });

  it("dispatches a matching lease that is still active", async () => {
    const row = makeAckRow();
    useAckFixture(row, databaseNow);

    const result = await store.ack("evt_1", "lease_1");

    expect(result?.status).toBe("dispatched");
    expect(row).toMatchObject({ status: "dispatched", leaseId: null, leaseOwner: null, leaseExpiresAt: null });
  });
});

describe("outbox/store — fail", () => {
  it("reschedules below maxAttempts", async () => {
    mockDb.select.mockReturnValue(chainable([{ id: "evt_1", leaseId: "l1", status: "leased", attempts: 1, maxAttempts: 8 }]));
    mockDb.update.mockReturnValue(chainable([{ id: "evt_1", eventType: "x", status: "pending", attempts: 1 }]));
    const result = await store.fail("evt_1", "l1", new Error("boom"));
    expect(result?.status).toBe("pending");
  });

  it("dead-letters once attempts reach maxAttempts", async () => {
    mockDb.select.mockReturnValue(chainable([{ id: "evt_1", leaseId: "l1", status: "leased", attempts: 8, maxAttempts: 8 }]));
    mockDb.update.mockReturnValue(chainable([{ id: "evt_1", eventType: "x", status: "dead_letter", attempts: 8 }]));
    const result = await store.fail("evt_1", "l1", new Error("boom"));
    expect(result?.status).toBe("dead_letter");
  });

  it("schedules retry runAt using a relative SQL interval instead of wall-clock Date.now()", async () => {
    const updateChain = chainable([{ id: "evt_1", eventType: "x", status: "pending", attempts: 1 }]);
    mockDb.select.mockReturnValue(chainable([{ id: "evt_1", leaseId: "l1", status: "leased", attempts: 2, maxAttempts: 8 }]));
    mockDb.update.mockReturnValue(updateChain);

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const result = await store.fail("evt_1", "l1", new Error("boom"));
      expect(result?.status).toBe("pending");
      expect(dateNowSpy).not.toHaveBeenCalled();
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as { runAt: unknown };
      expect(setArg.runAt).not.toBeInstanceOf(Date);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns null when the lease was already lost", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    expect(await store.fail("evt_1", "stale", new Error("x"))).toBeNull();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("outbox/store — deferRetry", () => {
  it("defers a prematurely-leased event with a bounded relative SQL interval", async () => {
    const updateChain = chainable([{ id: "evt_1", eventType: "x", status: "pending", attempts: 1 }]);
    mockDb.update.mockReturnValue(updateChain);

    const result = await store.deferRetry("evt_1", "l1", 10_000);
    expect(result?.status).toBe("pending");
    const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as { runAt: unknown };
    expect(setArg.runAt).not.toBeInstanceOf(Date);
  });

  it("returns null when the lease was lost", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    expect(await store.deferRetry("evt_1", "stale", 5_000)).toBeNull();
  });
});

describe("outbox/store — requeue", () => {
  it("resets a dead_letter event to pending and preserves failure identity", async () => {
    mockDb.update.mockReturnValue(
      chainable([{ id: "evt_1", status: "pending", attempts: 0, originalEventId: "evt_1" }]),
    );
    const result = await store.requeue("evt_1");
    expect(result?.status).toBe("pending");
    expect(result?.originalEventId).toBe("evt_1");
  });

  it("preserves an existing originalEventId across repeated requeues", async () => {
    mockDb.update.mockReturnValue(
      chainable([{ id: "evt_1", status: "pending", attempts: 0, originalEventId: "evt_original_ancestor" }]),
    );
    const result = await store.requeue("evt_1");
    expect(result?.status).toBe("pending");
    expect(result?.originalEventId).toBe("evt_original_ancestor");
  });

  it("returns null for a non-dead_letter event", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    expect(await store.requeue("evt_1")).toBeNull();
  });
});

describe("outbox/store — reapExpiredLeases", () => {
  it("counts requeued and dead-lettered rows", async () => {
    mockDb.update
      .mockReturnValueOnce(chainable([{ id: "a", eventType: "x" }]))
      .mockReturnValueOnce(chainable([{ id: "b", eventType: "x" }, { id: "c", eventType: "x" }]));
    const result = await store.reapExpiredLeases();
    expect(result).toEqual({ requeued: 1, deadLettered: 2 });
  });
});

describe("outbox/store — pruneDispatched", () => {
  it("deletes dispatched events past retention and returns the count", async () => {
    mockDb.delete.mockReturnValue(chainable([{ id: "evt_1" }, { id: "evt_2" }]));
    const count = await store.pruneDispatched(7);
    expect(count).toBe(2);
  });
});

describe("outbox/store — previewPruneDispatched", () => {
  it("returns counts and oldest timestamp for dispatched events past retention", async () => {
    mockDb.select.mockReturnValue(chainable([{ count: "2", oldest: "2026-01-01T00:00:00Z" }]));
    const result = await store.previewPruneDispatched(7);
    expect(result).toEqual({ count: 2, oldestRetainedTimestamp: new Date("2026-01-01T00:00:00Z") });
  });

  it("returns null for oldestRetainedTimestamp when no rows found", async () => {
    mockDb.select.mockReturnValue(chainable([{ count: "0", oldest: null }]));
    const result = await store.previewPruneDispatched(7);
    expect(result).toEqual({ count: 0, oldestRetainedTimestamp: null });
  });
});

describe("outbox/store — listEvents / getEvent", () => {
  it("computes nextCursor when there's an extra row", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `evt_${i}`, createdAt: new Date(Date.now() - i * 1000) }));
    mockDb.select.mockReturnValue(chainable(rows));
    const { events, nextCursor } = await store.listEvents({ limit: 50 });
    expect(events).toHaveLength(50);
    expect(nextCursor).toBe(rows[49].createdAt.toISOString());
  });

  it("getEvent returns null for a missing id", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    expect(await store.getEvent("missing")).toBeNull();
  });
});

describe("outbox/store — per-consumer delivery tracking", () => {
  it("getConsumerDeliveries returns persisted consumer delivery rows for an event", async () => {
    const rows = [
      { id: "del_1", eventId: "evt_1", consumerId: "consumer-a", status: "acked", attempts: 1 },
      { id: "del_2", eventId: "evt_1", consumerId: "consumer-b", status: "pending", attempts: 1 },
    ];
    mockDb.select.mockReturnValue(chainable(rows));

    const result = await store.getConsumerDeliveries("evt_1");
    expect(result).toHaveLength(2);
    expect(result[0].consumerId).toBe("consumer-a");
    expect(result[1].status).toBe("pending");
  });

  it("ackConsumer inserts an acked delivery row when none exists", async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{ id: "evt_1", eventType: "x", leaseId: "l1", status: "leased", maxAttempts: 8 }]))
      .mockReturnValueOnce(chainable([]));
    mockDb.insert.mockReturnValue(
      chainable([{ id: "del_1", eventId: "evt_1", consumerId: "consumer-a", status: "acked", attempts: 1 }]),
    );

    const result = await store.ackConsumer("evt_1", "consumer-a", "l1");
    expect(result?.status).toBe("acked");
    expect(result?.attempts).toBe(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it("ackConsumer returns null when the event lease was lost", async () => {
    mockDb.select.mockReturnValueOnce(chainable([]));
    expect(await store.ackConsumer("evt_1", "consumer-a", "stale")).toBeNull();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("failConsumer schedules retry below maxAttempts and dead-letters at maxAttempts", async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([{ id: "evt_1", eventType: "x", leaseId: "l1", status: "leased", maxAttempts: 3 }]))
      .mockReturnValueOnce(chainable([{ id: "del_1", eventId: "evt_1", consumerId: "consumer-b", attempts: 1, maxAttempts: 3 }]));
    mockDb.update.mockReturnValueOnce(
      chainable([{ id: "del_1", eventId: "evt_1", consumerId: "consumer-b", status: "pending", attempts: 2, maxAttempts: 3 }]),
    );

    const retried = await store.failConsumer("evt_1", "consumer-b", "l1", new Error("timeout"));
    expect(retried?.status).toBe("pending");
    expect(retried?.attempts).toBe(2);

    mockDb.select
      .mockReturnValueOnce(chainable([{ id: "evt_1", eventType: "x", leaseId: "l2", status: "leased", maxAttempts: 3 }]))
      .mockReturnValueOnce(chainable([{ id: "del_1", eventId: "evt_1", consumerId: "consumer-b", attempts: 2, maxAttempts: 3 }]));
    mockDb.update.mockReturnValueOnce(
      chainable([{ id: "del_1", eventId: "evt_1", consumerId: "consumer-b", status: "dead_letter", attempts: 3, maxAttempts: 3 }]),
    );

    const deadLettered = await store.failConsumer("evt_1", "consumer-b", "l2", new Error("fatal"));
    expect(deadLettered?.status).toBe("dead_letter");
    expect(deadLettered?.attempts).toBe(3);
  });

  it("rescheduleForRetry and deadLetter respect lease ownership", async () => {
    mockDb.update.mockReturnValueOnce(chainable([{ id: "evt_1", eventType: "x", status: "pending", attempts: 1 }]));
    const rescheduled = await store.rescheduleForRetry("evt_1", "l1", new Date(Date.now() + 5_000), new Error("retry"));
    expect(rescheduled?.status).toBe("pending");

    mockDb.update.mockReturnValueOnce(chainable([]));
    expect(await store.deadLetter("evt_1", "stale", new Error("fatal"))).toBeNull();
  });
});
