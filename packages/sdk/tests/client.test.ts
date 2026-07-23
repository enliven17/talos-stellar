import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient, TalosAPIError } from "../src/client.js";

describe("TalosClient - Request/Response Behavior", () => {
  const client = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "test-key" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("Success Cases", () => {
    it("should list taloses with pagination", async () => {
      const mockData = { data: [{ id: "1", name: "Talos 1" }], nextCursor: "cursor-123" };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await client.listTaloses({ limit: 10, cursor: "cursor-123" });

      expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos?limit=10&cursor=cursor-123", expect.any(Object));
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
  });

  describe("Headers", () => {
    it("should include Content-Type header by default", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

      await client.getTalos("1");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[1]?.headers).toHaveProperty("Content-Type", "application/json");
    });

    it("should include Authorization header when apiKey is provided", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

      await client.getTalos("1");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[1]?.headers).toHaveProperty("Authorization", "Bearer test-key");
    });

    it("should merge custom headers with default headers", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ paymentHeader: "test" }),
      } as Response);

      await client.purchaseService("talos-1", {
        paymentHeader: "custom-header",
        payload: { test: "data" },
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[1]?.headers).toHaveProperty("Content-Type", "application/json");
      expect(fetchCall[1]?.headers).toHaveProperty("Authorization", "Bearer test-key");
      expect(fetchCall[1]?.headers).toHaveProperty("X-PAYMENT", "custom-header");
    });

    it("should not include Authorization header when apiKey is not provided", async () => {
      const clientNoAuth = new TalosClient({ baseUrl: "http://localhost:3000" });
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      } as Response);

      await clientNoAuth.getTalos("1");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[1]?.headers).not.toHaveProperty("Authorization");
    });
  });

  describe("URL Encoding", () => {
    it("should properly encode query parameters", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [], nextCursor: null }),
      } as Response);

      await client.listTaloses({ cursor: "cursor with spaces&special=chars" });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("cursor=cursor+with+spaces%26special%3Dchars"),
        expect.any(Object)
      );
    });

    it("should handle boolean parameters in query string", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [], nextCursor: null }),
      } as Response);

      await client.listActivities({ statsOnly: true });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("statsOnly=true"),
        expect.any(Object)
      );
    });

    it("should filter undefined parameters from query string", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [], nextCursor: null }),
      } as Response);

      await client.listTaloses({ limit: 10, cursor: undefined });

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/talos?limit=10",
        expect.any(Object)
      );
    });

    it("should encode special characters in path parameters", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "test-id" }),
      } as Response);

      await client.getTalos("id-with/slash");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/talos/id-with/slash",
        expect.any(Object)
      );
    });
  });

  describe("Standardized API Errors", () => {
    it("should throw TalosAPIError on 400 Bad Request", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      } as Response);

      await expect(client.getTalos("1")).rejects.toThrow(TalosAPIError);
      await expect(client.getTalos("1")).rejects.toThrow("Talos API error 400 on /api/talos/1: Bad Request");
    });

    it("should throw TalosAPIError on 401 Unauthorized", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      } as Response);

      await expect(client.getTalos("1")).rejects.toThrow(TalosAPIError);
      await expect(client.getTalos("1")).rejects.toThrow("Talos API error 401 on /api/talos/1: Unauthorized");
    });

    it("should throw TalosAPIError on 403 Forbidden", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      } as Response);

      await expect(client.getTalos("1")).rejects.toThrow(TalosAPIError);
    });

    it("should throw TalosAPIError on 404 Not Found", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      } as Response);

      await expect(client.getTalos("1")).rejects.toThrow(TalosAPIError);
    });

    it("should throw TalosAPIError on 500 Internal Server Error", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as Response);

      await expect(client.getTalos("1")).rejects.toThrow(TalosAPIError);
    });

    it("should include status, body, and path in TalosAPIError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "Validation Error",
      } as Response);

      try {
        await client.getTalos("1");
        expect.fail("Should have thrown TalosAPIError");
      } catch (error) {
        expect(error).toBeInstanceOf(TalosAPIError);
        const apiError = error as TalosAPIError;
        expect(apiError.status).toBe(422);
        expect(apiError.body).toBe("Validation Error");
        expect(apiError.path).toBe("/api/talos/1");
      }
    });
  });

  describe("Malformed JSON Response", () => {
    it("should handle invalid JSON in response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      } as unknown as Response);

      await expect(client.getTalos("1")).rejects.toThrow(SyntaxError);
    });

    it("should handle non-JSON response when JSON expected", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      } as unknown as Response);

      await expect(client.getTalos("1")).rejects.toThrow();
    });
  });

  describe("Timeout", () => {
    it("should handle request timeout", async () => {
      vi.mocked(fetch).mockImplementation(() =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), 100)
        )
      );

      await expect(client.getTalos("1")).rejects.toThrow("Request timeout");
    });
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
      // 1st call: 402 challenge
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 402,
        ok: false,
        headers: new Headers({
          "WWW-Authenticate": 'x402 price="0.50", payee="GABC", token="USDC", network="stellar:testnet"',
        }),
      } as Response);

      // 2nd call: signPayment (internal called by purchaseServiceWithPayment)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ paymentHeader: "signed-header" }),
      } as Response);

      // 3rd call: actual purchase with header
      const mockJob = { id: "job-1", status: "pending" };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockJob,
      } as Response);

      const result = await client.purchaseServiceWithPayment("provider-id", "buyer-id", { foo: "bar" });

      expect(result).toEqual(mockJob);
      expect(fetch).toHaveBeenCalledTimes(3);

      // Check sign call
      expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:3000/api/talos/buyer-id/sign", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ payee: "GABC", amount: 0.5, assetCode: "USDC" }),
      }));

      // Check final purchase call
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
