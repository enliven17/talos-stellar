import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.where = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  const dbUpdate = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    return chain;
  });

  return { dbSelect, dbUpdate, makeSelectChain };
});

vi.mock("@/db", () => ({
  db: { select: mocks.dbSelect, update: mocks.dbUpdate },
}));

vi.mock("@/db/schema", () => ({
  tlsCommerceJobs: {
    id: "id",
    status: "status",
    talosId: "talosId",
    requesterTalosId: "requesterTalosId",
    serviceName: "serviceName",
    leasedBy: "leasedBy",
    leaseExpiresAt: "leaseExpiresAt",
    fencingToken: "fencingToken",
    progress: "progress",
    result: "result",
    updatedAt: "updatedAt",
    createdAt: "createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/auth", () => ({
  resolveTalosFromRequest: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tracing", () => ({
  withTraceContext: (fn: unknown) => fn,
}));

vi.mock("@/lib/schemas", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schemas")>("@/lib/schemas");
  return actual;
});

import { GET, POST } from "@/app/api/jobs/[id]/progress/route";
import { resolveTalosFromRequest } from "@/lib/auth";
import { getSseMetrics, __resetPool } from "@/lib/sse-pool";
import {
  sanitizeProgressInput,
  toPublicJobProgressView,
  jobProgressFingerprint,
} from "@/lib/job-progress";

const resolveAuth = resolveTalosFromRequest as unknown as ReturnType<typeof vi.fn>;

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "pending",
    talosId: "provider-1",
    requesterTalosId: "requester-1",
    serviceName: "echo",
    leasedBy: null,
    leaseExpiresAt: null,
    fencingToken: 1,
    progress: null,
    result: null,
    updatedAt: new Date("2026-09-24T12:00:00.000Z"),
    createdAt: new Date("2026-09-24T11:00:00.000Z"),
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("job-progress helpers", () => {
  it("clamps percent and truncates message", () => {
    expect(sanitizeProgressInput({ percent: 150, message: "x".repeat(400) })).toEqual({
      percent: 100,
      stage: null,
      message: "x".repeat(280),
    });
  });

  it("redacts secret-like progress messages", () => {
    expect(sanitizeProgressInput({ message: "seed=SSECRET" }).message).toBe("[redacted]");
  });

  it("omits payload/payment fields from public view and redacts result secrets", () => {
    const view = toPublicJobProgressView({
      ...jobRow({
        status: "completed",
        result: { answer: 42, apiKey: "tak_secret", nested: { seed: "abc" } },
      }),
    });
    expect(view.result).toEqual({
      answer: 42,
      apiKey: "[redacted]",
      nested: { seed: "[redacted]" },
    });
    expect(view).not.toHaveProperty("paymentSig");
    expect(view).not.toHaveProperty("payload");
  });

  it("changes fingerprint when progress updates", () => {
    const a = toPublicJobProgressView(jobRow());
    const b = toPublicJobProgressView(
      jobRow({
        progress: {
          percent: 40,
          stage: "work",
          message: "halfway",
          updatedAt: "2026-09-24T12:01:00.000Z",
          reportedBy: "provider-1",
        },
      }),
    );
    expect(jobProgressFingerprint(a)).not.toBe(jobProgressFingerprint(b));
  });
});

describe("GET /api/jobs/:id/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPool(200);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 401 when auth fails", async () => {
    resolveAuth.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Missing Authorization header. Use: Bearer <api_key>" }, { status: 401 }),
    });
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress");
    const res = await GET(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when job is missing", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([]));
    const req = new NextRequest("http://localhost/api/jobs/missing/progress", {
      headers: { authorization: "Bearer tak_x" },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is neither provider nor requester", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "stranger" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow()]));
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      headers: { authorization: "Bearer tak_x" },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 503 when SSE pool is saturated", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow()]));
    __resetPool(0);
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      headers: { authorization: "Bearer tak_x" },
      signal: new AbortController().signal,
    });
    const res = await GET(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("streams snapshot for an authorized requester and releases on abort", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "requester-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow()]));
    __resetPool(200);

    const controller = new AbortController();
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      headers: { authorization: "Bearer tak_x" },
      signal: controller.signal,
    });
    const res = await GET(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(getSseMetrics().activeConnections).toBe(1);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain("job-1");
    expect(text).not.toContain("paymentSig");

    controller.abort();
    await flushMicrotasks();
    expect(getSseMetrics().activeConnections).toBe(0);
    reader.releaseLock();
  });

  it("rejects malformed limit", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress?limit=abc", {
      headers: { authorization: "Bearer tak_x" },
    });
    const res = await GET(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs/:id/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when a non-provider reports progress", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "requester-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow()]));
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      method: "POST",
      headers: {
        authorization: "Bearer tak_x",
        "content-type": "application/json",
      },
      body: JSON.stringify({ percent: 10 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 400 when no progress fields are provided", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      method: "POST",
      headers: {
        authorization: "Bearer tak_x",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(400);
  });

  it("persists sanitized progress for the provider", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow()]));
    const returning = vi.fn(() =>
      Promise.resolve([
        {
          id: "job-1",
          status: "pending",
          progress: {
            percent: 25,
            stage: "fetch",
            message: "loading",
            updatedAt: "2026-09-24T12:02:00.000Z",
            reportedBy: "provider-1",
          },
          fencingToken: 1,
          updatedAt: new Date("2026-09-24T12:02:00.000Z"),
        },
      ]),
    );
    mocks.dbUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning,
    });

    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      method: "POST",
      headers: {
        authorization: "Bearer tak_x",
        "content-type": "application/json",
      },
      body: JSON.stringify({ percent: 25, stage: "fetch", message: "loading" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.percent).toBe(25);
    expect(body.progress.stage).toBe("fetch");
  });

  it("returns 409 on fencing token mismatch", async () => {
    resolveAuth.mockResolvedValue({ ok: true, talos: { id: "provider-1" } });
    mocks.dbSelect.mockReturnValue(mocks.makeSelectChain([jobRow({ fencingToken: 3 })]));
    const req = new NextRequest("http://localhost/api/jobs/job-1/progress", {
      method: "POST",
      headers: {
        authorization: "Bearer tak_x",
        "content-type": "application/json",
      },
      body: JSON.stringify({ percent: 10, fencingToken: 1 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "job-1" }) });
    expect(res.status).toBe(409);
  });
});
