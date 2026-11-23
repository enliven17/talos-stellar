import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
  validateUrl: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: { insert: mocks.insert, update: mocks.update, select: mocks.select },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/security/ssrf", () => ({
  validateUrl: mocks.validateUrl,
  safeFetch: mocks.safeFetch,
}));

import {
  isSubscriptionDestinationVerified,
  performDestinationHandshake,
  verifySubscriptionChallengeToken,
} from "@/lib/webhooks/verification";
import { encryptSecret, verifySignature } from "@/lib/webhooks/signing";
import { emitWebhookEvent, attemptDelivery } from "@/lib/webhooks/delivery";
import { POST as createSubscription } from "@/app/api/webhooks/subscriptions/route";
import { PATCH as updateSubscription } from "@/app/api/webhooks/subscriptions/[id]/route";
import { POST as verifySubscription } from "@/app/api/webhooks/subscriptions/[id]/verify/route";

const SECRET = "whsec_test_secret_for_handshake";
let lastSet: Record<string, unknown> | undefined;

function updateChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn((v: Record<string, unknown>) => {
      lastSet = v;
      return {
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(returningRows),
          then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(returningRows)),
        })),
      };
    }),
  };
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(rows));
  return chain;
}

const base = {
  subscriptionId: "sub_1",
  talosId: "talos_1",
  url: "https://example.com/hook",
  secretPlaintext: SECRET,
};

beforeEach(() => {
  vi.clearAllMocks();
  lastSet = undefined;
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.WEBHOOK_DELIVERY_ENABLED = "true";
  mocks.update.mockImplementation(() => updateChain());
  mocks.validateUrl.mockImplementation(async (u: string) => new URL(u));
});

afterEach(() => {
  delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  delete process.env.WEBHOOK_DELIVERY_ENABLED;
});

