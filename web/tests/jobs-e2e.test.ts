/**
 * End-to-end test of the background-job framework against a real running
 * server + Postgres (see tests/api-e2e.test.ts for the same pattern). This
 * proves the actual module boundary: real leasing (SELECT ... FOR UPDATE
 * SKIP LOCKED), a real handler run, real admin auth.
 *
 * Requires JOBS_ENABLED=true, ADMIN_API_KEY, and INTERNAL_JOBS_SECRET to be
 * set for the server under test (see .github/workflows/deploy.yml). When
 * they aren't configured — e.g. a contributor running `pnpm test:e2e`
 * locally without opting into the flag — the round-trip case skips instead
 * of failing, since "not configured" is itself a valid, intentionally
 * backward-compatible default.
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const INTERNAL_SECRET = process.env.INTERNAL_JOBS_SECRET;

function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function adminApi(path: string, init: RequestInit = {}) {
  return api(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${ADMIN_KEY}` } });
}

async function createTalos() {
  const keypair = Keypair.random();
  const name = `Jobs E2E Agent ${Date.now()}`;
  const totalSupply = 500_000;
  const message = `talos-genesis:${name}:null:${totalSupply}`;
  const signature = keypair.sign(Buffer.from(message, "utf-8")).toString("base64");

  const res = await api("/api/talos", {
    method: "POST",
    body: JSON.stringify({
      name,
      category: "Development",
      description: "Created by jobs e2e test suite",
      totalSupply,
      creatorPublicKey: keypair.publicKey(),
      signature,
      message,
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return { id: body.id as string, apiKey: body.apiKeyOnce as string };
}

async function pollFor<T>(fn: () => Promise<T | null>, timeoutMs = 10_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pollFor: timed out");
}

describe("Background jobs — admin & drain auth", () => {
  it("rejects admin list without a bearer token", async () => {
    const res = await api("/api/admin/jobs");
    expect([401, 500]).toContain(res.status); // 500 if ADMIN_API_KEY isn't configured in this env
  });

  it("rejects admin list with a wrong bearer token", async () => {
    const res = await api("/api/admin/jobs", { headers: { authorization: "Bearer definitely-wrong" } });
    expect([403, 500]).toContain(res.status);
  });

  it("rejects the internal drain trigger without the shared secret", async () => {
    const res = await api("/api/internal/jobs/drain", { method: "POST" });
    expect([403, 500]).toContain(res.status);
  });
});

describe.skipIf(!ADMIN_KEY || !INTERNAL_SECRET)("Background jobs — enqueue → lease → complete round trip", () => {
  it("durably processes an audit-log job end to end via the drain endpoint", async () => {
    const talos = await createTalos();

    // Any authenticated agent request enqueues an audit-log job (see
    // src/lib/auth.ts). It's fire-and-forget, so poll admin list rather
    // than assume it lands before this request resolves.
    await api(`/api/talos/${talos.id}/wallet`, { headers: { authorization: `Bearer ${talos.apiKey}` } });

    const job = await pollFor(async () => {
      const res = await adminApi("/api/admin/jobs?queue=audit_log_write&limit=200");
      expect(res.status).toBe(200);
      const body = await res.json();
      return (body.jobs as Array<{ id: string; payload: { talosId: string } }>).find(
        (j) => j.payload?.talosId === talos.id,
      ) ?? null;
    });

    // Drain may need more than one pass if another test's jobs are ahead of
    // it in the batch; polling makes this deterministic either way.
    await pollFor(async () => {
      const drainRes = await api("/api/internal/jobs/drain", {
        method: "POST",
        headers: { "x-internal-jobs-secret": INTERNAL_SECRET! },
      });
      expect(drainRes.status).toBe(200);

      const getRes = await adminApi(`/api/admin/jobs/${job.id}`);
      expect(getRes.status).toBe(200);
      const current = await getRes.json();
      return current.status === "completed" ? current : null;
    });

    const finalRes = await adminApi(`/api/admin/jobs/${job.id}`);
    const final = await finalRes.json();
    expect(final.status).toBe("completed");
    expect(final.result).toEqual({ inserted: true });

    // A completed job is terminal: cancel/retry must both refuse it.
    const cancelRes = await adminApi(`/api/admin/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(409);

    const retryRes = await adminApi(`/api/admin/jobs/${job.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(409);
  });

  it("returns 404 for a nonexistent job id", async () => {
    const res = await adminApi("/api/admin/jobs/does-not-exist");
    expect(res.status).toBe(404);
  });
});
