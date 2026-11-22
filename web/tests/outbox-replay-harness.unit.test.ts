import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerConsumer, __resetRegistryForTests } from "../src/lib/outbox/registry";
import { runOutboxReplay, type ReplayEventInput } from "../src/lib/outbox/replay-harness";

beforeEach(() => {
  __resetRegistryForTests();
});

describe("outbox/replay-harness — runOutboxReplay", () => {
  it("runs a recorded synthetic event sequence through registered consumers deterministically with no duplicate effects", async () => {
    const observed: string[] = [];
    registerConsumer("commerce_job.completed", async (event) => {
      observed.push(`${event.id}:${event.aggregateId}`);
    });

    const sequence: ReplayEventInput[] = [
      {
        id: "evt_1",
        aggregateType: "commerce_job",
        aggregateId: "job_1",
        eventType: "commerce_job.completed",
        payload: { amountUsdc: "10.00" },
        enqueuedAtMs: 0,
      },
      {
        id: "evt_2",
        aggregateType: "commerce_job",
        aggregateId: "job_2",
        eventType: "commerce_job.completed",
        payload: { amountUsdc: "25.00" },
        enqueuedAtMs: 500,
      },
    ];

    const firstRun = await runOutboxReplay(sequence, { seed: 42 });
    const secondRun = await runOutboxReplay(sequence, { seed: 42 });

    expect(firstRun).toEqual(secondRun);
    expect(firstRun.totalEventsEnqueued).toBe(2);
    expect(firstRun.deduplicatedWrites).toBe(0);
    expect(firstRun.summary).toEqual({
      leased: 2,
      dispatched: 2,
      retried: 0,
      deadLettered: 0,
      reaped: 0,
      pruned: 0,
    });
    expect(firstRun.hasDuplicateEffects).toBe(false);
    expect(firstRun.duplicateEffects).toEqual([]);
    expect(firstRun.exhaustedMaxTicks).toBe(false);
    expect(firstRun.effects).toHaveLength(2);
    expect(observed).toEqual(["evt_1:job_1", "evt_2:job_2", "evt_1:job_1", "evt_2:job_2"]);
  });

  it("reports duplicate effects when a second consumer fails on attempt 1 and retry re-runs the first consumer", async () => {
    const firstConsumer = vi.fn().mockResolvedValue(undefined);
    let secondAttempts = 0;
    const secondConsumer = vi.fn().mockImplementation(async () => {
      secondAttempts += 1;
      if (secondAttempts === 1) {
        throw new Error("transient downstream timeout");
      }
    });

    registerConsumer("commerce_job.completed", firstConsumer);
    registerConsumer("commerce_job.completed", secondConsumer);

    const report = await runOutboxReplay(
      [
        {
          id: "evt_partial",
          aggregateType: "commerce_job",
          aggregateId: "job_99",
          eventType: "commerce_job.completed",
          payload: { jobId: "job_99" },
        },
      ],
      { seed: 7 },
    );

    expect(firstConsumer).toHaveBeenCalledTimes(2);
    expect(secondConsumer).toHaveBeenCalledTimes(2);
    expect(report.summary.dispatched).toBe(1);
    expect(report.summary.retried).toBe(1);
    expect(report.hasDuplicateEffects).toBe(true);
    expect(report.duplicateEffects).toHaveLength(1);
    expect(report.duplicateEffects[0]).toMatchObject({
      effectKey: "commerce_job.completed:commerce_job:job_99:consumer#0",
      count: 2,
      eventIds: ["evt_partial"],
    });
    expect(report.duplicateEffects[0].occurrences.map((o) => o.attempt)).toEqual([1, 2]);
  });

  it("reports duplicate effects when a mid-lease crash causes lease expiry reaping and redelivery", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("commerce_job.completed", consumer);

    const report = await runOutboxReplay(
      [
        {
          id: "evt_crash",
          aggregateType: "commerce_job",
          aggregateId: "job_crash",
          eventType: "commerce_job.completed",
          payload: {},
          simulateLeaseExpiryOnAttempts: [1],
        },
      ],
      { leaseDurationMs: 5_000 },
    );

    expect(consumer).toHaveBeenCalledTimes(2);
    expect(report.summary.reaped).toBe(1);
    expect(report.summary.dispatched).toBe(1);
    expect(report.hasDuplicateEffects).toBe(true);
    expect(report.duplicateEffects).toHaveLength(1);
    expect(report.duplicateEffects[0]).toMatchObject({
      effectKey: "commerce_job.completed:commerce_job:job_crash:consumer#0",
      count: 2,
      eventIds: ["evt_crash"],
    });
  });

  it("collapses duplicate writes with the same (eventType, dedupeKey) and avoids duplicate effects", async () => {
    const consumer = vi.fn().mockResolvedValue(undefined);
    registerConsumer("commerce_job.completed", consumer);

    const report = await runOutboxReplay([
      {
        id: "evt_a",
        aggregateType: "commerce_job",
        aggregateId: "job_dedupe",
        eventType: "commerce_job.completed",
        payload: {},
        dedupeKey: "job_dedupe",
      },
      {
        id: "evt_b",
        aggregateType: "commerce_job",
        aggregateId: "job_dedupe",
        eventType: "commerce_job.completed",
        payload: {},
        dedupeKey: "job_dedupe",
      },
    ]);

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(report.deduplicatedWrites).toBe(1);
    expect(report.events).toHaveLength(1);
    expect(report.hasDuplicateEffects).toBe(false);
    expect(report.duplicateEffects).toEqual([]);
  });

  it("reports duplicate effects across distinct non-deduplicated events targeting the same logical effect", async () => {
    registerConsumer("commerce_job.completed", async () => {});

    const report = await runOutboxReplay([
      {
        id: "evt_1",
        aggregateType: "commerce_job",
        aggregateId: "job_same",
        eventType: "commerce_job.completed",
        payload: {},
      },
      {
        id: "evt_2",
        aggregateType: "commerce_job",
        aggregateId: "job_same",
        eventType: "commerce_job.completed",
        payload: {},
      },
    ]);

    expect(report.hasDuplicateEffects).toBe(true);
    expect(report.duplicateEffects).toHaveLength(1);
    expect(report.duplicateEffects[0]).toMatchObject({
      effectKey: "commerce_job.completed:commerce_job:job_same:consumer#0",
      count: 2,
      eventIds: ["evt_1", "evt_2"],
    });
  });

  it("dead-letters unregistered event types and exhausted retries cleanly", async () => {
    registerConsumer("failing.event", async () => {
      throw new Error("permanent failure");
    });

    const report = await runOutboxReplay([
      {
        id: "evt_unregistered",
        aggregateType: "commerce_job",
        aggregateId: "job_u",
        eventType: "unknown.event",
        payload: {},
      },
      {
        id: "evt_exhausted",
        aggregateType: "commerce_job",
        aggregateId: "job_f",
        eventType: "failing.event",
        payload: {},
        maxAttempts: 2,
      },
    ]);

    expect(report.summary.deadLettered).toBe(2);
    expect(report.summary.retried).toBe(1);
    expect(report.hasDuplicateEffects).toBe(false);
    expect(report.events).toEqual([
      expect.objectContaining({
        id: "evt_unregistered",
        status: "dead_letter",
        attempts: 1,
        lastError: expect.stringContaining('No consumer registered for event type "unknown.event"'),
      }),
      expect.objectContaining({
        id: "evt_exhausted",
        status: "dead_letter",
        attempts: 2,
        lastError: "permanent failure",
      }),
    ]);
  });

  it("handles empty sequences, enforces maxTicks boundary, and rejects invalid options", async () => {
    const empty = await runOutboxReplay([]);
    expect(empty.ticks).toBe(0);
    expect(empty.events).toEqual([]);
    expect(empty.hasDuplicateEffects).toBe(false);
    expect(empty.exhaustedMaxTicks).toBe(false);

    registerConsumer("always.fail", async () => {
      throw new Error("still failing");
    });
    const bounded = await runOutboxReplay(
      [
        {
          id: "evt_bounded",
          aggregateType: "commerce_job",
          aggregateId: "job_b",
          eventType: "always.fail",
          payload: {},
          maxAttempts: 10,
        },
      ],
      { maxTicks: 2 },
    );
    expect(bounded.ticks).toBe(2);
    expect(bounded.exhaustedMaxTicks).toBe(true);

    await expect(runOutboxReplay([], { batchSize: 0 })).rejects.toThrow("batchSize");
    await expect(runOutboxReplay([], { leaseDurationMs: -1 })).rejects.toThrow("leaseDurationMs");
    await expect(runOutboxReplay([], { maxTicks: 0 })).rejects.toThrow("maxTicks");
  });
});
