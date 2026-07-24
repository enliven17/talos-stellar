import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";

describe("TalosClient", () => {
  const client = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "test-key" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("should list taloses", async () => {
    const mockData = { data: [{ id: "1", name: "Talos 1" }], nextCursor: null };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.listTaloses({ limit: 10 });

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos?limit=10", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  it("should get talos detail", async () => {
    const mockData = { id: "1", name: "Talos 1" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.getTalos("1");

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos/1", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  it("should create talos", async () => {
    const params = { name: "New Talos", category: "Test", description: "Desc" };
    const mockData = { id: "2", ...params, apiKeyOnce: "new-key" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.createTalos(params);

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(params),
    }));
    expect(result).toEqual(mockData);
  });

  describe("Abort", () => {
    it("should handle aborted request", async () => {
      const abortController = new AbortController();
      vi.mocked(fetch).mockImplementation(() =>
        new Promise((_, reject) => {
          abortController.abort();
          reject(new DOMException("Aborted", "AbortError"));
        })
      );

      await expect(client.getTalos("1")).rejects.toThrow("Aborted");
    });
  });

  describe("Network Failure", () => {
    it("should handle network error", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      await expect(client.getTalos("1")).rejects.toThrow("Network error");
    });

    it("should handle DNS resolution failure", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(client.getTalos("1")).rejects.toThrow("ECONNREFUSED");
    });

    it("should handle connection reset", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNRESET"));

      await expect(client.getTalos("1")).rejects.toThrow("ECONNRESET");
    });
  });

  describe("x402 Payment Flow", () => {
    it("should handle x402 flow in purchaseServiceWithPayment", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers({
          "WWW-Authenticate": 'x402 price="0.50", payee="GABC", token="USDC", network="stellar:testnet"',
        }),
      } as Response);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paymentHeader: "signed-header" }),
      } as Response);

      const mockJob = { id: "job-1", status: "pending" };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockJob,
      } as Response);

      const result = await client.purchaseServiceWithPayment("provider-id", "buyer-id", { foo: "bar" });

      expect(result).toEqual(mockJob);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:3000/api/talos/buyer-id/sign", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ payee: "GABC", amount: 0.5, assetCode: "USDC" }),
      }));
      expect(fetch).toHaveBeenNthCalledWith(3, "http://localhost:3000/api/talos/provider-id/service", expect.objectContaining({
        headers: expect.objectContaining({ "X-PAYMENT": "signed-header" }),
      }));
    });

    it("should throw error on invalid x402 challenge format", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers({
          "WWW-Authenticate": "Invalid challenge format",
        }),
      } as Response);

      await expect(client.purchaseServiceWithPayment("provider-id", "buyer-id")).rejects.toThrow("Invalid x402 challenge");
    });

    it("should throw error on missing WWW-Authenticate header", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers(),
      } as Response);

      await expect(client.purchaseServiceWithPayment("provider-id", "buyer-id")).rejects.toThrow("Invalid x402 challenge");
    });
  });

  describe("Request and Retry Policy", () => {
    it("should fetch one activity page with typed cursor response", async () => {
      const mockPage = {
        stats: {
          totalTransactions: 1,
          totalVolume: 100,
          activeAgents: 2,
          totalAgents: 5,
          registeredServices: 3,
          playbooksTraded: 0,
        },
        transactions: [
          {
            id: "txn-1",
            type: "service",
            sellerName: "Seller",
            sellerAgent: "seller-agent",
            buyerName: "Buyer",
            buyerAgent: "buyer-agent",
            itemName: "Service Pack",
            amount: 100,
            currency: "USDC",
            status: "completed",
            timestamp: "2026-07-24T12:00:00.000Z",
            txHash: "ABC123",
          },
        ],
        nextCursor: "2026-07-24T11:00:00.000Z",
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      } as Response);

      const result = await client.listActivities({ limit: 5, cursor: "2026-07-24T13:00:00.000Z" });

      const [[url]] = vi.mocked(fetch).mock.calls;
      expect(url).toContain("http://localhost:3000/api/activity");
      expect(url).toContain("cursor=2026-07-24T13%3A00%3A00.000Z");
      expect(url).toContain("limit=5");
      expect(result).toEqual(mockPage);
    });

    it("should pass abort signal through activity page requests", async () => {
      const controller = new AbortController();
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Request aborted"));

      await expect(client.listActivities({ signal: controller.signal })).rejects.toThrow("Request aborted");
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/activity",
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it("should request activity pages with statsOnly and pagination params", async () => {
      const mockPage = {
        stats: {
          totalTransactions: 0,
          totalVolume: 0,
          activeAgents: 0,
          totalAgents: 0,
          registeredServices: 0,
          playbooksTraded: 0,
        },
        transactions: [],
        nextCursor: null,
      };

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockPage,
      } as Response);

      const result = await client.listActivities({ limit: 5, cursor: "2026-07-24T13:00:00.000Z", statsOnly: true });

      const [[url]] = vi.mocked(fetch).mock.calls;
      expect(url).toContain("http://localhost:3000/api/activity");
      expect(url).toContain("cursor=2026-07-24T13%3A00%3A00.000Z");
      expect(url).toContain("limit=5");
      expect(url).toContain("statsOnly=true");
      expect(result).toEqual(mockPage);
    });

    it("should retry 429 responses using Retry-After and succeed", async () => {
      const timedClient = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "test-key",
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 50,
          maxDelayMs: 1000,
          jitter: false,
        },
      });

      const mockData = { id: "1", name: "Talos 1" };
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({
            "Retry-After": "0.1",
          }),
          text: async () => "Too Many Requests",
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockData,
        } as Response);

      vi.useFakeTimers();
      const resultPromise = timedClient.getTalos("1");
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;
      vi.useRealTimers();

      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("should not retry unsafe POST requests by default", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Error",
      } as Response);

      await expect(client.createTalos({ name: "New Talos", category: "Test", description: "Desc" })).rejects.toThrow(
        "Talos API error 500 on /api/talos: Internal Error",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("should abort during retry wait when signal is aborted", async () => {
      const controller = new AbortController();
      const abortableClient = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "test-key",
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false,
        },
      });

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => "Server Error",
      } as Response);

      vi.useFakeTimers();
      const promise = abortableClient.listActivities({ signal: controller.signal });
      controller.abort();
      vi.advanceTimersByTime(100);
      await expect(promise).rejects.toThrow("Request aborted");
      vi.useRealTimers();
    });
  });

  describe("Base URL Configuration", () => {
    it("should use default base URL when not provided", async () => {
      const defaultClient = new TalosClient();
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

      await defaultClient.getTalos("1");

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://talos-stellar.vercel.app"),
        expect.any(Object)
      );
    });

    it("should trim trailing slash from base URL", async () => {
      const clientWithSlash = new TalosClient({ baseUrl: "http://localhost:3000/" });
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

      await clientWithSlash.getTalos("1");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/talos/1",
        expect.any(Object)
      );
    });
  });
});
