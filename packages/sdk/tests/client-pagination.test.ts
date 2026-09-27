/**
 * Tests for TalosClient pagination iterator methods.
 *
 * Tests the integration of AsyncPaginationIterator with the
 * TalosClient's paginate* methods.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";
import type { Talos, LeaderboardEntry, Playbook, CommerceService } from "../src/types.js";

describe("TalosClient pagination methods", () => {
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

  describe("paginateTaloses", () => {
    it("should create iterator for Talos list", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "1", name: "Talos 1", category: "AI", description: "Test", status: "active", pulsePrice: "100", totalSupply: 1000, creatorShare: 0.5, investorShare: 0.3, treasuryShare: 0.2, channels: [], approvalThreshold: "0.5", gtmBudget: "10000", agentOnline: true, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: "cursor1",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "2", name: "Talos 2", category: "AI", description: "Test", status: "active", pulsePrice: "100", totalSupply: 1000, creatorShare: 0.5, investorShare: 0.3, treasuryShare: 0.2, channels: [], approvalThreshold: "0.5", gtmBudget: "10000", agentOnline: true, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateTaloses({ limit: 10, maxPages: 5 });
      const taloses: Talos[] = [];

      for await (const talos of iterator) {
        taloses.push(talos);
      }

      expect(taloses).toHaveLength(2);
      expect(taloses[0].name).toBe("Talos 1");
      expect(taloses[1].name).toBe("Talos 2");
    });

    it("should pass cursor options to underlying listTaloses", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          data: [],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateTaloses({ limit: 25 });
      const taloses: Talos[] = [];

      for await (const talos of iterator) {
        taloses.push(talos);
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("limit=25");
    });

    it("should respect maxPages option", async () => {
      mockFetch.mockImplementation(() =>
        new Response(JSON.stringify({
          data: [
            { id: "1", name: "Talos 1", category: "AI", description: "Test", status: "active", pulsePrice: "100", totalSupply: 1000, creatorShare: 0.5, investorShare: 0.3, treasuryShare: 0.2, channels: [], approvalThreshold: "0.5", gtmBudget: "10000", agentOnline: true, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: "cursor",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateTaloses({ maxPages: 2 });

      await expect(async () => {
        for await (const talos of iterator) {
          // Keep consuming
        }
      }).rejects.toThrow("Pagination exceeded maximum page limit of 2");

      // With maxPages=2, it should fetch page 0 and page 1, then fail on page 2
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("paginateLeaderboard", () => {
    it("should create iterator for leaderboard", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "1", name: "Leader 1", category: "AI", status: "active", pulsePrice: "100", totalSupply: 1000, patronCount: 100, activityCount: 50, totalRevenue: 10000, marketCap: 100000 },
          ],
          nextCursor: "cursor1",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "2", name: "Leader 2", category: "AI", status: "active", pulsePrice: "100", totalSupply: 1000, patronCount: 100, activityCount: 50, totalRevenue: 10000, marketCap: 100000 },
          ],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateLeaderboard({ limit: 10 });
      const leaders: LeaderboardEntry[] = [];

      for await (const leader of iterator) {
        leaders.push(leader);
      }

      expect(leaders).toHaveLength(2);
      expect(leaders[0].name).toBe("Leader 1");
      expect(leaders[1].name).toBe("Leader 2");
    });
  });

  describe("paginatePlaybooks", () => {
    it("should create iterator for playbooks with filters", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "1", talosId: "t1", title: "Playbook 1", category: "Marketing", channel: "email", description: "Test", price: "100", currency: "USD", version: 1, tags: [], status: "active", impressions: 100, engagementRate: "0.5", conversions: 10, periodDays: 30, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: "cursor1",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "2", talosId: "t2", title: "Playbook 2", category: "Marketing", channel: "email", description: "Test", price: "100", currency: "USD", version: 1, tags: [], status: "active", impressions: 100, engagementRate: "0.5", conversions: 10, periodDays: 30, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginatePlaybooks({ category: "Marketing", limit: 10 });
      const playbooks: Playbook[] = [];

      for await (const playbook of iterator) {
        playbooks.push(playbook);
      }

      expect(playbooks).toHaveLength(2);
      expect(playbooks[0].title).toBe("Playbook 1");
      expect(playbooks[0].category).toBe("Marketing");

      // Verify the category was passed in the request
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("category=Marketing");
    });

    it("should pass all filter options correctly", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          data: [],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginatePlaybooks({
        category: "Marketing",
        channel: "email",
        search: "test",
        sort: "price",
        direction: "desc",
        limit: 20,
      });

      const playbooks: Playbook[] = [];
      for await (const playbook of iterator) {
        playbooks.push(playbook);
      }

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("category=Marketing");
      expect(calledUrl).toContain("channel=email");
      expect(calledUrl).toContain("search=test");
      expect(calledUrl).toContain("sort=price");
      expect(calledUrl).toContain("direction=desc");
      expect(calledUrl).toContain("limit=20");
    });
  });

  describe("paginateServices", () => {
    it("should create iterator for services", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "1", talosId: "t1", serviceName: "Service 1", description: "Test", price: "100", currency: "USD", stellarPublicKey: "key", chains: ["stellar"], fulfillmentMode: "auto", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: "cursor1",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: "2", talosId: "t2", serviceName: "Service 2", description: "Test", price: "100", currency: "USD", stellarPublicKey: "key", chains: ["stellar"], fulfillmentMode: "auto", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateServices({ category: "AI", limit: 10 });
      const services: CommerceService[] = [];

      for await (const service of iterator) {
        services.push(service);
      }

      expect(services).toHaveLength(2);
      expect(services[0].serviceName).toBe("Service 1");

      // Verify the category was passed in the request
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain("category=AI");
    });
  });

  describe("cancellation integration", () => {
    it("should support cancellation via AbortSignal", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          data: [
            { id: "1", name: "Talos 1", category: "AI", description: "Test", status: "active", pulsePrice: "100", totalSupply: 1000, creatorShare: 0.5, investorShare: 0.3, treasuryShare: 0.2, channels: [], approvalThreshold: "0.5", gtmBudget: "10000", agentOnline: true, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
          ],
          nextCursor: "cursor",
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const abortController = new AbortController();
      const iterator = client.paginateTaloses({ signal: abortController.signal });
      const taloses: Talos[] = [];

      // Get first item
      const firstResult = await iterator.next();
      taloses.push(firstResult.value);

      // Abort after first item
      abortController.abort();

      // Next call should throw
      await expect(iterator.next()).rejects.toThrow("Pagination iteration was aborted");

      expect(taloses).toHaveLength(1);
    });
  });

  describe("timeout integration", () => {
    it("should pass timeout to underlying requests", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({
          data: [],
          nextCursor: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      const iterator = client.paginateTaloses({ timeoutMs: 5000 });
      const taloses: Talos[] = [];

      for await (const talos of iterator) {
        taloses.push(talos);
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The timeout should be handled by the client's timeout mechanism
    });
  });

  describe("error propagation", () => {
    it("should propagate API errors from underlying methods", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), { 
          status: 401, 
          headers: { "Content-Type": "application/json" } 
        }),
      );

      const iterator = client.paginateTaloses();

      await expect(async () => {
        for await (const talos of iterator) {
          // Should not be reached
        }
      }).rejects.toThrow();
    });
  });
});
