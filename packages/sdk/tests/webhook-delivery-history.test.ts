/**
 * Tests for Webhook Delivery History async iterator and list endpoint.
 *
 * Verifies:
 * - listWebhookDeliveries: GET /api/webhooks/deliveries with typed pagination and query parameters.
 * - paginateWebhookDeliveries: Async iterable iterator over delivery history.
 * - Stopping at explicit caller limit without fetching an unnecessary page.
 * - Boundary cases (limit: 0, limit < page size, limit crossing page boundaries).
 * - Cancellation via AbortSignal.
 * - Early break / return cleanup.
 * - Error propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";
import {
  PaginationAbortedError,
  PaginationLimitExceededError,
  createPaginationIterator,
  AsyncPaginationIterator,
} from "../src/pagination.js";
import type { WebhookDelivery, WebhookDeliveryPage } from "../src/types.js";

function createDeliveryFixture(id: string, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id,
    subscriptionId: "sub_fixture_1",
    eventType: "activity.created",
    status: "success",
    attempts: 1,
    maxAttempts: 5,
    lastStatusCode: 200,
    lastError: null,
    lastAttemptAt: "2026-11-19T07:00:00.000Z",
    nextAttemptAt: null,
    completedAt: "2026-11-19T07:00:01.000Z",
    createdAt: "2026-11-19T06:59:59.000Z",
    ...overrides,
  };
}

describe("TalosClient webhook delivery history", () => {
  let client: TalosClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new TalosClient({
      apiKey: "test-api-key",
      baseUrl: "https://test.example.com",
      fetch: mockFetch,
    });
  });

  describe("listWebhookDeliveries", () => {
    it("GETs /api/webhooks/deliveries and returns a delivery page", async () => {
      const pageData: WebhookDeliveryPage = {
        data: [
          createDeliveryFixture("del_1"),
          createDeliveryFixture("del_2", { status: "failed", lastStatusCode: 500, lastError: "Gateway Timeout" }),
        ],
        nextCursor: "del_2",
      };

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(pageData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const page = await client.listWebhookDeliveries({ limit: 10, status: "failed" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/webhooks/deliveries?");
      expect(url).toContain("limit=10");
      expect(url).toContain("status=failed");
      expect(init.headers["Authorization"]).toBe("Bearer test-api-key");

      expect(page.data).toHaveLength(2);
      expect(page.data[0].id).toBe("del_1");
      expect(page.data[1].id).toBe("del_2");
      expect(page.data[1].status).toBe("failed");
      expect(page.nextCursor).toBe("del_2");
    });

    it("passes cursor and subscriptionId params correctly", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await client.listWebhookDeliveries({
        cursor: "del_cursor_xyz",
        subscriptionId: "sub_99",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("cursor=del_cursor_xyz");
      expect(url).toContain("subscriptionId=sub_99");
    });
  });

  describe("paginateWebhookDeliveries", () => {
    it("iterates across multiple pages until nextCursor is null", async () => {
      // Page 1
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1"), createDeliveryFixture("del_2")],
            nextCursor: "cursor_p2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // Page 2
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_3")],
            nextCursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const deliveries: WebhookDelivery[] = [];
      for await (const delivery of client.paginateWebhookDeliveries()) {
        deliveries.push(delivery);
      }

      expect(deliveries).toHaveLength(3);
      expect(deliveries.map((d) => d.id)).toEqual(["del_1", "del_2", "del_3"]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).not.toContain("cursor=");
      expect(mockFetch.mock.calls[1][0]).toContain("cursor=cursor_p2");
    });

    it("stops at an explicit caller limit WITHOUT fetching an unnecessary page", async () => {
      // Page 1 has 5 items and nextCursor is non-null
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              createDeliveryFixture("del_1"),
              createDeliveryFixture("del_2"),
              createDeliveryFixture("del_3"),
              createDeliveryFixture("del_4"),
              createDeliveryFixture("del_5"),
            ],
            nextCursor: "cursor_page_2_available",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      // Caller explicitly requests limit: 5
      const iterator = client.paginateWebhookDeliveries({ limit: 5 });
      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(5);
      expect(deliveries.map((d) => d.id)).toEqual(["del_1", "del_2", "del_3", "del_4", "del_5"]);
      // Crucial assertion: exactly 1 fetch was made! Page 2 was never fetched.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("stops at caller limit smaller than first page size without extra fetches", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              createDeliveryFixture("del_1"),
              createDeliveryFixture("del_2"),
              createDeliveryFixture("del_3"),
            ],
            nextCursor: "cursor_p2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const iterator = client.paginateWebhookDeliveries({ limit: 2 });
      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((d) => d.id)).toEqual(["del_1", "del_2"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("stops at an explicit caller limit across page boundaries without fetching extra pages", async () => {
      // Page 1: 2 items, nextCursor provided
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1"), createDeliveryFixture("del_2")],
            nextCursor: "cursor_p2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // Page 2: 2 items, nextCursor provided (more pages exist!)
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_3"), createDeliveryFixture("del_4")],
            nextCursor: "cursor_p3",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      // Caller wants 3 items
      const iterator = client.paginateWebhookDeliveries({ limit: 3 });
      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(3);
      expect(deliveries.map((d) => d.id)).toEqual(["del_1", "del_2", "del_3"]);
      // Made 2 fetches (for page 1 and page 2), but NOT page 3
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("clamps requested page limit on subsequent page to remaining count", async () => {
      // Page 1: 3 items, nextCursor
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1"), createDeliveryFixture("del_2"), createDeliveryFixture("del_3")],
            nextCursor: "cursor_p2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // Page 2: 2 items, nextCursor null
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_4"), createDeliveryFixture("del_5")],
            nextCursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      // Caller wants limit 4
      const iterator = client.paginateWebhookDeliveries({ limit: 4 });
      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(4);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second fetch should request remaining: 4 - 3 = 1
      const secondCallUrl = mockFetch.mock.calls[1][0];
      expect(secondCallUrl).toContain("limit=1");
    });

    it("stops immediately with 0 fetches when limit is 0", async () => {
      const iterator = client.paginateWebhookDeliveries({ limit: 0 });
      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("passes filter query parameters to fetch calls", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1", { status: "failed" })],
            nextCursor: "cursor_2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_2", { status: "failed" })],
            nextCursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const iterator = client.paginateWebhookDeliveries({
        status: "failed",
        subscriptionId: "sub_deadletter",
        limit: 10,
      });

      const deliveries: WebhookDelivery[] = [];
      for await (const d of iterator) {
        deliveries.push(d);
      }

      expect(deliveries).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain("status=failed");
      expect(mockFetch.mock.calls[0][0]).toContain("subscriptionId=sub_deadletter");
      expect(mockFetch.mock.calls[1][0]).toContain("status=failed");
      expect(mockFetch.mock.calls[1][0]).toContain("subscriptionId=sub_deadletter");
    });

    it("supports cancellation via AbortSignal", async () => {
      const abortController = new AbortController();

      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1")],
            nextCursor: "cursor_more",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const iterator = client.paginateWebhookDeliveries({ signal: abortController.signal });

      const first = await iterator.next();
      expect(first.value.id).toBe("del_1");

      // Abort
      abortController.abort();

      await expect(iterator.next()).rejects.toThrow(PaginationAbortedError);
    });

    it("aborts before iteration if signal is already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const iterator = client.paginateWebhookDeliveries({ signal: abortController.signal });

      await expect(iterator.next()).rejects.toThrow(PaginationAbortedError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("cleans up resources and halts fetching on early loop break", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [createDeliveryFixture("del_1"), createDeliveryFixture("del_2")],
            nextCursor: "p2",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const seen: string[] = [];
      for await (const delivery of client.paginateWebhookDeliveries()) {
        seen.push(delivery.id);
        break; // Stop after first item
      }

      expect(seen).toEqual(["del_1"]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("respects maxPages safety cap", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [createDeliveryFixture("del_x")],
              nextCursor: "next_loop",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      );

      const iterator = client.paginateWebhookDeliveries({ maxPages: 2 });

      await expect(async () => {
        for await (const _ of iterator) {
          // Consuming
        }
      }).rejects.toThrow(PaginationLimitExceededError);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("AsyncPaginationIterator limit option unit tests", () => {
    it("validates that limit is non-negative number", () => {
      const fetcher = vi.fn();
      expect(() => new AsyncPaginationIterator(fetcher, { limit: -1 })).toThrow(TypeError);
      expect(() => new AsyncPaginationIterator(fetcher, { limit: NaN })).toThrow(TypeError);
      expect(() => new AsyncPaginationIterator(fetcher, { limit: "5" as any })).toThrow(TypeError);
    });

    it("stops at explicit limit across pages with generic fetcher", async () => {
      let callCount = 0;
      const fetcher = vi.fn().mockImplementation(async (opts) => {
        callCount++;
        return {
          data: [`item_${callCount}_a`, `item_${callCount}_b`],
          nextCursor: `cursor_${callCount + 1}`,
        };
      });

      const iterator = createPaginationIterator(fetcher, { limit: 3 });
      const items: string[] = [];

      for await (const item of iterator) {
        items.push(item);
      }

      expect(items).toEqual(["item_1_a", "item_1_b", "item_2_a"]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      // Fetch 2 requested remaining limit (1)
      expect(fetcher).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 1 }));
    });
  });
});
