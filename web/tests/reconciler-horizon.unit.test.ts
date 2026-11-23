import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyHorizonError,
  getFailureCategory,
  isAuthorizationFailure,
  isThrottlingFailure,
  isProviderFailure,
  extractHttpStatus,
  pollTransaction,
} from "../src/lib/reconciler/horizon";
import type { HorizonPollResult } from "../src/lib/reconciler/types";

// Mock @stellar/stellar-sdk for pollTransaction unit tests
const mockTransactionCall = vi.fn();
vi.mock("@stellar/stellar-sdk", () => {
  function MockServer() {
    return {
      transactions: () => ({
        transaction: () => ({
          call: mockTransactionCall,
        }),
      }),
    };
  }
  return {
    Horizon: {
      Server: MockServer,
    },
  };
});

describe("reconciler/horizon - classifyHorizonError & Failure Reason Codes", () => {
  describe("Authorization failures", () => {
    it("maps HTTP 401 to UNAUTHORIZED with retryable: false", () => {
      const err = { response: { status: 401 }, message: "Unauthorized" };
      expect(extractHttpStatus(err)).toBe(401);
      const code = classifyHorizonError(err);
      expect(code).toBe("UNAUTHORIZED");
      expect(getFailureCategory(code)).toBe("authorization");
      expect(isAuthorizationFailure(code)).toBe(true);
      expect(isThrottlingFailure(code)).toBe(false);
      expect(isProviderFailure(code)).toBe(false);
    });

    it("maps HTTP 403 to FORBIDDEN with retryable: false", () => {
      const err = { response: { status: 403 }, message: "Forbidden: Access denied" };
      expect(extractHttpStatus(err)).toBe(403);
      const code = classifyHorizonError(err);
      expect(code).toBe("FORBIDDEN");
      expect(getFailureCategory(code)).toBe("authorization");
      expect(isAuthorizationFailure(code)).toBe(true);
      expect(isThrottlingFailure(code)).toBe(false);
      expect(isProviderFailure(code)).toBe(false);
    });

    it("maps authorization cues in error messages when status is absent", () => {
      expect(classifyHorizonError(new Error("Request failed with status code 401"))).toBe("UNAUTHORIZED");
      expect(classifyHorizonError(new Error("Unauthorized API key"))).toBe("UNAUTHORIZED");
      expect(classifyHorizonError(new Error("Request failed with status code 403"))).toBe("FORBIDDEN");
      expect(classifyHorizonError(new Error("Forbidden access to resource"))).toBe("FORBIDDEN");
    });
  });

  describe("Throttling failures", () => {
    it("maps HTTP 429 to RATE_LIMITED with retryable: true", () => {
      const err = { response: { status: 429 }, message: "Too Many Requests" };
      expect(extractHttpStatus(err)).toBe(429);
      const code = classifyHorizonError(err);
      expect(code).toBe("RATE_LIMITED");
      expect(getFailureCategory(code)).toBe("throttling");
      expect(isThrottlingFailure(code)).toBe(true);
      expect(isAuthorizationFailure(code)).toBe(false);
      expect(isProviderFailure(code)).toBe(false);
    });

    it("maps rate limiting cues in error messages when status is absent", () => {
      expect(classifyHorizonError(new Error("Rate limit exceeded"))).toBe("RATE_LIMITED");
      expect(classifyHorizonError(new Error("Too many requests from this IP"))).toBe("RATE_LIMITED");
      expect(classifyHorizonError(new Error("Request throttled by Horizon"))).toBe("RATE_LIMITED");
    });
  });

  describe("Provider failures", () => {
    it("maps HTTP 500 to PROVIDER_ERROR with retryable: true", () => {
      const err = { response: { status: 500 }, message: "Internal Server Error" };
      const code = classifyHorizonError(err);
      expect(code).toBe("PROVIDER_ERROR");
      expect(getFailureCategory(code)).toBe("provider_failure");
      expect(isProviderFailure(code)).toBe(true);
    });

    it("maps HTTP 502 to BAD_GATEWAY with retryable: true", () => {
      const err = { response: { status: 502 }, message: "Bad Gateway" };
      const code = classifyHorizonError(err);
      expect(code).toBe("BAD_GATEWAY");
      expect(getFailureCategory(code)).toBe("provider_failure");
      expect(isProviderFailure(code)).toBe(true);
    });

    it("maps HTTP 503 to PROVIDER_UNAVAILABLE with retryable: true", () => {
      const err = { response: { status: 503 }, message: "Service Unavailable" };
      const code = classifyHorizonError(err);
      expect(code).toBe("PROVIDER_UNAVAILABLE");
      expect(getFailureCategory(code)).toBe("provider_failure");
      expect(isProviderFailure(code)).toBe(true);
    });

    it("maps HTTP 504 to GATEWAY_TIMEOUT with retryable: true", () => {
      const err = { response: { status: 504 }, message: "Gateway Timeout" };
      const code = classifyHorizonError(err);
      expect(code).toBe("GATEWAY_TIMEOUT");
      expect(getFailureCategory(code)).toBe("provider_failure");
      expect(isProviderFailure(code)).toBe(true);
    });

    it("maps other 5xx status codes to PROVIDER_ERROR", () => {
      expect(classifyHorizonError(null, 507)).toBe("PROVIDER_ERROR");
      expect(classifyHorizonError(null, 599)).toBe("PROVIDER_ERROR");
    });

    it("maps null status (network / connection drop / timeout) to NETWORK_ERROR", () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:8000");
      const code = classifyHorizonError(err);
      expect(code).toBe("NETWORK_ERROR");
      expect(getFailureCategory(code)).toBe("provider_failure");
      expect(isProviderFailure(code)).toBe(true);
    });

    it("maps network-related error messages to NETWORK_ERROR", () => {
      expect(classifyHorizonError(new Error("ETIMEDOUT: connection timed out"))).toBe("NETWORK_ERROR");
      expect(classifyHorizonError(new Error("ECONNRESET: socket hang up"))).toBe("NETWORK_ERROR");
      expect(classifyHorizonError(new Error("fetch failed"))).toBe("NETWORK_ERROR");
      expect(classifyHorizonError(new Error("The operation was aborted"))).toBe("NETWORK_ERROR");
    });
  });

  describe("Client errors & boundary cases", () => {
    it("maps HTTP 400 to BAD_REQUEST", () => {
      const err = { response: { status: 400 }, message: "Bad Request" };
      expect(classifyHorizonError(err)).toBe("BAD_REQUEST");
      expect(getFailureCategory("BAD_REQUEST")).toBe("unknown");
    });

    it("maps unrecognized status to UNKNOWN", () => {
      const err = { response: { status: 418 }, message: "I'm a teapot" };
      expect(classifyHorizonError(err)).toBe("UNKNOWN");
      expect(getFailureCategory("UNKNOWN")).toBe("unknown");
    });

    it("handles null/undefined error safely", () => {
      expect(classifyHorizonError(null)).toBe("NETWORK_ERROR");
      expect(classifyHorizonError(undefined)).toBe("NETWORK_ERROR");
      expect(getFailureCategory(null)).toBe("unknown");
      expect(getFailureCategory(undefined)).toBe("unknown");
    });
  });

  describe("Category and predicate guards on HorizonPollResult objects", () => {
    it("evaluates predicates directly on poll result objects", () => {
      const authPoll: HorizonPollResult = {
        outcome: "error",
        message: "Unauthorized",
        retryable: false,
        reasonCode: "UNAUTHORIZED",
      };
      expect(isAuthorizationFailure(authPoll)).toBe(true);
      expect(isThrottlingFailure(authPoll)).toBe(false);
      expect(isProviderFailure(authPoll)).toBe(false);

      const throttlePoll: HorizonPollResult = {
        outcome: "error",
        message: "Rate limit",
        retryable: true,
        reasonCode: "RATE_LIMITED",
      };
      expect(isAuthorizationFailure(throttlePoll)).toBe(false);
      expect(isThrottlingFailure(throttlePoll)).toBe(true);
      expect(isProviderFailure(throttlePoll)).toBe(false);

      const providerPoll: HorizonPollResult = {
        outcome: "error",
        message: "Horizon down",
        retryable: true,
        reasonCode: "PROVIDER_UNAVAILABLE",
      };
      expect(isAuthorizationFailure(providerPoll)).toBe(false);
      expect(isThrottlingFailure(providerPoll)).toBe(false);
      expect(isProviderFailure(providerPoll)).toBe(true);
    });

    it("returns false for non-error poll outcomes", () => {
      const confirmedPoll: HorizonPollResult = { outcome: "confirmed", ledger: 100, successful: true };
      const failedPoll: HorizonPollResult = { outcome: "failed", ledger: 100, successful: false };
      const notFoundPoll: HorizonPollResult = { outcome: "not_found" };

      expect(isAuthorizationFailure(confirmedPoll)).toBe(false);
      expect(isThrottlingFailure(confirmedPoll)).toBe(false);
      expect(isProviderFailure(confirmedPoll)).toBe(false);

      expect(isAuthorizationFailure(failedPoll)).toBe(false);
      expect(isThrottlingFailure(failedPoll)).toBe(false);
      expect(isProviderFailure(failedPoll)).toBe(false);

      expect(isAuthorizationFailure(notFoundPoll)).toBe(false);
      expect(isThrottlingFailure(notFoundPoll)).toBe(false);
      expect(isProviderFailure(notFoundPoll)).toBe(false);
    });
  });
});

