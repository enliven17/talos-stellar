import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {
    reapExpiredLeases: vi.fn(),
    pruneDispatched: vi.fn(),
    leaseBatch: vi.fn(),
    ack: vi.fn(),
    fail: vi.fn(),
  },
}));
vi.mock("../src/lib/outbox/store", () => mocks.store);

import { dispatchOnce } from "../src/lib/outbox/dispatcher";
import { registerConsumer, __resetRegistryForTests } from "../src/lib/outbox/registry";
import type { OutboxEvent } from "../src/lib/outbox/types";

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

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 0, deadLettered: 0 });
  mocks.store.pruneDispatched.mockResolvedValue(0);
});

describe("outbox/dispatcher — dispatchOnce", () => {
  it("reaps and prunes, and returns an empty summary when nothing is leased", async () => {
    mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 1, deadLettered: 1 });
    mocks.store.pruneDispatched.mockResolvedValue(3);
    mocks.store.leaseBatch.mockResolvedValue([]);

    const summary = await dispatchOnce();

    expect(summary).toEqual({ leased: 0, dispatched: 0, retried: 0, deadLettered: 0, reaped: 2, pruned: 3 });
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
    registerConsumer("test.event", vi.fn().mockRejectedValue(new Error("downstream 500")));
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.fail.mockResolvedValue(makeEvent({ status: "pending" }));

    const summary = await dispatchOnce();

    expect(summary.retried).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect(mocks.store.ack).not.toHaveBeenCalled();
  });

  it("counts a dead-lettered event when fail() exhausts retries", async () => {
    registerConsumer("test.event", vi.fn().mockRejectedValue(new Error("fatal")));
    mocks.store.leaseBatch.mockResolvedValue([makeEvent()]);
    mocks.store.fail.mockResolvedValue(makeEvent({ status: "dead_letter" }));

    const summary = await dispatchOnce();

    expect(summary.deadLettered).toBe(1);
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
});
