import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));
const { mockDb } = mocks;

vi.mock("@/db", () => ({ db: mocks.mockDb }));

import * as store from "../src/lib/jobs/store";
import { POST as bulkRetryRoute } from "@/app/api/admin/jobs/bulk-retry/route";

function chainable<T>(result: T) {
  const obj: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "set", "values"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.returning = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job_1",
    queue: "audit_log_write",
    payload: {},
    status: "dead_letter",
    priority: 0,
    runAt: new Date("2026-01-01T00:00:00.000Z"),
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attempts: 8,
    maxAttempts: 8,
    retryClass: "transient",
    cancelRequested: false,
    idempotencyKey: null,
    lastError: "timeout",
    result: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T01:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

const ADMIN_KEY = "test-admin-key";

function authedPost(body: unknown) {
  return new NextRequest("http://localhost:3000/api/admin/jobs/bulk-retry", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("jobs/store — previewBulkRetry", () => {
  it("filters and counts eligible vs ineligible jobs with explicit reasons without mutating", async () => {
    const rows = [
      makeJob({ id: "job_ok", status: "dead_letter", retryClass: "transient", queue: "q1" }),
      makeJob({ id: "job_completed", status: "completed", retryClass: "transient", queue: "q1" }),
      makeJob({ id: "job_cancelled", status: "cancelled", retryClass: "transient", queue: "q1" }),
      makeJob({ id: "job_fatal", status: "dead_letter", retryClass: "fatal", queue: "q1" }),
      makeJob({ id: "job_wrong_queue", status: "dead_letter", retryClass: "transient", queue: "q2" }),
    ];
    mockDb.select.mockReturnValue(chainable(rows));

    const preview = await store.previewBulkRetry({
      jobIds: ["job_ok", "job_completed", "job_cancelled", "job_fatal", "job_wrong_queue", "job_missing"],
      queue: "q1",
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.totalEvaluated).toBe(6);
    expect(preview.eligibleCount).toBe(1);
    expect(preview.ineligibleCount).toBe(5);
    expect(preview.countsByReason).toEqual({
      eligible: 1,
      status_not_failed: 1,
      cancelled_excluded: 1,
      fatal_retry_class: 1,
      queue_mismatch: 1,
      not_found: 1,
    });
    expect(preview.eligible).toEqual([
      expect.objectContaining({
        id: "job_ok",
        revision: "2026-01-01T01:00:00.000Z",
        reason: "eligible",
      }),
    ]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("includes cancelled and fatal jobs when explicitly opted in", async () => {
    const rows = [
      makeJob({ id: "job_cancelled", status: "cancelled", retryClass: "transient" }),
      makeJob({ id: "job_fatal", status: "dead_letter", retryClass: "fatal" }),
    ];
    mockDb.select.mockReturnValue(chainable(rows));

    const preview = await store.previewBulkRetry({
      includeCancelled: true,
      allowFatal: true,
    });

    expect(preview.eligibleCount).toBe(2);
    expect(preview.ineligibleCount).toBe(0);
    expect(preview.countsByReason).toEqual({ eligible: 2 });
  });
});

describe("jobs/store — executeBulkRetry", () => {
  it("requeues jobs whose revision is unchanged and skips stale revisions", async () => {
    const requeuedRow = makeJob({
      id: "job_fresh",
      status: "pending",
      attempts: 0,
      lastError: null,
      updatedAt: new Date("2026-01-01T02:00:00.000Z"),
    });
    const staleCurrentRow = makeJob({
      id: "job_stale",
      status: "dead_letter",
      updatedAt: new Date("2026-01-01T01:30:00.000Z"),
    });

    mockDb.update
      .mockReturnValueOnce(chainable([requeuedRow]))
      .mockReturnValueOnce(chainable([]));
    mockDb.select.mockReturnValueOnce(chainable([staleCurrentRow]));

    const result = await store.executeBulkRetry([
      { id: "job_fresh", revision: "2026-01-01T01:00:00.000Z" },
      { id: "job_stale", revision: "2026-01-01T01:00:00.000Z" },
    ]);

    expect(result.dryRun).toBe(false);
    expect(result.requestedCount).toBe(2);
    expect(result.requeuedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.requeued[0].id).toBe("job_fresh");
    expect(result.skipped).toEqual([
      {
        id: "job_stale",
        expectedRevision: "2026-01-01T01:00:00.000Z",
        currentRevision: "2026-01-01T01:30:00.000Z",
        reason: "revision_mismatch",
      },
    ]);
  });

  it("reports invalid_revision and not_found without throwing", async () => {
    mockDb.update.mockReturnValueOnce(chainable([]));
    mockDb.select.mockReturnValueOnce(chainable([]));

    const result = await store.executeBulkRetry([
      { id: "job_bad_rev", revision: "not-a-timestamp" },
      { id: "job_missing", revision: "2026-01-01T01:00:00.000Z" },
    ]);

    expect(result.requeuedCount).toBe(0);
    expect(result.skipped).toEqual([
      {
        id: "job_bad_rev",
        expectedRevision: "not-a-timestamp",
        currentRevision: null,
        reason: "invalid_revision",
      },
      {
        id: "job_missing",
        expectedRevision: "2026-01-01T01:00:00.000Z",
        currentRevision: null,
        reason: "not_found",
      },
    ]);
  });
});

describe("POST /api/admin/jobs/bulk-retry", () => {
  it("defaults to dryRun preview and returns 200", async () => {
    mockDb.select.mockReturnValue(chainable([makeJob({ id: "job_1" })]));

    const res = await bulkRetryRoute(authedPost({ queue: "audit_log_write" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.eligibleCount).toBe(1);
    expect(body.eligible[0].revision).toBe("2026-01-01T01:00:00.000Z");
  });

  it("returns 400 when dryRun is false and selections are missing", async () => {
    const res = await bulkRetryRoute(authedPost({ dryRun: false }));
    expect(res.status).toBe(400);
  });

  it("returns 409 when all selected jobs fail due to revision_mismatch", async () => {
    mockDb.update.mockReturnValueOnce(chainable([]));
    mockDb.select.mockReturnValueOnce(
      chainable([makeJob({ id: "job_1", updatedAt: new Date("2026-01-01T02:00:00.000Z") })]),
    );

    const res = await bulkRetryRoute(
      authedPost({
        dryRun: false,
        selections: [{ id: "job_1", revision: "2026-01-01T01:00:00.000Z" }],
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.requeuedCount).toBe(0);
    expect(body.skipped[0].reason).toBe("revision_mismatch");
  });
});