describe("reconciler/horizon - pollTransaction integration with reason codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves missing-transaction semantics on HTTP 404 (returns not_found without reason code)", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 404 },
      message: "Resource not found",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("attaches UNAUTHORIZED reason code and retryable=false on HTTP 401", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 401 },
      message: "Invalid Horizon API Key",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "Invalid Horizon API Key",
      retryable: false,
      reasonCode: "UNAUTHORIZED",
    });
  });

  it("attaches FORBIDDEN reason code and retryable=false on HTTP 403", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 403 },
      message: "Forbidden: IP not allowlisted",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "Forbidden: IP not allowlisted",
      retryable: false,
      reasonCode: "FORBIDDEN",
    });
  });

  it("attaches RATE_LIMITED reason code and retryable=true on HTTP 429", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 429 },
      message: "Rate limit exceeded. Try again later.",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "Rate limit exceeded. Try again later.",
      retryable: true,
      reasonCode: "RATE_LIMITED",
    });
  });

  it("attaches PROVIDER_UNAVAILABLE reason code and retryable=true on HTTP 503", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 503 },
      message: "Horizon undergoing maintenance",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "Horizon undergoing maintenance",
      retryable: true,
      reasonCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("attaches PROVIDER_ERROR reason code and retryable=true on HTTP 500", async () => {
    mockTransactionCall.mockRejectedValue({
      response: { status: 500 },
      message: "Internal server error in ingestion loop",
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "Internal server error in ingestion loop",
      retryable: true,
      reasonCode: "PROVIDER_ERROR",
    });
  });

  it("attaches NETWORK_ERROR reason code and retryable=true on connection reset / network error", async () => {
    mockTransactionCall.mockRejectedValue(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8000"));

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "error",
      message: "fetch failed: ECONNREFUSED 127.0.0.1:8000",
      retryable: true,
      reasonCode: "NETWORK_ERROR",
    });
  });

  it("preserves successful confirmed outcome without altering successful results", async () => {
    mockTransactionCall.mockResolvedValue({
      ledger: 10450,
      successful: true,
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "confirmed",
      ledger: 10450,
      successful: true,
    });
  });

  it("preserves on-chain failed outcome with transaction result code", async () => {
    mockTransactionCall.mockResolvedValue({
      ledger: 10450,
      successful: false,
      extras: {
        result_codes: {
          transaction: "tx_insufficient_balance",
        },
      },
    });

    const result = await pollTransaction("tx_hash_123", "https://horizon-testnet.stellar.org");
    expect(result).toEqual({
      outcome: "failed",
      ledger: 10450,
      successful: false,
      detail: "tx_insufficient_balance",
    });
  });
});
