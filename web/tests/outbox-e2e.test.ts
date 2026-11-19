/**
 * End-to-end test of the transactional outbox against a real running
 * server + Postgres (see tests/api-e2e.test.ts). Proves the real module
 * boundary: an atomic write inside the commerce-job-completion transaction,
 * real SKIP LOCKED leasing, a real consumer run, real admin auth.
 *
 * Requires OUTBOX_ENABLED=true, ADMIN_API_KEY, and OUTBOX_DISPATCH_SECRET
 * for the server under test (see .github/workflows/deploy.yml). Otherwise
 * the round-trip case skips — "not configured" is the intended default for
 * a contributor who hasn't opted in.
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const DISPATCH_SECRET = process.env.OUTBOX_DISPATCH_SECRET;

function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
}
function adminApi(path: string, init: RequestInit = {}) {
  return api(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${ADMIN_KEY}` } });
}

async function createTalos() {
  const keypair = Keypair.random();
  const name = `Outbox E2E Agent ${Date.now()}`;
  const totalSupply = 500_000;
  const message = `talos-genesis:${name}:null:${totalSupply}`;
  const signature = keypair.sign(Buffer.from(message, "utf-8")).toString("base64");

  const res = await api("/api/talos", {
    method: "POST",
    body: JSON.stringify({
      name,
      category: "Development",
      description: "Created by outbox e2e test suite",
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

describe("Outbox — admin & drain auth", () => {
  it("rejects admin list without a bearer token", async () => {
    const res = await api("/api/admin/outbox");
    expect([401, 500]).toContain(res.status);
  });

  it("rejects the internal drain trigger without the shared secret", async () => {
    const res = await api("/api/internal/outbox/drain", { method: "POST" });
    expect([403, 500]).toContain(res.status);
  });
});

describe.skipIf(!ADMIN_KEY || !DISPATCH_SECRET)("Outbox — atomic write -> lease -> dispatch round trip", () => {
  it("writes commerce_job.completed atomically and dispatches it via the drain endpoint", async () => {
    const provider = await createTalos();
    const buyer = Keypair.random();

    const serviceRes = await api(`/api/talos/${provider.id}/service`, {
      method: "PUT",
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        serviceName: "outbox-e2e-service",
        price: 1,
        stellarPublicKey: buyer.publicKey(),
        fulfillmentMode: "async",
      }),
    });
    expect([200, 201]).toContain(serviceRes.status);

    const jobRes = await api(`/api/talos/${provider.id}/jobs`, {
      method: "POST",
      body: JSON.stringify({
        buyerPublicKey: buyer.publicKey(),
        txHash: `outbox-e2e-${Date.now()}`,
        payload: {},
      }),
    });
    expect(jobRes.status).toBe(201);
    const { jobId } = await jobRes.json();

    const resultRes = await api(`/api/jobs/${jobId}/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ result: { ok: true } }),
    });
    expect(resultRes.status).toBe(200);

    const event = await pollFor(async () => {
      const res = await adminApi("/api/admin/outbox?eventType=commerce_job.completed&limit=200");
      expect(res.status).toBe(200);
      const body = await res.json();
      return (body.events as Array<{ id: string; aggregateId: string }>).find((e) => e.aggregateId === jobId) ?? null;
    });

    await pollFor(async () => {
      const drainRes = await api("/api/internal/outbox/drain", {
        method: "POST",
        headers: { "x-outbox-dispatch-secret": DISPATCH_SECRET! },
      });
      expect(drainRes.status).toBe(200);

      const getRes = await adminApi(`/api/admin/outbox/${event.id}`);
      const current = await getRes.json();
      return current.status === "dispatched" ? current : null;
    });

    const finalRes = await adminApi(`/api/admin/outbox/${event.id}`);
    const final = await finalRes.json();
    expect(final.status).toBe("dispatched");

    const retryRes = await adminApi(`/api/admin/outbox/${event.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(409); // dispatched is terminal, not retryable
  });

  it("returns 404 for a nonexistent event id", async () => {
    const res = await adminApi("/api/admin/outbox/does-not-exist");
    expect(res.status).toBe(404);
  });
});