describe("webhook destination verification handshake", () => {
  it("verifies a destination that echoes the signed challenge and bounds its lifetime", async () => {
    mocks.safeFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const sig = new Headers(init.headers).get("X-Webhook-Signature");
      expect(verifySignature(init.body as string, sig, SECRET)).toBe(true);
      return new Response(JSON.stringify({ challenge: body.challenge }), { status: 200 });
    });

    const before = Date.now();
    const result = await performDestinationHandshake({ ...base, verificationTtlSeconds: 3600 });

    expect(result.success).toBe(true);
    expect(result.status).toBe("verified");
    expect(lastSet?.destinationVerificationStatus).toBe("verified");
    const exp = (result.expiresAt as Date).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000);
  });

  it("fails when the destination answers 2xx without echoing the challenge", async () => {
    mocks.safeFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await performDestinationHandshake(base);
    expect(result.success).toBe(false);
    expect(lastSet?.destinationVerificationStatus).toBe("failed");
    expect(lastSet?.destinationVerificationToken).toBe(result.challenge);
  });

  it("fails on non-2xx even if the challenge is echoed", async () => {
    mocks.safeFetch.mockImplementation(async (_u: string, init: RequestInit) =>
      new Response(JSON.stringify({ challenge: JSON.parse(init.body as string).challenge }), { status: 500 }),
    );
    const result = await performDestinationHandshake(base);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it("preserves SSRF protection: restricted URLs are rejected before any request", async () => {
    mocks.validateUrl.mockRejectedValue(new Error("Restricted IP address"));
    const result = await performDestinationHandshake({ ...base, url: "http://169.254.169.254/" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Restricted IP address/);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("treats network errors (including redirects refused by safeFetch) as failures", async () => {
    mocks.safeFetch.mockRejectedValue(new Error("Redirects are not followed automatically for safety"));
    const result = await performDestinationHandshake(base);
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
  });
});

describe("out-of-band challenge token verification", () => {
  it("accepts a matching, unexpired token", async () => {
    mocks.select.mockReturnValue(
      selectChain([
        {
          id: "sub_1",
          destinationVerificationToken: "whver_abc",
          destinationVerificationExpiresAt: new Date(Date.now() + 60_000),
        },
      ]),
    );
    const r = await verifySubscriptionChallengeToken({
      subscriptionId: "sub_1",
      talosId: "talos_1",
      token: "whver_abc",
    });
    expect(r.success).toBe(true);
    expect(lastSet?.destinationVerificationToken).toBeNull();
  });

  it("rejects an expired token (boundary)", async () => {
    mocks.select.mockReturnValue(
      selectChain([
        {
          id: "sub_1",
          destinationVerificationToken: "whver_abc",
          destinationVerificationExpiresAt: new Date(Date.now() - 1),
        },
      ]),
    );
    const r = await verifySubscriptionChallengeToken({
      subscriptionId: "sub_1",
      talosId: "talos_1",
      token: "whver_abc",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/expired/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a mismatched token", async () => {
    mocks.select.mockReturnValue(
      selectChain([
        {
          id: "sub_1",
          destinationVerificationToken: "whver_abc",
          destinationVerificationExpiresAt: new Date(Date.now() + 60_000),
        },
      ]),
    );
    const r = await verifySubscriptionChallengeToken({
      subscriptionId: "sub_1",
      talosId: "talos_1",
      token: "whver_xyz",
    });
    expect(r.success).toBe(false);
  });
});

describe("delivery gating (isSubscriptionDestinationVerified & delivery engine)", () => {
  it("keeps legacy subscriptions (NULL status) deliverable", () => {
    expect(isSubscriptionDestinationVerified({ destinationVerificationStatus: null })).toBe(true);
  });

  it("blocks pending and failed destinations", () => {
    expect(isSubscriptionDestinationVerified({ destinationVerificationStatus: "pending" })).toBe(false);
    expect(isSubscriptionDestinationVerified({ destinationVerificationStatus: "failed" })).toBe(false);
  });

  it("allows verified destinations until the verification expires", () => {
    expect(
      isSubscriptionDestinationVerified({
        destinationVerificationStatus: "verified",
        destinationVerificationExpiresAt: new Date(Date.now() + 1000),
      }),
    ).toBe(true);
    expect(
      isSubscriptionDestinationVerified({
        destinationVerificationStatus: "verified",
        destinationVerificationExpiresAt: new Date(Date.now() - 1),
      }),
    ).toBe(false);
  });

  it("emitWebhookEvent skips unverified and expired subscriptions", async () => {
    mocks.select.mockReturnValueOnce(
      selectChain([
        {
          id: "sub_unverified",
          eventTypes: ["revenue.recorded"],
          destinationVerificationStatus: "pending",
          destinationVerificationExpiresAt: null,
        },
        {
          id: "sub_expired",
          eventTypes: ["revenue.recorded"],
          destinationVerificationStatus: "verified",
          destinationVerificationExpiresAt: new Date(Date.now() - 1000),
        },
        {
          id: "sub_verified",
          eventTypes: ["revenue.recorded"],
          destinationVerificationStatus: "verified",
          destinationVerificationExpiresAt: new Date(Date.now() + 60_000),
        },
      ]),
    );

    const insertedDeliveries: Array<Record<string, unknown>> = [];
    mocks.insert.mockReturnValue({
      values: vi.fn((val: Record<string, unknown>) => {
        insertedDeliveries.push(val);
        return { onConflictDoNothing: vi.fn().mockResolvedValue([]) };
      }),
    });

    await emitWebhookEvent({
      type: "revenue.recorded",
      talosId: "talos_1",
      payload: { amount: 100 },
    });

    expect(insertedDeliveries).toHaveLength(1);
    expect(insertedDeliveries[0].subscriptionId).toBe("sub_verified");
  });

  it("attemptDelivery marks delivery failed with destination_unverified when destination is not verified", async () => {
    mocks.update
      .mockImplementationOnce(() =>
        updateChain([
          {
            id: "del_1",
            subscriptionId: "sub_1",
            status: "pending",
            attempts: 0,
            maxAttempts: 5,
            fencingToken: 1,
            payloadHash: "abc:revenue.recorded@talos_1",
          },
        ]),
      )
      .mockImplementationOnce(() => updateChain([]));

    mocks.select.mockReturnValueOnce(
      selectChain([
        {
          id: "sub_1",
          talosId: "talos_1",
          url: "https://example.com/hook",
          active: true,
          destinationVerificationStatus: "pending",
        },
      ]),
    );

    const res = await attemptDelivery("del_1", "worker_1");
    expect(res).toBeNull();
    expect(lastSet?.status).toBe("dead_letter");
    expect(lastSet?.lastError).toBe("destination_unverified");
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
});

describe("subscription API routes with destination verification", () => {
  it("POST /api/webhooks/subscriptions performs handshake and reports verification status", async () => {
    mocks.select.mockReturnValueOnce(selectChain([{ id: "talos_1" }]));
    mocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "sub_new",
            talosId: "talos_1",
            url: "https://example.com/hook",
            eventTypes: ["revenue.recorded"],
            description: null,
            active: true,
            signatureVersion: 1,
            destinationVerificationStatus: "pending",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      }),
    });

    mocks.safeFetch.mockImplementation(async (_u: string, init: RequestInit) => {
      const challenge = JSON.parse(init.body as string).challenge;
      return new Response(JSON.stringify({ challenge }), { status: 200 });
    });

    const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok_1",
      },
      body: JSON.stringify({
        url: "https://example.com/hook",
        secret: SECRET,
        eventTypes: ["revenue.recorded"],
      }),
    });

    const res = await createSubscription(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.destinationVerification.status).toBe("verified");
  });

  it("PATCH /api/webhooks/subscriptions/:id resets verification when URL changes", async () => {
    mocks.select.mockReturnValueOnce(selectChain([{ id: "talos_1" }]));
    mocks.update.mockImplementationOnce(() =>
      updateChain([
        {
          id: "sub_1",
          url: "https://new.example.com/hook",
          eventTypes: ["revenue.recorded"],
          description: null,
          active: true,
          signatureVersion: 1,
          destinationVerificationStatus: "pending",
          destinationVerifiedAt: null,
          destinationVerificationExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );

    const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok_1",
      },
      body: JSON.stringify({
        url: "https://new.example.com/hook",
      }),
    });

    const res = await updateSubscription(req, { params: Promise.resolve({ id: "sub_1" }) });
    expect(res.status).toBe(200);
    expect(lastSet?.destinationVerificationStatus).toBe("pending");
    expect(lastSet?.destinationVerifiedAt).toBeNull();
    expect(lastSet?.destinationVerificationExpiresAt).toBeNull();
    expect(lastSet?.destinationVerificationToken).toBeNull();
  });

  it("POST /api/webhooks/subscriptions/:id/verify triggers handshake and returns 200 on challenge echo", async () => {
    const cipher = encryptSecret(SECRET);
    mocks.select
      .mockReturnValueOnce(selectChain([{ id: "talos_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "sub_1",
            url: "https://example.com/hook",
            secretCiphertext: cipher,
            signatureVersion: 1,
          },
        ]),
      );

    mocks.safeFetch.mockImplementation(async (_u: string, init: RequestInit) => {
      const challenge = JSON.parse(init.body as string).challenge;
      return new Response(JSON.stringify({ challenge }), { status: 200 });
    });

    const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1/verify", {
      method: "POST",
      headers: { Authorization: "Bearer tok_1" },
    });

    const res = await verifySubscription(req, { params: Promise.resolve({ id: "sub_1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("verified");
  });

  it("POST /api/webhooks/subscriptions/:id/verify returns 422 when destination fails handshake", async () => {
    const cipher = encryptSecret(SECRET);
    mocks.select
      .mockReturnValueOnce(selectChain([{ id: "talos_1" }]))
      .mockReturnValueOnce(
        selectChain([
          {
            id: "sub_1",
            url: "https://example.com/hook",
            secretCiphertext: cipher,
            signatureVersion: 1,
          },
        ]),
      );

    mocks.safeFetch.mockResolvedValue(new Response("nope", { status: 200 }));

    const req = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1/verify", {
      method: "POST",
      headers: { Authorization: "Bearer tok_1" },
    });

    const res = await verifySubscription(req, { params: Promise.resolve({ id: "sub_1" }) });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.status).toBe("failed");
  });
});
