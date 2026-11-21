import { vi, describe, it, expect, beforeEach } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it("marks dispatched and returns the row", async () => {
    mockDb.update.mockReturnValue(chainable([{ id: "evt_1", eventType: "x", status: "dispatched", attempts: 1 }]));
    const result = await store.ack("evt_1", "lease_1");
    expect(result?.status).toBe("dispatched");
  });

  it("returns null when the lease was lost", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    expect(await store.ack("evt_1", "stale")).toBeNull();
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

  it("returns null when the lease was already lost", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    expect(await store.fail("evt_1", "stale", new Error("x"))).toBeNull();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("outbox/store — requeue", () => {
  it("resets a dead_letter event to pending", async () => {
    mockDb.update.mockReturnValue(chainable([{ id: "evt_1", status: "pending", attempts: 0 }]));
    const result = await store.requeue("evt_1");
    expect(result?.status).toBe("pending");
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
