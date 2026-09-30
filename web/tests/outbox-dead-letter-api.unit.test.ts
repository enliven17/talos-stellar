import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { OutboxEvent } from "@/lib/outbox";

// Data access is mocked; the pure dead-letter helpers run for real.
const mocks = vi.hoisted(() => ({
  outbox: {
    listEvents: vi.fn(),
    summarizeDeadLetters: vi.fn(),
    getEvent: vi.fn(),
    requeue: vi.fn(),
  },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/outbox", () => mocks.outbox);
vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import { GET as deadLetterRoute } from "@/app/api/admin/outbox/dead-letter/route";
import { GET as listRoute } from "@/app/api/admin/outbox/route";
import { POST as retryRoute } from "@/app/api/admin/outbox/[id]/retry/route";

const ADMIN_KEY = "test-admin-key";
const PATH = "/api/admin/outbox/dead-letter";

function req(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`http://localhost:3000${path}`, { method, headers });
}
const authed = (path: string, method = "GET") => req(path, { authorization: `Bearer ${ADMIN_KEY}` }, method);

function deadEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "evt_1",
    aggregateType: "commerce_job",
    aggregateId: "job_1",
    eventType: "commerce_job.completed",
    payload: { paymentProof: "PROOF-DO-NOT-LEAK" },
    status: "dead_letter",
    runAt: new Date("2026-09-01T00:00:00.000Z"),
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 8,
    maxAttempts: 8,
    dedupeKey: "dedupe-DO-NOT-LEAK",
    lastError: "consumer failed: Bearer tak_live_secret123",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:05:00.000Z"),
    dispatchedAt: null,
    ...overrides,
  };
}

