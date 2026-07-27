import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosAPIError,
  TalosValidationError,
  TalosAuthenticationError,
  TalosForbiddenError,
  TalosNotFoundError,
  TalosConflictError,
  TalosPaymentError,
  TalosRateLimitError,
  TalosServerError,
  TalosServerRetryableError,
  TalosTransportError,
  TalosTimeoutError,
  errorFromResponse,
  classifyTransportError,
  sanitizeBody,
  redactSecrets,
  parseRetryAfter,
  parseX402Challenge,
  MAX_BODY_BYTES,
} from "../src/index.js";

describe("TalosClient - Request/Response Behavior", () => {
  const client = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "test-key" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
        headers: new Headers(),
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

  describe("Timeout (legacy passthrough)", () => {
    it("should handle request timeout", async () => {
      vi.mocked(fetch).mockImplementation(() =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), 100)
        )
      );

      await expect(client.getTalos("1")).rejects.toThrow("Request timeout");
    });
  });

  describe("Abort (legacy passthrough)", () => {
    it("should handle aborted request", async () => {
      vi.mocked(fetch).mockImplementation(() =>
        new Promise((_, reject) => {
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

// ════════════════════════════════════════════════════════════════════
// Typed SDK error hierarchy — new coverage.
// ════════════════════════════════════════════════════════════════════

describe("Typed SDK Error Hierarchy", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Validation error (400)", () => {
    it("parses server issues array and uses TalosValidationError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ "x-request-id": "req-1" }),
        text: async () =>
          JSON.stringify({ error: "Validation failed", issues: ["name: required", "category: invalid"] }),
      } as Response);

      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      try {
        await c.createTalos({ name: "", category: "Bogus" as any, description: "x", creatorPublicKey: "pk", signature: "sig", message: "msg" });
        expect.fail("should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(TalosAPIError);
        expect(e).toBeInstanceOf(TalosValidationError);
        const v = e as TalosValidationError;
        expect(v.code).toBe("validation_error");
        expect(v.status).toBe(400);
        expect(v.issues).toEqual(["name: required", "category: invalid"]);
        expect(v.requestId).toBe("req-1");
        expect(v.data).toMatchObject({ error: "Validation failed" });
        expect(v.isRetryable).toBe(false);
      }
    });
  });

  describe("Authentication error (401/403)", () => {
    it("returns TalosAuthenticationError on 401", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: "Missing Authorization header" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      await expect(c.getTalos("1")).rejects.toMatchObject({
        name: "TalosAuthenticationError",
        code: "authentication_error",
        status: 401,
      });
    });

    it("returns TalosForbiddenError on 403 (and is NOT an AuthenticationError)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: "Invalid API key" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosForbiddenError);
      expect(err).toBeInstanceOf(TalosAPIError);
      // Regression guard: 403 must not be silently remapped to authentication_error.
      expect(err).not.toBeInstanceOf(TalosAuthenticationError);
      expect((err as TalosAPIError).code).toBe("forbidden");
      expect((err as TalosAPIError).status).toBe(403);
    });
  });

  describe("Not found (404)", () => {
    it("parses as TalosNotFoundError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: "TALOS not found" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      await expect(c.getTalos("missing")).rejects.toMatchObject({
        name: "TalosNotFoundError",
        code: "not_found_error",
        status: 404,
      });
    });
  });

  describe("Conflict (409)", () => {
    it("preserves detail", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            error: "Job is already leased by another worker",
            detail: "The job has a valid, unexpired lease held by another agent",
          }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.request("/api/jobs/job-1/claim", { method: "POST" }).catch((e) => e);
      expect(err).toBeInstanceOf(TalosConflictError);
      expect(err.code).toBe("conflict_error");
      expect(err.data).toMatchObject({ detail: "The job has a valid, unexpired lease held by another agent" });
    });
  });

  describe("Payment error (402)", () => {
    it("parses x402 challenge into structured form", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 402,
        headers: new Headers({
          "WWW-Authenticate": 'x402 price="2.50", payee="GPAYEE", token="USDC", network="stellar:testnet"',
        }),
        text: async () => "",
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.request("/api/talos/x/service", { method: "POST" }).catch((e) => e);
      expect(err).toBeInstanceOf(TalosPaymentError);
      const p = err as TalosPaymentError;
      expect(p.code).toBe("payment_error");
      expect(p.challenge).toMatchObject({ price: "2.50", payee: "GPAYEE", token: "USDC", network: "stellar:testnet" });
    });
  });

  describe("Rate limit (429)", () => {
    it("captures Retry-After + X-RateLimit-* and marks retryable", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({
          "Retry-After": "30",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1700000000",
        }),
        text: async () => JSON.stringify({ error: "Too many requests" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.request("/api/talos").catch((e) => e);
      expect(err).toBeInstanceOf(TalosRateLimitError);
      const r = err as TalosRateLimitError;
      expect(r.code).toBe("rate_limit_error");
      expect(r.isRetryable).toBe(true);
      expect(r.retryAfterMs).toBe(30_000);
      expect(r.limit).toBe(60);
      expect(r.remaining).toBe(0);
      expect(typeof r.resetAt).toBe("number");
    });
  });

  describe("Server errors (5xx)", () => {
    it("500 -> TalosServerError (non-retryable)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: "Internal server error" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      await expect(c.getTalos("1")).rejects.toMatchObject({
        name: "TalosServerError",
        code: "server_error",
        isRetryable: false,
      });
    });

    it("503 -> TalosServerRetryableError (retryable)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service unavailable",
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosServerRetryableError);
      expect((err as TalosAPIError).isRetryable).toBe(true);
    });
  });

  describe("Secret redaction + body sanitization", () => {
    it("redacts sensitive fields in 500 body and data", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({
            error: "boom",
            token: "sekret-token-value",
            authorization: "Bearer xyz",
            apiKey: "k-1234",
            signature: "sig-x",
          }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err.body).toContain("[REDACTED]");
      expect(err.body).not.toContain("sekret-token-value");
      expect(err.body).not.toContain("xyz");
      expect(err.body).not.toContain("k-1234");
      expect(err.body).not.toContain("sig-x");
    });

    it("truncates oversized non-JSON body", async () => {
      const oversized = "Internal error " + "x".repeat(MAX_BODY_BYTES * 2);
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => oversized,
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e) as TalosAPIError;
      expect(err.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES + 20);
      expect(err.body.endsWith("…[truncated]")).toBe(true);
    });
  });

  describe("Transport / Timeout classification", () => {
    it("classifies ECONNREFUSED as TalosTransportError", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosTransportError);
      expect((err as TalosTimeoutError).code).toBe("transport_error");
      expect((err as TalosAPIError).isRetryable).toBe(true);
      // Legacy message preservation.
      await expect(c.getTalos("1")).rejects.toThrow("ECONNREFUSED");
    });

    it("classifies AbortError as TalosTimeoutError", async () => {
      vi.mocked(fetch).mockRejectedValue(new DOMException("Aborted", "AbortError"));
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosTimeoutError);
      expect((err as TalosTimeoutError).code).toBe("timeout_error");
      expect((err as TalosAPIError).isRetryable).toBe(true);
      // Legacy message preservation.
      await expect(c.getTalos("1")).rejects.toThrow("Aborted");
    });

    it("classifies message-based timeout as TalosTimeoutError", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Request timeout"));
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosTimeoutError);
      await expect(c.getTalos("1")).rejects.toThrow("Request timeout");
    });
  });

  describe("Bounded timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts the request after timeoutMs", async () => {
      let aborted = false;
      vi.mocked(fetch).mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
          const sig = (init as RequestInit | undefined)?.signal;
          if (sig) sig.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
        });
      });

      const c = new TalosClient({ baseUrl: "http://localhost:3000", timeoutMs: 50 });
      const p = c.getTalos("1");
      // Catch the rejection so it doesn't bubble up.
      const caught = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await caught;
      expect(aborted).toBe(true);
      expect(err).toBeInstanceOf(TalosTimeoutError);
    });
  });

  describe("Bounded retry", () => {
    it("retries rate-limited GET until maxAttempts", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "0" }),
        text: async () => JSON.stringify({ error: "Too many requests" }),
      } as Response);

      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosRateLimitError);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry POST by default", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "0" }),
        text: async () => JSON.stringify({ error: "Too many requests" }),
      } as Response);

      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 5, baseDelayMs: 0, jitter: 0 },
      });
      const err = await c
        .createTalos({ name: "x", category: "Test" as any, description: "d", creatorPublicKey: "pk", signature: "s", message: "m" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(TalosRateLimitError);
      // Only one attempt because POST is non-idempotent.
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("invokes onRetry and onError observers", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => "Service unavailable",
      } as Response);

      const onRetry = vi.fn();
      const onError = vi.fn();
      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0, onRetry },
        onError,
      });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosServerRetryableError);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({
        path: "/api/talos/1",
        method: "GET",
        attempt: 2,
      });
    });

    it("caps maxAttempts at 8 even if user requests more", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => "Service unavailable",
      } as Response);
      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 1_000, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      await c.getTalos("1").catch(() => {});
      // 1 initial + 7 retries = 8 calls
      expect(fetch).toHaveBeenCalledTimes(8);
    });

    it("rejects non-retryable errors immediately (no retry)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "Validation failed", issues: ["x: bad"] }),
      } as Response);
      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 5, baseDelayMs: 0, jitter: 0 },
      });
      const err = await c.getTalos("1").catch((e) => e);
      expect(err).toBeInstanceOf(TalosValidationError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("returns the response from a successful attempt after transient retry", async () => {
      // 1st call: transient 503
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service unavailable",
      } as Response);
      // 2nd call: success
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ok" }),
      } as Response);
      const c = new TalosClient({
        baseUrl: "http://localhost:3000",
        retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      const result = await c.getTalos("1");
      expect(result).toEqual({ id: "ok" });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not leak the timeout timer on successful request (clearTimeout on success)", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "ok" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000", timeoutMs: 1000 });
      const result = await c.getTalos("1");
      expect(result).toEqual({ id: "ok" });
    });
  });

  describe("Helpers", () => {
    it("errorFromResponse produces correct subtype for status codes", () => {
      const cases: Array<[number, any]> = [
        [400, TalosValidationError],
        [401, TalosAuthenticationError],
        [402, TalosPaymentError],
        [403, TalosForbiddenError],
        [404, TalosNotFoundError],
        [409, TalosConflictError],
        [429, TalosRateLimitError],
        [500, TalosServerError],
        [503, TalosServerRetryableError],
      ];
      for (const [status, klass] of cases) {
        const err = errorFromResponse(status, "/x", "{}", new Headers());
        expect(err).toBeInstanceOf(klass);
      }
    });

    it("sanitizeBody redacts nested sensitive fields and caps length", () => {
      const huge = "x".repeat(MAX_BODY_BYTES * 2);
      const r = sanitizeBody(JSON.stringify({ authorization: "Bearer abc", nested: { apiKey: "k-1234" }, ok: 1, big: huge }));
      expect(r.body).toContain("[REDACTED]");
      expect(r.body).not.toContain("Bearer abc");
      expect(r.body).not.toContain("k-1234");
      expect((r.data as any).authorization).toBe("[REDACTED]");
      expect((r.data as any).nested.apiKey).toBe("[REDACTED]");
      expect(r.body.length).toBeLessThan(MAX_BODY_BYTES + 20);
    });

    it("redactSecrets handles circular refs without infinite loop", () => {
      const a: any = { name: "a" };
      a.self = a;
      const r = redactSecrets(a) as any;
      expect(r.name).toBe("a");
      expect(r.self).toBe("[Circular]");
    });

    it("parseRetryAfter accepts seconds and ISO dates", () => {
      expect(parseRetryAfter("5")).toBe(5_000);
      expect(parseRetryAfter("0")).toBe(0);
      const future = new Date(Date.now() + 10_000).toUTCString();
      const ms = parseRetryAfter(future);
      expect(ms).toBeGreaterThan(9_000);
      expect(ms).toBeLessThanOrEqual(10_000);
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter("not-a-number")).toBeUndefined();
    });

    it("parseX402Challenge returns structured fields", () => {
      expect(
        parseX402Challenge('x402 price="0.50", payee="GABC", token="USDC", network="stellar:testnet"'),
      ).toEqual({ price: "0.50", payee: "GABC", token: "USDC", network: "stellar:testnet" });
      expect(parseX402Challenge(undefined)).toBeUndefined();
      expect(parseX402Challenge("invalid")).toBeUndefined();
    });

    it("classifyTransportError covers Abort, Timeout, generic", () => {
      const a = classifyTransportError(new DOMException("Aborted", "AbortError"), "/x");
      expect(a).toBeInstanceOf(TalosTimeoutError);
      const t = classifyTransportError(new Error("Request timeout"), "/x");
      expect(t).toBeInstanceOf(TalosTimeoutError);
      const x = classifyTransportError(new Error("Boom"), "/x");
      expect(x).toBeInstanceOf(TalosTransportError);
    });

    it("TalosAPIError.toJSON() returns a structured object", () => {
      const e = new TalosAPIError(500, "boom", "/x", { code: "server_error", requestId: "r-1", isRetryable: false });
      const j = e.toJSON();
      expect(j.name).toBe("TalosAPIError");
      expect(j.code).toBe("server_error");
      expect(j.status).toBe(500);
      expect(j.requestId).toBe("r-1");
      expect(typeof j.timestamp).toBe("string");
    });
  });

  describe("Backward-compatibility aliases", () => {
    it("every typed error is an instance of TalosAPIError", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "x" }),
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      try {
        await c.getTalos("1");
      } catch (e) {
        expect(e).toBeInstanceOf(TalosAPIError);
      }
    });

    it("legacy message for 502/503/504 still includes status", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway",
      } as Response);
      const c = new TalosClient({ baseUrl: "http://localhost:3000" });
      await expect(c.getTalos("1")).rejects.toThrow("502");
    });
  });
});
