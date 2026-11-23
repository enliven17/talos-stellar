import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {
    reapExpiredLeases: vi.fn(),
    pruneDispatched: vi.fn(),
    leaseBatch: vi.fn(),
    ack: vi.fn(),
    fail: vi.fn(),
    getConsumerDeliveries: vi.fn(),
    ackConsumer: vi.fn(),
    failConsumer: vi.fn(),
    rescheduleForRetry: vi.fn(),
    deadLetter: vi.fn(),
  },
}));
vi.mock("../src/lib/outbox/store", () => mocks.store);

import { dispatchOnce } from "../src/lib/outbox/dispatcher";
import { registerConsumer, getRegisteredConsumers, __resetRegistryForTests } from "../src/lib/outbox/registry";
import type { OutboxConsumerDelivery, OutboxEvent } from "../src/lib/outbox/types";

function makeEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "evt_1",
    aggregateType: "commerce_job",
    aggregateId: "job_1",
    eventType: "test.event",
    payload: {},
    status: "leased",
    runAt: new Date(),
    leaseId: "lease_1",
    leaseOwner: "worker_1",
    leaseExpiresAt: new Date(Date.now() + 15_000),
    attempts: 1,
    maxAttempts: 8,
    dedupeKey: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    dispatchedAt: null,
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<OutboxConsumerDelivery> = {}): OutboxConsumerDelivery {
  return {
    id: "del_1",
    eventId: "evt_1",
    consumerId: "consumer#0",
    status: "acked",
    attempts: 1,
    maxAttempts: 8,
    nextRetryAt: new Date(),
    lastError: null,
    ackedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  __resetMonotonicRetryStateForTests();
  mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 0, deadLettered: 0 });
  mocks.store.pruneDispatched.mockResolvedValue(0);
  mocks.store.getConsumerDeliveries.mockResolvedValue([]);
  mocks.store.ackConsumer.mockImplementation(async (eventId: string, consumerId: string) =>
    makeDelivery({ eventId, consumerId, status: "acked" }),
  );
  mocks.store.failConsumer.mockImplementation(async (eventId: string, consumerId: string) =>
    makeDelivery({
      eventId,
      consumerId,
      status: "pending",
      nextRetryAt: new Date(Date.now() + 5_000),
      ackedAt: null,
      lastError: "downstream error",
    }),
  );
  mocks.store.rescheduleForRetry.mockResolvedValue(makeEvent({ status: "pending" }));
  mocks.store.deadLetter.mockResolvedValue(makeEvent({ status: "dead_letter" }));
});

