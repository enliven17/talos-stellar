import { createHmac, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockDelete = vi.fn();
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      update: (...a: any[]) => mockUpdate(...a),
      insert: (...a: any[]) => mockInsert(...a),
      select: (...a: any[]) => mockSelect(...a),
      delete: (...a: any[]) => mockDelete(...a),
    });
  });

  return {
    mockDb: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      transaction: mockTransaction,
    },
  };
});

const { mockDb } = mocks;

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────

function selectChain(result: any) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
  return chain;
}

function updateChain(result: any) {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

const WEBHOOK_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("hex");

// ─── Tests ────────────────────────────────────────────────────────

describe("Webhook Signing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("signPayload and verifySignature", () => {
    it("produces a verifiable signature", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test", data: { foo: "bar" } });
      const secret = "whsec_test_secret_key_12345678";

      const signature = signPayload(payload, secret);
      expect(signature).toMatch(/^v1=[a-f0-9]+,t=\d+$/);

      const valid = verifySignature(payload, signature, secret);
      expect(valid).toBe(true);
    });

    it("rejects signature with wrong secret", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";
      const wrongSecret = "whsec_wrong_secret_key_abcdefgh";

      const signature = signPayload(payload, secret);
      const valid = verifySignature(payload, signature, wrongSecret);
      expect(valid).toBe(false);
    });

    it("rejects expired timestamp (replay protection)", async () => {
      const { verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";

      // Simulate a signature from 10 minutes ago
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const dataToSign = `1.${oldTimestamp}.${payload}`;
      const hmac = createHmac("sha256", secret).update(dataToSign).digest("hex");
      const signature = `v1=${hmac},t=${oldTimestamp}`;

      const valid = verifySignature(payload, signature, secret);
      expect(valid).toBe(false);
    });

    it("rejects malformed signature header", async () => {
      const { verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";

      expect(verifySignature(payload, null, secret)).toBe(false);
      expect(verifySignature(payload, "", secret)).toBe(false);
      expect(verifySignature(payload, "invalid", secret)).toBe(false);
      expect(verifySignature(payload, "v1=abc", secret)).toBe(false);
    });
  });

  describe("encryptSecret and decryptSecret", () => {
    beforeEach(() => {
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = WEBHOOK_SECRET_ENCRYPTION_KEY;
    });

    afterEach(() => {
      delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
    });

    it("round-trips a webhook secret", async () => {
      const { encryptSecret, decryptSecret } = await import("@/lib/webhooks/signing");
      const secret = "whsec_my_long_secret_key_for_testing";

      const ciphertext = encryptSecret(secret);
      expect(ciphertext).not.toBe(secret);
      expect(ciphertext.length).toBeGreaterThan(secret.length);

      const decrypted = decryptSecret(ciphertext);
      expect(decrypted).toBe(secret);
    });

    it("produces different ciphertexts for the same plaintext", async () => {
      const { encryptSecret } = await import("@/lib/webhooks/signing");
      const secret = "whsec_my_long_secret_key_for_testing";

      const c1 = encryptSecret(secret);
      const c2 = encryptSecret(secret);
      expect(c1).not.toBe(c2);
    });
  });

  describe("maskSecret", () => {
    it("masks all but first 4 and last 4 characters", async () => {
      const { maskSecret } = await import("@/lib/webhooks/signing");
      expect(maskSecret("whsec_abcdefgh")).toBe("whse****efgh");
      expect(maskSecret("short")).toBe("****");
    });
  });

  describe("calculateBackoff", () => {
    it("produces increasing delays", async () => {
      const { calculateBackoff } = await import("@/lib/webhooks/delivery");

      const d1 = calculateBackoff(1).getTime();
      const d2 = calculateBackoff(2).getTime();
      const d3 = calculateBackoff(3).getTime();

      const now = Date.now();
      expect(d1).toBeGreaterThan(now);
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
    });

    it("caps at maximum delay", async () => {
      const { calculateBackoff } = await import("@/lib/webhooks/delivery");

      const d10 = calculateBackoff(10).getTime();
      const d20 = calculateBackoff(20).getTime();

      // Both should be within the max (60s) + jitter range
      expect(d10 - Date.now()).toBeLessThanOrEqual(90_000);
      expect(d20 - Date.now()).toBeLessThanOrEqual(90_000);
    });
  });
});

