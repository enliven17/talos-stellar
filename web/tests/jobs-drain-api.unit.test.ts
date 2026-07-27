import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  runOnce: vi.fn(),
  jobsConfig: { enabled: false },
}));

vi.mock("@/lib/jobs", () => ({
  runOnce: mocks.runOnce,
  jobsConfig: mocks.jobsConfig,
}));
// The route imports the handler registry for its side effect of registering
// handlers; stub it so this test doesn't pull in @/db transitively.
vi.mock("@/lib/jobs/handlers", () => ({}));

import { POST as drainRoute } from "@/app/api/internal/jobs/drain/route";

const SECRET = "test-internal-secret";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/internal/jobs/drain", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_JOBS_SECRET = SECRET;
  mocks.jobsConfig.enabled = false;
});

afterEach(() => {
  delete process.env.INTERNAL_JOBS_SECRET;
});

describe("POST /api/internal/jobs/drain", () => {
  it("returns 500 when INTERNAL_JOBS_SECRET is not configured", async () => {
    delete process.env.INTERNAL_JOBS_SECRET;
    const res = await drainRoute(req({ "x-internal-jobs-secret": SECRET }));
    expect(res.status).toBe(500);
  });

  it("returns 403 with a missing or wrong secret", async () => {
    const missing = await drainRoute(req());
    expect(missing.status).toBe(403);

    const wrong = await drainRoute(req({ "x-internal-jobs-secret": "wrong" }));
    expect(wrong.status).toBe(403);

    expect(mocks.runOnce).not.toHaveBeenCalled();
  });

  it("is a no-op (never calls runOnce) when JOBS_ENABLED is false", async () => {
    mocks.jobsConfig.enabled = false;
    const res = await drainRoute(req({ "x-internal-jobs-secret": SECRET }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false, summary: null });
    expect(mocks.runOnce).not.toHaveBeenCalled();
  });

  it("processes a batch and returns the summary when enabled", async () => {
    mocks.jobsConfig.enabled = true;
    const summary = { leased: 2, completed: 1, retried: 1, deadLettered: 0, cancelled: 0, reaped: 0 };
    mocks.runOnce.mockResolvedValue(summary);

    const res = await drainRoute(req({ "x-internal-jobs-secret": SECRET }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: true, summary });
  });
});