describe("outbox/dispatcher — dispatchOnce", () => {
  it("reaps and prunes, and returns an empty summary when nothing is leased", async () => {
    mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 1, deadLettered: 1 });
    mocks.store.pruneDispatched.mockResolvedValue(3);
    mocks.store.leaseBatch.mockResolvedValue([]);

    const summary = await dispatchOnce();

    expect(summary).toEqual({ leased: 0, dispatched: 0, retried: 0, deadLettered: 0, quarantined: 0, reaped: 2, pruned: 3 });
  });

  it("runs all consumers and acks on success", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", consumer);
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));

    const summary = await dispatchOnce();

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(mocks.store.ack).toHaveBeenCalledWith("evt_1", "lease_1");
    expect(summary.dispatched).toBe(1);
  });

  it("runs multiple registered consumers for the same event type", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", a);
    registerConsumer("test.event", b);
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));

    await dispatchOnce();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("dead-letters immediately when no consumer is registered", async () => {
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ eventType: "unregistered" })]);
    mocks.store.fail.mockResolvedValue(makeEvent({ status: "dead_letter" }));

    const summary = await dispatchOnce();

    expect(mocks.store.fail).toHaveBeenCalledWith("evt_1", "lease_1", expect.any(Error));
    expect(summary.deadLettered).toBe(1);
  });

  it("retries when a consumer throws and attempts remain", async () => {
    registerConsumer("test.event", "failing-consumer", vi.fn().mockRejectedValue(new Error("downstream 500")));
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);

    const summary = await dispatchOnce();

    expect(mocks.store.failConsumer).toHaveBeenCalledWith("evt_1", "failing-consumer", "lease_1", expect.any(Error));
    expect(mocks.store.rescheduleForRetry).toHaveBeenCalledWith("evt_1", "lease_1", expect.any(Date), expect.any(Error));
    expect(summary.retried).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(mocks.store.ack).not.toHaveBeenCalled();
  });

  it("counts a dead-lettered event when consumer retries are exhausted", async () => {
    registerConsumer("test.event", "fatal-consumer", vi.fn().mockRejectedValue(new Error("fatal")));
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.failConsumer.mockResolvedValue(
      makeDelivery({ consumerId: "fatal-consumer", status: "dead_letter", attempts: 8, ackedAt: null, lastError: "fatal" }),
    );

    const summary = await dispatchOnce();

    expect(mocks.store.deadLetter).toHaveBeenCalledWith("evt_1", "lease_1", expect.any(Error));
    expect(summary.deadLettered).toBe(1);
  });

  it("avoids redispatching successful consumers when another consumer fails and retries", async () => {
    const delivered = new Map<string, OutboxConsumerDelivery>();
    const consumerA = vi.fn().mockResolvedValue(undefined);
    let bShouldFail = true;
    const consumerB = vi.fn().mockImplementation(async () => {
      if (bShouldFail) throw new Error("temporary failure");
    });

    registerConsumer("test.event", "consumer-a", consumerA);
    registerConsumer("test.event", "consumer-b", consumerB);

    mocks.store.getConsumerDeliveries.mockImplementation(async () => Array.from(delivered.values()));
    mocks.store.ackConsumer.mockImplementation(async (eventId: string, consumerId: string) => {
      const row = makeDelivery({ eventId, consumerId, status: "acked" });
      delivered.set(consumerId, row);
      return row;
    });
    mocks.store.failConsumer.mockImplementation(async (eventId: string, consumerId: string) => {
      const row = makeDelivery({
        eventId,
        consumerId,
        status: "pending",
        nextRetryAt: new Date(Date.now() - 1_000),
        ackedAt: null,
        lastError: "temporary failure",
      });
      delivered.set(consumerId, row);
      return row;
    });

    // Attempt 1: consumer-a succeeds, consumer-b fails -> event rescheduled
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ leaseId: "lease_1" })]);
    const first = await dispatchOnce();

    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).toHaveBeenCalledTimes(1);
    expect(first.retried).toBe(1);
    expect(first.dispatched).toBe(0);
    expect(mocks.store.ack).not.toHaveBeenCalled();

    // Attempt 2: consumer-b recovers -> consumer-a is NOT redispatched, only consumer-b runs
    bShouldFail = false;
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ leaseId: "lease_2", attempts: 2 })]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));

    const second = await dispatchOnce();

    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).toHaveBeenCalledTimes(2);
    expect(second.dispatched).toBe(1);
    expect(mocks.store.ack).toHaveBeenCalledWith("evt_1", "lease_2");
  });

  it("skips pending consumers whose nextRetryAt is still in the future", async () => {
    const consumerA = vi.fn().mockResolvedValue(undefined);
    const consumerB = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", "consumer-a", consumerA);
    registerConsumer("test.event", "consumer-b", consumerB);

    const futureRetry = new Date(Date.now() + 60_000);
    mocks.store.getConsumerDeliveries.mockResolvedValue([
      makeDelivery({ consumerId: "consumer-a", status: "acked" }),
      makeDelivery({ consumerId: "consumer-b", status: "pending", nextRetryAt: futureRetry, ackedAt: null, lastError: "wait" }),
    ]);
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);

    const summary = await dispatchOnce();

    expect(consumerA).not.toHaveBeenCalled();
    expect(consumerB).not.toHaveBeenCalled();
    expect(mocks.store.rescheduleForRetry).toHaveBeenCalledWith("evt_1", "lease_1", futureRetry, "wait");
    expect(summary.retried).toBe(1);
  });

  it("stops cleanly if the lease is lost while persisting a consumer ack", async () => {
    const consumerA = vi.fn().mockResolvedValue(undefined);
    const consumerB = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", "consumer-a", consumerA);
    registerConsumer("test.event", "consumer-b", consumerB);

    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.ackConsumer.mockResolvedValueOnce(null);

    const summary = await dispatchOnce();

    expect(consumerA).toHaveBeenCalledTimes(1);
    expect(consumerB).not.toHaveBeenCalled();
    expect(mocks.store.ack).not.toHaveBeenCalled();
    expect(summary).toEqual({ leased: 1, dispatched: 0, retried: 0, deadLettered: 0, reaped: 0, pruned: 0 });
  });

  it("rejects duplicate explicit consumer ids for the same event type", () => {
    registerConsumer("test.event", "billing", vi.fn().mockResolvedValue(undefined));
    expect(() => registerConsumer("test.event", "billing", vi.fn().mockResolvedValue(undefined))).toThrow(
      /already registered/,
    );
    expect(getRegisteredConsumers("test.event").map((c) => c.id)).toEqual(["billing"]);
  });

  it("processes a batch concurrently", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", consumer);
    mocks.store.leaseBatch.mockResolvedValue([
      makeEvent({ id: "evt_1", leaseId: "l1" }),
      makeEvent({ id: "evt_2", leaseId: "l2" }),
    ]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));

    const summary = await dispatchOnce();

    expect(consumer).toHaveBeenCalledTimes(2);
    expect(summary.leased).toBe(2);
    expect(summary.dispatched).toBe(2);
  });

  it("defers a failed backlog instead of retrying immediately when the system clock moves backward", async () => {
    let monotonicMs = 10_000;
    const consumer = vi
      .fn()
      .mockRejectedValueOnce(new Error("downstream 500"))
      .mockRejectedValueOnce(new Error("downstream 500"))
      .mockResolvedValue(undefined);
    registerConsumer("test.event", consumer);

    const updatedAt = new Date("2026-11-19T12:00:00.000Z");
    const runAt = new Date("2026-11-19T12:00:10.000Z"); // 10s relative backoff

    mocks.store.leaseBatch.mockResolvedValueOnce([
      makeEvent({ id: "evt_1", leaseId: "l1" }),
      makeEvent({ id: "evt_2", leaseId: "l2" }),
    ]);
    mocks.store.fail
      .mockResolvedValueOnce(makeEvent({ id: "evt_1", status: "pending", updatedAt, runAt }))
      .mockResolvedValueOnce(makeEvent({ id: "evt_2", status: "pending", updatedAt, runAt }));

    const first = await dispatchOnce({ monotonicNowMs: () => monotonicMs });
    expect(first.retried).toBe(2);
    expect(consumer).toHaveBeenCalledTimes(2);

    // Simulate system wall clock moving backward by 10 minutes while monotonic
    // time only advances by 500ms, and the DB returns both failed events early.
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(updatedAt.getTime() - 600_000);
    try {
      monotonicMs += 500;
      mocks.store.leaseBatch.mockResolvedValueOnce([
        makeEvent({ id: "evt_1", leaseId: "l3" }),
        makeEvent({ id: "evt_2", leaseId: "l4" }),
      ]);
      mocks.store.deferRetry
        .mockResolvedValueOnce(makeEvent({ id: "evt_1", status: "pending" }))
        .mockResolvedValueOnce(makeEvent({ id: "evt_2", status: "pending" }));

      const duringRollback = await dispatchOnce({ monotonicNowMs: () => monotonicMs });
      expect(duringRollback.retried).toBe(2);
      expect(consumer).toHaveBeenCalledTimes(2); // not retried early
      expect(mocks.store.deferRetry).toHaveBeenCalledWith("evt_1", "l3", 9_500);
      expect(mocks.store.deferRetry).toHaveBeenCalledWith("evt_2", "l4", 9_500);

      // Once monotonic time advances past the 10s cooldown, retries proceed normally.
      monotonicMs += 9_500;
      mocks.store.leaseBatch.mockResolvedValueOnce([
        makeEvent({ id: "evt_1", leaseId: "l5" }),
        makeEvent({ id: "evt_2", leaseId: "l6" }),
      ]);
      mocks.store.ack
        .mockResolvedValueOnce(makeEvent({ id: "evt_1", status: "dispatched" }))
        .mockResolvedValueOnce(makeEvent({ id: "evt_2", status: "dispatched" }));

      const afterCooldown = await dispatchOnce({ monotonicNowMs: () => monotonicMs });
      expect(afterCooldown.dispatched).toBe(2);
      expect(consumer).toHaveBeenCalledTimes(4);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