describe("Webhook Delivery Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_DELIVERY_ENABLED = "true";
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_DELIVERY_ENABLED;
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  describe("emitWebhookEvent", () => {
    it("skips emission when disabled", async () => {
      // The config uses isWebhookDeliveryEnabled() which reads env dynamically
      process.env.WEBHOOK_DELIVERY_ENABLED = "false";
      const { emitWebhookEvent } = await import("@/lib/webhooks/delivery");

      await emitWebhookEvent({
        type: "test.event",
        talosId: "agent_1",
        payload: { foo: "bar" },
      });

      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it("skips emission when no matching subscriptions", async () => {
      process.env.WEBHOOK_DELIVERY_ENABLED = "true";
      const { emitWebhookEvent } = await import("@/lib/webhooks/delivery");

      const subscriptionChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: any) => Promise.resolve(cb([]))),
      };
      mockDb.select.mockReturnValueOnce(subscriptionChain);

      await emitWebhookEvent({
        type: "test.event",
        talosId: "agent_1",
        payload: { foo: "bar" },
      });

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates delivery records for matching subscriptions", async () => {
      process.env.WEBHOOK_DELIVERY_ENABLED = "true";
      const { emitWebhookEvent } = await import("@/lib/webhooks/delivery");

      const subscriptions = [{ id: "sub_1", eventTypes: ["test.event"] }];
      const subscriptionChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: any) => Promise.resolve(cb(subscriptions))),
      };
      mockDb.select.mockReturnValueOnce(subscriptionChain);

      const onConflictDoNothing = vi.fn().mockResolvedValue([]);
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoNothing }),
      });

      await emitWebhookEvent({
        type: "test.event",
        talosId: "agent_1",
        payload: { foo: "bar" },
      });

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("attemptDelivery (with mocked fetch)", () => {
    it("returns null when delivery is disabled", async () => {
      process.env.WEBHOOK_DELIVERY_ENABLED = "false";
      const { attemptDelivery } = await import("@/lib/webhooks/delivery");

      const result = await attemptDelivery("delivery_1", "worker_1");
      expect(result).toBeNull();
    });

    it("returns null when delivery cannot be claimed", async () => {
      process.env.WEBHOOK_DELIVERY_ENABLED = "true";
      const { attemptDelivery } = await import("@/lib/webhooks/delivery");

      mockDb.update.mockReturnValue(updateChain([]));

      const result = await attemptDelivery("delivery_1", "worker_1");
      expect(result).toBeNull();
    });
  });
});

