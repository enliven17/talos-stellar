import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  outbox: { listEvents: vi.fn(), getEvent: vi.fn(), requeue: vi.fn() },
}));
vi.mock("@/lib/outbox", () => mocks.outbox);

import { GET as listRoute } from "@/app/api/admin/outbox/route";
import { GET as getRoute } from "@/app/api/admin/outbox/[id]/route";
import { POST as retryRoute } from "@/app/api/admin/outbox/[id]/retry/route";

const ADMIN_KEY = "test-admin-key";

interface Init {
  method?: string;
  headers?: Record<string, string>;
}
function req(path: string, init?: Init) {
  return new NextRequest(`http://localhost:3000${path}`, init);
}
function authed(path: string, init: Init = {}) {
  return req(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${ADMIN_KEY}` } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});
afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("admin auth", () => {
  it("returns 500 when ADMIN_API_KEY is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    expect((await listRoute(req("/api/admin/outbox"))).status).toBe(500);
  });

  it("returns 401 with no Authorization header", async () => {
    expect((await listRoute(req("/api/admin/outbox"))).status).toBe(401);
  });

  it("returns 403 with a wrong key", async () => {
    const res = await listRoute(req("/api/admin/outbox", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/outbox", () => {
  it("lists events and passes filters through", async () => {
    mocks.outbox.listEvents.mockResolvedValue({ events: [{ id: "evt_1" }], nextCursor: null });
    const res = await listRoute(authed("/api/admin/outbox?status=dead_letter&eventType=commerce_job.completed&limit=10"));
    expect(res.status).toBe(200);
    expect(mocks.outbox.listEvents).toHaveBeenCalledWith({
      status: "dead_letter",
      eventType: "commerce_job.completed",
      cursor: undefined,
      limit: 10,
    });
  });

  it("rejects an invalid status filter", async () => {
    const res = await listRoute(authed("/api/admin/outbox?status=bogus"));
    expect(res.status).toBe(400);
    expect(mocks.outbox.listEvents).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/outbox/:id", () => {
  it("returns the event", async () => {
    mocks.outbox.getEvent.mockResolvedValue({ id: "evt_1", status: "dispatched" });
    const res = await getRoute(authed("/api/admin/outbox/evt_1"), { params: Promise.resolve({ id: "evt_1" }) });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a missing event", async () => {
    mocks.outbox.getEvent.mockResolvedValue(null);
    const res = await getRoute(authed("/api/admin/outbox/missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/outbox/:id/retry", () => {
  it("requeues a dead_letter event", async () => {
    mocks.outbox.requeue.mockResolvedValue({ id: "evt_1", status: "pending" });
    const res = await retryRoute(authed("/api/admin/outbox/evt_1/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "evt_1" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 409 when the event exists but isn't retryable", async () => {
    mocks.outbox.requeue.mockResolvedValue(null);
    mocks.outbox.getEvent.mockResolvedValue({ id: "evt_1", status: "dispatched" });
    const res = await retryRoute(authed("/api/admin/outbox/evt_1/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "evt_1" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the event doesn't exist", async () => {
    mocks.outbox.requeue.mockResolvedValue(null);
    mocks.outbox.getEvent.mockResolvedValue(null);
    const res = await retryRoute(authed("/api/admin/outbox/missing/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});
