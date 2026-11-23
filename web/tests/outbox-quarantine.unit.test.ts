import { vi, describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  store: {
    reapExpiredLeases: vi.fn(),
    pruneDispatched: vi.fn(),
    leaseBatch: vi.fn(),
    ack: vi.fn(),
    fail: vi.fn(),
    quarantine: vi.fn(),
  },
}));
vi.mock("../src/lib/outbox/store", () => mocks.store);

import { dispatchOnce } from "../src/lib/outbox/dispatcher";
import { registerConsumer, __resetRegistryForTests } from "../src/lib/outbox/registry";
import {
  registerPayloadSchema,
  validatePayload,
  __resetPayloadSchemasForTests,
  MAX_VALIDATION_ISSUES,
} from "../src/lib/outbox/payload-schema";
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

const schema = z.object({ jobId: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/) });

beforeEach(() => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  __resetPayloadSchemasForTests();
  mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 0, deadLettered: 0 });
  mocks.store.pruneDispatched.mockResolvedValue(0);
});

describe("outbox/payload-schema — validatePayload", () => {
  it("passes through (schemaVersion null) when no schema is declared", () => {
    expect(validatePayload("undeclared", { anything: true })).toEqual({ ok: true, schemaVersion: null });
  });

  it("returns the declared version for a valid payload", () => {
    registerPayloadSchema("test.event", { version: 2, schema });
    expect(validatePayload("test.event", { jobId: "j", amount: "1.5" })).toEqual({ ok: true, schemaVersion: 2 });
  });

  it("summarises issues without leaking payload values", () => {
    registerPayloadSchema("test.event", { version: 1, schema });
    const secret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
    const result = validatePayload("test.event", { jobId: 42, amount: secret });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary.schemaVersion).toBe(1);
    expect(result.summary.issueCount).toBe(2);
    expect(result.summary.truncated).toBe(false);
    expect(result.summary.issues.map((i) => i.path).sort()).toEqual(["amount", "jobId"]);
    expect(JSON.stringify(result.summary)).not.toContain(secret);
  });

  it("bounds the summary at MAX_VALIDATION_ISSUES and clips long paths/messages (boundary)", () => {
    const longField = "f".repeat(250);
    const longMsg = "m".repeat(250);
    const shape: Record<string, z.ZodType> = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`f${i}`, z.string({ error: longMsg })]),
    );
    shape[longField] = z.string({ error: longMsg });
    registerPayloadSchema("wide.event", { version: 1, schema: z.object(shape) });
    const result = validatePayload("wide.event", {});
    if (result.ok) throw new Error("expected failure");
    expect(result.summary.issueCount).toBe(26);
    expect(result.summary.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(result.summary.truncated).toBe(true);
    for (const issue of result.summary.issues) {
      expect(issue.path.length).toBeLessThanOrEqual(201);
      expect(issue.message.length).toBeLessThanOrEqual(201);
    }
  });

  it("rejects a non-positive-integer schema version", () => {
    expect(() => registerPayloadSchema("x", { version: 0, schema })).toThrow();
    expect(() => registerPayloadSchema("x", { version: -1, schema })).toThrow();
    expect(() => registerPayloadSchema("x", { version: 1.5, schema })).toThrow();
  });
});

describe("outbox/dispatcher — payload quarantine", () => {
  it("quarantines an invalid payload without running consumers or scheduling retries", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", consumer);
    registerPayloadSchema("test.event", { version: 3, schema });
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ payload: { jobId: 1 } })]);
    mocks.store.quarantine.mockResolvedValue(makeEvent({ status: "quarantined" }));

    const summary = await dispatchOnce();

    expect(consumer).not.toHaveBeenCalled();
    expect(mocks.store.fail).not.toHaveBeenCalled();
    expect(mocks.store.ack).not.toHaveBeenCalled();
    expect(mocks.store.quarantine).toHaveBeenCalledWith(
      "evt_1",
      "lease_1",
      expect.objectContaining({ schemaVersion: 3, issueCount: 2, truncated: false }),
    );
    expect(summary).toMatchObject({ quarantined: 1, retried: 0, deadLettered: 0, dispatched: 0 });
  });

  it("does not count a quarantine when the lease was lost", async () => {
    registerConsumer("test.event", vi.fn());
    registerPayloadSchema("test.event", { version: 1, schema });
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ payload: null })]);
    mocks.store.quarantine.mockResolvedValue(null);

    const summary = await dispatchOnce();
    expect(summary.quarantined).toBe(0);
  });

  it("dispatches a valid payload and records the schema version on ack", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("test.event", consumer);
    registerPayloadSchema("test.event", { version: 3, schema });
    mocks.store.leaseBatch.mockResolvedValue([makeEvent({ payload: { jobId: "j", amount: "10" } })]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));

    const summary = await dispatchOnce();

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(mocks.store.ack).toHaveBeenCalledWith("evt_1", "lease_1", 3);
    expect(mocks.store.quarantine).not.toHaveBeenCalled();
    expect(summary.dispatched).toBe(1);
  });

  it("only quarantines the invalid event in a mixed batch", async () => {
    registerConsumer("test.event", vi.fn().mockResolvedValue(undefined));
    registerPayloadSchema("test.event", { version: 1, schema });
    mocks.store.leaseBatch.mockResolvedValue([
      makeEvent({ id: "good", leaseId: "l1", payload: { jobId: "j", amount: "1" } }),
      makeEvent({ id: "bad", leaseId: "l2", payload: { amount: "nope" } }),
    ]);
    mocks.store.ack.mockResolvedValue(makeEvent({ status: "dispatched" }));
    mocks.store.quarantine.mockResolvedValue(makeEvent({ status: "quarantined" }));

    const summary = await dispatchOnce();

    expect(summary).toMatchObject({ leased: 2, dispatched: 1, quarantined: 1 });
    expect(mocks.store.quarantine).toHaveBeenCalledWith("bad", "l2", expect.any(Object));
  });
});
