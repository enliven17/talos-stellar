import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  jobs: {
    listJobs: vi.fn(),
    getJob: vi.fn(),
    requeue: vi.fn(),
    requestCancel: vi.fn(),
  },
}));

vi.mock("@/lib/jobs", () => mocks.jobs);

import { GET as listRoute } from "@/app/api/admin/jobs/route";
import { GET as getRoute } from "@/app/api/admin/jobs/[id]/route";
import { POST as retryRoute } from "@/app/api/admin/jobs/[id]/retry/route";
import { POST as cancelRoute } from "@/app/api/admin/jobs/[id]/cancel/route";

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
    const res = await listRoute(req("/api/admin/jobs"));
    expect(res.status).toBe(500);
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await listRoute(req("/api/admin/jobs"));
    expect(res.status).toBe(401);
  });

  it("returns 403 with a wrong key", async () => {
    const res = await listRoute(req("/api/admin/jobs", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/jobs", () => {
  it("lists jobs and passes filters through", async () => {
    mocks.jobs.listJobs.mockResolvedValue({ jobs: [{ id: "job_1" }], nextCursor: null });

    const res = await listRoute(authed("/api/admin/jobs?status=dead_letter&queue=audit_log_write&limit=10"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(mocks.jobs.listJobs).toHaveBeenCalledWith({
      status: "dead_letter",
      queue: "audit_log_write",
      cursor: undefined,
      limit: 10,
    });
  });

  it("rejects an invalid status filter", async () => {
    const res = await listRoute(authed("/api/admin/jobs?status=bogus"));
    expect(res.status).toBe(400);
    expect(mocks.jobs.listJobs).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/jobs/:id", () => {
  it("returns the job", async () => {
    mocks.jobs.getJob.mockResolvedValue({ id: "job_1", status: "completed" });
    const res = await getRoute(authed("/api/admin/jobs/job_1"), { params: Promise.resolve({ id: "job_1" }) });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a missing job", async () => {
    mocks.jobs.getJob.mockResolvedValue(null);
    const res = await getRoute(authed("/api/admin/jobs/missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/jobs/:id/retry", () => {
  it("requeues a dead_letter job", async () => {
    mocks.jobs.requeue.mockResolvedValue({ id: "job_1", status: "pending" });
    const res = await retryRoute(authed("/api/admin/jobs/job_1/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "job_1" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 409 when the job exists but isn't retryable", async () => {
    mocks.jobs.requeue.mockResolvedValue(null);
    mocks.jobs.getJob.mockResolvedValue({ id: "job_1", status: "completed" });
    const res = await retryRoute(authed("/api/admin/jobs/job_1/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "job_1" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 when the job doesn't exist", async () => {
    mocks.jobs.requeue.mockResolvedValue(null);
    mocks.jobs.getJob.mockResolvedValue(null);
    const res = await retryRoute(authed("/api/admin/jobs/missing/retry", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/jobs/:id/cancel", () => {
  it("cancels a pending/leased job", async () => {
    mocks.jobs.requestCancel.mockResolvedValue({ id: "job_1", status: "cancelled" });
    const res = await cancelRoute(authed("/api/admin/jobs/job_1/cancel", { method: "POST" }), {
      params: Promise.resolve({ id: "job_1" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 409 for a job already in a terminal state", async () => {
    mocks.jobs.requestCancel.mockResolvedValue(null);
    mocks.jobs.getJob.mockResolvedValue({ id: "job_1", status: "completed" });
    const res = await cancelRoute(authed("/api/admin/jobs/job_1/cancel", { method: "POST" }), {
      params: Promise.resolve({ id: "job_1" }),
    });
    expect(res.status).toBe(409);
  });
});