const EMPTY_SUMMARY = { total: 0, byEventType: [] };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  mocks.outbox.summarizeDeadLetters.mockResolvedValue(EMPTY_SUMMARY);
});
afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("GET /api/admin/outbox/dead-letter — auth", () => {
  it("returns 500 when ADMIN_API_KEY is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    expect((await deadLetterRoute(req(PATH))).status).toBe(500);
    expect(mocks.outbox.listEvents).not.toHaveBeenCalled();
  });

  it("returns 401 without Authorization and 403 with a wrong key", async () => {
    expect((await deadLetterRoute(req(PATH))).status).toBe(401);
    expect((await deadLetterRoute(req(PATH, { authorization: "Bearer wrong" }))).status).toBe(403);
    expect(mocks.outbox.listEvents).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/outbox/dead-letter — listing", () => {
  it("lists only dead_letter events with defaults and a summary (positive)", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [deadEvent()], nextCursor: null });
    mocks.outbox.summarizeDeadLetters.mockResolvedValue({
      total: 3,
      byEventType: [{ eventType: "commerce_job.completed", count: 3 }],
    });

    const res = await deadLetterRoute(authed(PATH));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.outbox.listEvents).toHaveBeenCalledWith({
      status: "dead_letter",
      eventType: undefined,
      cursor: undefined,
      limit: 25,
    });

    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.summary).toEqual({ total: 3, byEventType: [{ eventType: "commerce_job.completed", count: 3 }] });
    expect(body.deadLetters).toEqual([
      {
        id: "evt_1",
        eventType: "commerce_job.completed",
        aggregateType: "commerce_job",
        aggregateId: "job_1",
        attempts: 8,
        maxAttempts: 8,
        lastError: "consumer failed: [redacted]",
        createdAt: "2026-09-01T00:00:00.000Z",
        deadLetteredAt: "2026-09-01T00:05:00.000Z",
      },
    ]);
  });

  it("never returns payload, dedupeKey or secrets from lastError (privacy)", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [deadEvent()], nextCursor: null });
    const text = await (await deadLetterRoute(authed(PATH))).text();
    expect(text).not.toContain("PROOF-DO-NOT-LEAK");
    expect(text).not.toContain("dedupe-DO-NOT-LEAK");
    expect(text).not.toContain("tak_live_secret123");
  });

  it("passes eventType, cursor and limit through and returns nextCursor", async () => {
    const cursor = "2026-09-01T00:00:00.000Z";
    mocks.outbox.listEvents.mockResolvedValue({ events: [deadEvent()], nextCursor: "2026-08-31T00:00:00.000Z" });

    const res = await deadLetterRoute(authed(`${PATH}?eventType=commerce_job.completed&cursor=${cursor}&limit=100`));
    expect(res.status).toBe(200);
    expect(mocks.outbox.listEvents).toHaveBeenCalledWith({
      status: "dead_letter",
      eventType: "commerce_job.completed",
      cursor,
      limit: 100,
    });
    expect((await res.json()).nextCursor).toBe("2026-08-31T00:00:00.000Z");
  });

  it("returns an empty page when nothing is dead-lettered (boundary)", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [], nextCursor: null });
    const body = await (await deadLetterRoute(authed(PATH))).json();
    expect(body).toEqual({ deadLetters: [], nextCursor: null, summary: EMPTY_SUMMARY });
  });

  it.each([
    ["limit=0", /limit/],
    ["limit=101", /limit/],
    ["limit=ten", /limit/],
    ["cursor=yesterday", /cursor/],
    [`eventType=${"x".repeat(200)}`, /eventType/],
    ["eventType=a%20b", /eventType/],
  ])("rejects %s with 400 before touching the store (negative)", async (qs, message) => {
    const res = await deadLetterRoute(authed(`${PATH}?${qs}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(mocks.outbox.listEvents).not.toHaveBeenCalled();
    expect(mocks.outbox.summarizeDeadLetters).not.toHaveBeenCalled();
  });

  it("returns 503 with a generic message when the store fails (dependency failure)", async () => {
    mocks.outbox.listEvents.mockRejectedValue(
      new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432 — param "tak_leaked"'),
    );
    const res = await deadLetterRoute(authed(PATH));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Failed to load dead-letter events" });
    expect(text).not.toContain("hunter2");
    // Logged as a bounded string, not the raw error object.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      { err: expect.any(String) },
      "admin_outbox_dead_letter_error",
    );
  });

  it("returns 503 when only the summary query fails", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [], nextCursor: null });
    mocks.outbox.summarizeDeadLetters.mockRejectedValue(new Error("timeout"));
    expect((await deadLetterRoute(authed(PATH))).status).toBe(503);
  });
});

describe("dead-letter view ↔ existing admin routes (regression)", () => {
  it("an id from the dead-letter view can be requeued via POST /:id/retry", async () => {
    mocks.outbox.listEvents.mockResolvedValueOnce({ events: [deadEvent({ id: "evt_dead" })], nextCursor: null });
    const listed = await (await deadLetterRoute(authed(PATH))).json();
    const id = listed.deadLetters[0].id;

    mocks.outbox.requeue.mockResolvedValue(deadEvent({ id, status: "pending", attempts: 0, lastError: null }));
    const retried = await retryRoute(authed(`/api/admin/outbox/${id}/retry`, "POST"), {
      params: Promise.resolve({ id }),
    });
    expect(retried.status).toBe(200);
    expect(mocks.outbox.requeue).toHaveBeenCalledWith("evt_dead");

    // After a requeue the event is no longer dead_letter, so the view drops it.
    mocks.outbox.listEvents.mockResolvedValueOnce({ events: [], nextCursor: null });
    const after = await (await deadLetterRoute(authed(PATH))).json();
    expect(after.deadLetters).toEqual([]);
  });

  it("retrying an event that is no longer dead-lettered still returns 409", async () => {
    mocks.outbox.requeue.mockResolvedValue(null);
    mocks.outbox.getEvent.mockResolvedValue(deadEvent({ status: "pending" }));
    const res = await retryRoute(authed("/api/admin/outbox/evt_1/retry", "POST"), {
      params: Promise.resolve({ id: "evt_1" }),
    });
    expect(res.status).toBe(409);
  });

  it("leaves GET /api/admin/outbox?status=dead_letter unchanged (full records)", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [deadEvent()], nextCursor: null });
    const res = await listRoute(authed("/api/admin/outbox?status=dead_letter"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events[0].payload).toEqual({ paymentProof: "PROOF-DO-NOT-LEAK" });
    expect(mocks.outbox.summarizeDeadLetters).not.toHaveBeenCalled();
  });
});
