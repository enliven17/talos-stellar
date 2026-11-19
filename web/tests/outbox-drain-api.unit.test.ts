import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  dispatchOnce: vi.fn(),
  outboxConfig: { enabled: false },
}));
vi.mock("@/lib/outbox", () => ({ dispatchOnce: mocks.dispatchOnce, outboxConfig: mocks.outboxConfig }));
vi.mock("@/lib/outbox/consumers", () => ({}));

import { POST as drainRoute } from "@/app/api/internal/outbox/drain/route";

const SECRET = "test-dispatch-secret";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/internal/outbox/drain", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OUTBOX_DISPATCH_SECRET = SECRET;
  mocks.outboxConfig.enabled = false;
});
afterEach(() => {
  delete process.env.OUTBOX_DISPATCH_SECRET;
});

describe("POST /api/internal/outbox/drain", () => {
  it("returns 500 when OUTBOX_DISPATCH_SECRET is not configured", async () => {
    delete process.env.OUTBOX_DISPATCH_SECRET;
    const res = await drainRoute(req({ "x-outbox-dispatch-secret": SECRET }));
    expect(res.status).toBe(500);
  });

  it("returns 403 with a missing or wrong secret", async () => {
    expect((await drainRoute(req())).status).toBe(403);
    expect((await drainRoute(req({ "x-outbox-dispatch-secret": "wrong" }))).status).toBe(403);
    expect(mocks.dispatchOnce).not.toHaveBeenCalled();
  });

  it("is a no-op when OUTBOX_ENABLED is false", async () => {
    const res = await drainRoute(req({ "x-outbox-dispatch-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, summary: null });
    expect(mocks.dispatchOnce).not.toHaveBeenCalled();
  });

  it("dispatches and returns the summary when enabled", async () => {
    mocks.outboxConfig.enabled = true;
    const summary = { leased: 2, dispatched: 1, retried: 1, deadLettered: 0, reaped: 0, pruned: 0 };
    mocks.dispatchOnce.mockResolvedValue(summary);

    const res = await drainRoute(req({ "x-outbox-dispatch-secret": SECRET }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, summary });
  });
});
