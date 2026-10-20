/**
 * Tests for webhook subscription management on TalosClient
 * (create/list/delete/rotate), mirroring web/src/app/api/webhooks/subscriptions/*.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";

describe("TalosClient webhook subscriptions", () => {
  let client: TalosClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new TalosClient({
      apiKey: "test-key",
      baseUrl: "https://test.example.com",
      fetch: mockFetch,
    });
  });

  describe("createWebhookSubscription", () => {
    it("POSTs to /api/webhooks/subscriptions and returns the created subscription", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "sub_1",
            talosId: "talos_1",
            url: "https://example.com/hook",
            eventTypes: ["revenue.recorded"],
            description: null,
            active: true,
            signatureVersion: 1,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await client.createWebhookSubscription({
        url: "https://example.com/hook",
        secret: "a-very-secret-value-16+",
        eventTypes: ["revenue.recorded"],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.example.com/api/webhooks/subscriptions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        url: "https://example.com/hook",
        secret: "a-very-secret-value-16+",
        eventTypes: ["revenue.recorded"],
      });

      expect(result.id).toBe("sub_1");
      expect(result.url).toBe("https://example.com/hook");
      // The server never echoes the secret back.
      expect(result).not.toHaveProperty("secret");
    });
  });

  describe("listWebhookSubscriptions", () => {
    it("GETs /api/webhooks/subscriptions with query params and returns a cursor page", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "sub_1",
                url: "https://example.com/hook",
                eventTypes: ["revenue.recorded"],
                description: null,
                active: true,
                signatureVersion: 1,
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: "2024-01-01T00:00:00.000Z|sub_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const page = await client.listWebhookSubscriptions({ active: true, limit: 10 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/webhooks/subscriptions?");
      expect(url).toContain("active=true");
      expect(url).toContain("limit=10");

      expect(page.data).toHaveLength(1);
      expect(page.data[0].id).toBe("sub_1");
      expect(page.nextCursor).toBe("2024-01-01T00:00:00.000Z|sub_1");
    });

    it("paginateWebhookSubscriptions iterates across pages", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "sub_1", url: "https://a", eventTypes: ["x"], active: true, signatureVersion: 1, createdAt: "t", updatedAt: "t" }],
            nextCursor: "cursor1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "sub_2", url: "https://b", eventTypes: ["y"], active: true, signatureVersion: 1, createdAt: "t", updatedAt: "t" }],
            nextCursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const ids: string[] = [];
      for await (const sub of client.paginateWebhookSubscriptions({ maxPages: 5 })) {
        ids.push(sub.id);
      }

      expect(ids).toEqual(["sub_1", "sub_2"]);
    });
  });

  describe("deleteWebhookSubscription", () => {
    it("DELETEs /api/webhooks/subscriptions/:id", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, id: "sub_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.deleteWebhookSubscription("sub_1");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.example.com/api/webhooks/subscriptions/sub_1");
      expect(init.method).toBe("DELETE");
      expect(result).toEqual({ deleted: true, id: "sub_1" });
    });

    it("URL-encodes the subscription id", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, id: "sub/weird" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.deleteWebhookSubscription("sub/weird");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.example.com/api/webhooks/subscriptions/sub%2Fweird");
    });
  });

  describe("rotateWebhookSecret", () => {
    it("POSTs to the rotate endpoint and returns the generated secret once", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "sub_1",
            secretRotatedAt: "2024-01-02T00:00:00.000Z",
            previousSecretExpiresAt: "2024-01-09T00:00:00.000Z",
            graceSeconds: 604800,
            secret: "whsec_generated_once",
            rotationActive: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await client.rotateWebhookSecret("sub_1", { generate: true });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("https://test.example.com/api/webhooks/subscriptions/sub_1/rotate");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ generate: true });
      expect(result.rotationActive).toBe(true);
      expect(result.secret).toBe("whsec_generated_once");
    });

    it("supports finalize to clear the previous secret early", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "sub_1", previousSecretCleared: true, rotationActive: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const result = await client.rotateWebhookSecret("sub_1", { finalize: true });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ finalize: true });
      expect(result.rotationActive).toBe(false);
      expect((result as { previousSecretCleared: boolean }).previousSecretCleared).toBe(true);
    });
  });

  describe("secret redaction in the onError logger hook", () => {
    it("never surfaces a raw secret through onError when the rotate call fails", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Validation failed",
            secret: "whsec_should_never_leak",
            issues: ["secret: Secret must be 16-256 characters"],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      );

      const onError = vi.fn();
      const client = new TalosClient({
        apiKey: "test-key",
        baseUrl: "https://test.example.com",
        fetch: mockFetch,
        retryPolicy: { maxAttempts: 1 },
        onError,
      });

      await expect(
        client.rotateWebhookSecret("sub_1", { secret: "short" }),
      ).rejects.toBeDefined();

      expect(onError).toHaveBeenCalledTimes(1);
      const event = onError.mock.calls[0][0];
      // toJSON() (used by logger hooks that JSON.stringify the event) omits
      // the raw body/data entirely, so no secret can leak through it.
      expect(JSON.stringify(event)).not.toContain("whsec_should_never_leak");
      // Callers that reach for the richer `.error.data` must still see it redacted.
      const serializedData = JSON.stringify(event.error.data);
      expect(serializedData).not.toContain("whsec_should_never_leak");
      expect(serializedData).toContain("[REDACTED]");
    });

    it("never surfaces a raw secret through the thrown error's .data when create fails", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Internal server error",
            secret: "whsec_should_never_leak_either",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );

      let caught: unknown;
      try {
        await client.createWebhookSubscription({
          url: "https://example.com/hook",
          secret: "a-very-secret-value-16+",
          eventTypes: ["revenue.recorded"],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const serialized = JSON.stringify((caught as { data?: unknown }).data);
      expect(serialized).not.toContain("whsec_should_never_leak_either");
      expect(serialized).toContain("[REDACTED]");
    });
  });
});
