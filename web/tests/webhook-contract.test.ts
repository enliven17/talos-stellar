import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "http";
import { emitWebhookEvent, attemptDelivery } from "@/lib/webhooks/delivery";
import { db } from "@/db";
import { tlsWebhookSubscriptions, tlsWebhookDeliveries } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@/lib/webhooks/signing";

// Mock SSRF validation to allow localhost in tests
vi.mock("@/lib/security/ssrf", async () => {
  const actual = await vi.importActual("@/lib/security/ssrf");
  return {
    ...actual,
    safeFetch: async (url: string, options: RequestInit = {}) => {
        return fetch(url, options);
    }
  };
});

// Mock config to enable webhooks and set a fixed key
vi.mock("@/lib/webhooks/config", async () => {
  const actual = await vi.importActual("@/lib/webhooks/config");
  return {
    ...actual,
    isWebhookDeliveryEnabled: () => true,
    getWebhookEncryptionKey: () => Buffer.alloc(32, 0),
  };
});

describe("Webhook Contract Test Kit", () => {
  let server: any;
  let port: number;
  let receivedRequests: any[] = [];
  let requestHandler = (req: any, res: any) => {
      res.writeHead(200);
      res.end("OK");
  };

  beforeAll(async () => {
    // Start local receiver
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: JSON.parse(body || "{}"),
        });
        requestHandler(req, res);
      });
    });
    
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("should deliver signed requests to local receiver", async () => {
    receivedRequests = [];
    requestHandler = (req, res) => { res.writeHead(200); res.end("OK"); };

    // 1. Setup subscription
    const secret = "my-super-secret-key-that-is-long-enough";
    const secretCiphertext = encryptSecret(secret);
    
    const [sub] = await db.insert(tlsWebhookSubscriptions).values({
      talosId: "test-talos",
      url: `http://127.0.0.1:${port}/webhook`,
      secretCiphertext,
      eventTypes: ["test.event"],
      active: true,
    }).returning();

    // 2. Emit event
    await emitWebhookEvent({
      type: "test.event",
      talosId: "test-talos",
      payload: { foo: "bar" },
    });

    // 3. Find delivery record
    const delivery = await db.select().from(tlsWebhookDeliveries)
      .where(eq(tlsWebhookDeliveries.subscriptionId, sub.id))
      .then((r) => r[0]);
    
    expect(delivery).toBeDefined();

    // 4. Attempt delivery
    const result = await attemptDelivery(delivery!.id, "test-worker");

    expect(result?.status).toBe("delivered");
    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].headers["x-webhook-signature"]).toBeDefined();
    expect(receivedRequests[0].body.foo).toBe("bar");
  });

  it("should retry on failure", async () => {
    receivedRequests = [];
    let attempts = 0;
    requestHandler = (req, res) => {
        attempts++;
        if (attempts === 1) {
            res.writeHead(500);
            res.end("Internal Server Error");
        } else {
            res.writeHead(200);
            res.end("OK");
        }
    };

    // 1. Setup subscription
    const secret = "my-super-secret-key-that-is-long-enough";
    const secretCiphertext = encryptSecret(secret);
    
    const [sub] = await db.insert(tlsWebhookSubscriptions).values({
      talosId: "test-talos-retry",
      url: `http://127.0.0.1:${port}/webhook`,
      secretCiphertext,
      eventTypes: ["retry.event"],
      active: true,
    }).returning();

    // 2. Emit event
    await emitWebhookEvent({
      type: "retry.event",
      talosId: "test-talos-retry",
      payload: { retry: "me" },
    });

    // 3. Find delivery record
    const delivery = await db.select().from(tlsWebhookDeliveries)
      .where(eq(tlsWebhookDeliveries.subscriptionId, sub.id))
      .then((r) => r[0]);
    
    // 4. Attempt delivery (first time - fails)
    const res1 = await attemptDelivery(delivery!.id, "test-worker");
    expect(res1?.status).toBe("failed");
    expect(attempts).toBe(1);

    // 5. Attempt delivery (second time - succeeds)
    const res2 = await attemptDelivery(delivery!.id, "test-worker");
    expect(res2?.status).toBe("delivered");
    expect(attempts).toBe(2);
  });
});
