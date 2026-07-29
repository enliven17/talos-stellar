/**
 * Verifies the JOBS_ENABLED integration point in src/lib/auth.ts: the
 * audit-log write must stay a direct DB insert (today's behavior) unless an
 * operator explicitly flips JOBS_ENABLED, in which case it durably enqueues
 * instead. This is the rollout-safety guarantee from the issue's acceptance
 * criteria ("disabled or backward compatible by default").
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), insert: vi.fn() },
  enqueue: vi.fn(),
  jobsConfig: { enabled: false },
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("@/lib/jobs", () => ({
  enqueue: mocks.enqueue,
  jobsConfig: mocks.jobsConfig,
}));
vi.mock("@/lib/jobs/handlers/audit-log", () => ({ AUDIT_LOG_WRITE_QUEUE: "audit_log_write" }));

import { verifyAgentApiKey } from "@/lib/auth";

const mockSelectChain = (result: unknown[]) => ({
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(result)),
});

function authedRequest(key: string) {
  return new NextRequest("http://localhost:3000/api/talos/talos_1/wallet", {
    headers: { authorization: `Bearer ${key}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockDb.select.mockReturnValue(mockSelectChain([{ id: "talos_1", apiKey: "correct-key" }]));
  mocks.mockDb.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
});

describe("auth.ts audit log — JOBS_ENABLED=false (default)", () => {
  it("writes the audit log via a direct DB insert, not the job queue", async () => {
    mocks.jobsConfig.enabled = false;

    const result = await verifyAgentApiKey(authedRequest("correct-key"), "talos_1");
    expect(result.ok).toBe(true);

    // writeAuditLog is fire-and-forget inside verifyAgentApiKey — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("auth.ts audit log — JOBS_ENABLED=true", () => {
  it("enqueues a durable job instead of inserting directly", async () => {
    mocks.jobsConfig.enabled = true;
    mocks.enqueue.mockResolvedValue({ id: "job_1" });

    const result = await verifyAgentApiKey(authedRequest("correct-key"), "talos_1");
    expect(result.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [queue, payload] = mocks.enqueue.mock.calls[0];
    expect(queue).toBe("audit_log_write");
    expect(payload).toMatchObject({ talosId: "talos_1", statusCode: 200 });
    expect(mocks.mockDb.insert).not.toHaveBeenCalled();
  });
});