describe("Webhook Subscription API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  describe("POST /api/webhooks/subscriptions", () => {
    it("rejects unauthenticated requests", async () => {
      // No auth header should return 401
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it("creates a subscription for authenticated TALOS", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      const mockSub = {
        id: "sub_1",
        talosId: "agent_1",
        url: "https://example.com/webhook",
        eventTypes: ["test.event"],
        description: null,
        active: true,
        signatureVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Auth lookup
      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      // Insert
      const returningChain = vi.fn().mockResolvedValue([mockSub]);
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: returningChain }),
      });

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.id).toBe("sub_1");
      expect(body.url).toBe("https://example.com/webhook");
      // Secret must never be returned
      expect((body as any).secret).toBeUndefined();
      expect((body as any).secretCiphertext).toBeUndefined();
    });

    it("rejects invalid URLs", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "not-a-url",
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("rejects short secrets", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "short",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("rejects empty event types", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          eventTypes: [],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/webhooks/subscriptions", () => {
    it("returns empty list when no subscriptions exist", async () => {
      const { GET } = await import("../src/app/api/webhooks/subscriptions/route");

      // Auth lookup returns agent, then subscription list returns empty
      const authChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: any) => Promise.resolve(cb([{ id: "agent_1" }]))),
      };
      const listChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: any) => Promise.resolve(cb([]))),
      };
      mockDb.select
        .mockReturnValueOnce(authChain)
        .mockReturnValueOnce(listChain);

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        headers: { Authorization: "Bearer tok_agent_1" },
      });

      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toEqual([]);
    });

    it("rejects unauthenticated requests", async () => {
      const { GET } = await import("../src/app/api/webhooks/subscriptions/route");

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions");
      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe("DELETE /api/webhooks/subscriptions/:id", () => {
    it("deletes a subscription owned by the caller", async () => {
      const { DELETE } = await import("../src/app/api/webhooks/subscriptions/[id]/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const deleteReturning = vi.fn().mockResolvedValue([{ id: "sub_1" }]);
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: deleteReturning,
        }),
      });

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/sub_1", {
        method: "DELETE",
        headers: { Authorization: "Bearer tok_agent_1" },
      });

      const response = await DELETE(request, { params: Promise.resolve({ id: "sub_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });

    it("returns 404 for non-existent subscription", async () => {
      const { DELETE } = await import("../src/app/api/webhooks/subscriptions/[id]/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions/nonexistent", {
        method: "DELETE",
        headers: { Authorization: "Bearer tok_agent_1" },
      });

      const response = await DELETE(request, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/webhooks/deliveries/:id/claim", () => {
    it("acquires a lease on a pending delivery", async () => {
      const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/claim/route");

      const claimedResult = {
        id: "delivery_1",
        leasedBy: "worker_1",
        leasedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
        fencingToken: 1,
        status: "pending",
        subscriptionId: "sub_1",
      };

      process.env.WEBHOOK_DELIVERY_ENABLED = "true";
      mockDb.select.mockReturnValueOnce(selectChain([{ id: "worker_1" }]));
      mockDb.update.mockReturnValue(updateChain([claimedResult]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/delivery_1/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_worker_1" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "delivery_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.fencingToken).toBe(1);
      expect(body.leasedBy).toBe("worker_1");
    });

    it("rejects claim on non-existent delivery", async () => {
      const { POST } = await import("../src/app/api/webhooks/deliveries/[id]/claim/route");

      process.env.WEBHOOK_DELIVERY_ENABLED = "true";
      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "worker_1" }]))
        .mockReturnValueOnce(selectChain([])); // Delivery not found

      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/deliveries/nonexistent/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_worker_1" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(response.status).toBe(404);
    });
  });
});

// ─── Security Tests ──────────────────────────────────────────────

describe("Webhook Security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  });

  describe("Replay protection", () => {
    it("rejects timestamps older than 5 minutes", async () => {
      const { verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";

      // Signature from 10 minutes ago (beyond 5 minute tolerance)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
      const dataToSign = `1.${oldTimestamp}.${payload}`;
      const hmac = createHmac("sha256", secret).update(dataToSign).digest("hex");
      const signature = `v1=${hmac},t=${oldTimestamp}`;

      const valid = verifySignature(payload, signature, secret);
      expect(valid).toBe(false);
    });

    it("accepts recent timestamps", async () => {
      const { signPayload, verifySignature } = await import("@/lib/webhooks/signing");
      const payload = JSON.stringify({ event: "test" });
      const secret = "whsec_test_secret_key_12345678";

      const signature = signPayload(payload, secret);
      const valid = verifySignature(payload, signature, secret);
      expect(valid).toBe(true);
    });
  });

  describe("Authorization", () => {
    it("rejects requests without valid API key", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");
      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe("Secret handling", () => {
    it("never returns the webhook secret in API responses", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      const mockSub = {
        id: "sub_1",
        talosId: "agent_1",
        url: "https://example.com/webhook",
        eventTypes: ["test.event"],
        description: null,
        active: true,
        signatureVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));
      const returningChain = vi.fn().mockResolvedValue([mockSub]);
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: returningChain }),
      });

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      const body = await response.json();
      expect((body as any).secret).toBeUndefined();
      expect((body as any).secretCiphertext).toBeUndefined();
    });
  });

  describe("Input validation", () => {
    it("rejects oversized URLs", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const longUrl = "https://example.com/" + "a".repeat(3000);
      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: longUrl,
          secret: "whsec_test_secret_key_1234",
          eventTypes: ["test.event"],
        }),
      });

      const response = await POST(request);
      // URL over 2048 chars should fail validation
      expect(response.status).toBe(400);
    });

    it("rejects missing event types", async () => {
      const { POST } = await import("../src/app/api/webhooks/subscriptions/route");
      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const request = new NextRequest("http://localhost:3000/api/webhooks/subscriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_agent_1",
        },
        body: JSON.stringify({
          url: "https://example.com/webhook",
          secret: "whsec_test_secret_key_1234",
          // eventTypes missing
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });
});
