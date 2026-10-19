import { describe, it, expect, vi } from "vitest";
import {
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
  PaginationLimitExceededError,
  PaginationAbortedError,
  IdempotencyConflictError,
  IdempotencyError,
  SigningError,
  TalosStreamError,
  SchemaVersionMismatchError,
  ContractEventError,
  UnknownContractEventError,
  MalformedContractEventError,
  UnsupportedContractVersionError,
  TalosWebhookError,
  SellerQuoteError,
  SqliteSeenStoreError,
  ChaosInjectedError,
  DriftError,
  resolveRetryPolicy,
  resolveRetryOptions,
  FaultType,
} from "../src/index.js";
import { handleSdkError } from "../examples/08-error-handling-and-retries.js";

describe("SDK Error Hierarchy and Documentation Coverage", () => {
  const ALL_ERROR_CLASSES = [
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
    PaginationLimitExceededError,
    PaginationAbortedError,
    IdempotencyConflictError,
    IdempotencyError,
    SigningError,
    TalosStreamError,
    SchemaVersionMismatchError,
    ContractEventError,
    UnknownContractEventError,
    MalformedContractEventError,
    UnsupportedContractVersionError,
    TalosWebhookError,
    SellerQuoteError,
    SqliteSeenStoreError,
    ChaosInjectedError,
    DriftError,
  ];

  it("exports exactly 28 typed error classes", () => {
    expect(ALL_ERROR_CLASSES).toHaveLength(28);
    for (const ErrorClass of ALL_ERROR_CLASSES) {
      expect(typeof ErrorClass).toBe("function");
      expect(ErrorClass.prototype).toBeInstanceOf(Error);
    }
  });

  it("maintains the HTTP API error inheritance hierarchy", () => {
    expect(TalosValidationError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosAuthenticationError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosForbiddenError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosNotFoundError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosConflictError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosPaymentError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosRateLimitError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosServerError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosServerRetryableError.prototype).toBeInstanceOf(TalosServerError);
    expect(TalosServerRetryableError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosTransportError.prototype).toBeInstanceOf(TalosAPIError);
    expect(TalosTimeoutError.prototype).toBeInstanceOf(TalosAPIError);
  });

  it("maintains the contract event error inheritance hierarchy", () => {
    expect(UnknownContractEventError.prototype).toBeInstanceOf(ContractEventError);
    expect(MalformedContractEventError.prototype).toBeInstanceOf(ContractEventError);
    expect(UnsupportedContractVersionError.prototype).toBeInstanceOf(ContractEventError);
  });

  it("verifies retryability flags for all HTTP errors", () => {
    const valErr = new TalosValidationError(400, "Bad Request", "/test");
    expect(valErr.isRetryable).toBe(false);

    const authErr = new TalosAuthenticationError(401, "Unauthorized", "/test");
    expect(authErr.isRetryable).toBe(false);

    const forbErr = new TalosForbiddenError(403, "Forbidden", "/test");
    expect(forbErr.isRetryable).toBe(false);

    const notFoundErr = new TalosNotFoundError(404, "Not Found", "/test");
    expect(notFoundErr.isRetryable).toBe(false);

    const conflictErr = new TalosConflictError(409, "Conflict", "/test");
    expect(conflictErr.isRetryable).toBe(false);

    const payErr = new TalosPaymentError(402, "Payment Required", "/test");
    expect(payErr.isRetryable).toBe(false);

    const serverErr = new TalosServerError(500, "Server Error", "/test");
    expect(serverErr.isRetryable).toBe(false);

    const rateLimitErr = new TalosRateLimitError(429, "Rate Limited", "/test");
    expect(rateLimitErr.isRetryable).toBe(true);

    const retryableServerErr = new TalosServerRetryableError(503, "Unavailable", "/test");
    expect(retryableServerErr.isRetryable).toBe(true);

    const transportErr = new TalosTransportError(0, "Network dropped", "/test");
    expect(transportErr.isRetryable).toBe(true);

    const timeoutErr = new TalosTimeoutError(0, "Timed out", "/test");
    expect(timeoutErr.isRetryable).toBe(true);
  });

  it("verifies resolveRetryPolicy normalization and boundaries", () => {
    const defaultPolicy = resolveRetryPolicy();
    expect(defaultPolicy.maxAttempts).toBe(3);
    expect(defaultPolicy.baseDelayMs).toBe(100);
    expect(defaultPolicy.maxDelayMs).toBe(1000);
    expect(defaultPolicy.retryStatusCodes).toEqual([429, 500, 502, 503, 504]);
    expect(defaultPolicy.retryMethods).toEqual(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
    expect(defaultPolicy.jitter).toBe(true);

    const custom = resolveRetryPolicy({
      maxAttempts: 12, // capped at 8
      baseDelayMs: 200,
      maxDelayMs: 1500,
      retryMethods: ["get"],
      retryStatusCodes: [503],
    });
    expect(custom.maxAttempts).toBe(8);
    expect(custom.retryMethods).toEqual(["GET"]);
    expect(custom.retryStatusCodes).toEqual([503]);

    // Validation failures
    expect(() => resolveRetryPolicy({ baseDelayMs: 2000, maxDelayMs: 1000 })).toThrow(RangeError);
    expect(() => resolveRetryPolicy({ retryStatusCodes: [99] })).toThrow(RangeError);
  });

  it("verifies resolveRetryOptions normalization and boundaries", () => {
    const defaultOptions = resolveRetryOptions();
    expect(defaultOptions.maxAttempts).toBe(1); // default off
    expect(defaultOptions.idempotentOnly).toBe(true);
    expect(defaultOptions.baseDelayMs).toBe(500);
    expect(defaultOptions.maxDelayMs).toBe(8000);
    expect(defaultOptions.maxRetryAfterMs).toBe(60000);
    expect(defaultOptions.jitter).toBe(0.25);

    const custom = resolveRetryOptions({
      maxAttempts: 10, // capped at 8
      jitter: 0.5,
    });
    expect(custom.maxAttempts).toBe(8);
    expect(custom.jitter).toBe(0.5);

    expect(() => resolveRetryOptions({ jitter: 1.5 })).toThrow(RangeError);
    expect(() => resolveRetryOptions({ maxRetryAfterMs: -10 })).toThrow(RangeError);
  });

  describe("exhaustive error narrowing example execution", () => {
    it("handles every error class through handleSdkError without unhandled rejection", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      const sampleInstances: Error[] = [
        new TalosRateLimitError(429, "Too Many Requests", "/api", { retryAfterMs: 1000 }),
        new TalosValidationError(400, "Validation Error", "/api", ["name: required"]),
        new TalosAuthenticationError(401, "Invalid API key", "/api"),
        new TalosForbiddenError(403, "Forbidden", "/api"),
        new TalosNotFoundError(404, "Not Found", "/api"),
        new TalosConflictError(409, "Conflict", "/api"),
        new TalosPaymentError(402, "Payment Required", "/api", { price: 10 }),
        new TalosServerRetryableError(503, "Service Unavailable", "/api"),
        new TalosServerError(500, "Internal Server Error", "/api"),
        new TalosTimeoutError(0, "Request timed out", "/api"),
        new TalosTransportError(0, "Network failure", "/api"),
        new TalosAPIError(418, "I'm a teapot", "/api"),
        new PaginationLimitExceededError(100),
        new PaginationAbortedError("Aborted"),
        new IdempotencyConflictError("key-1", "/api", "different payload"),
        new IdempotencyError("CONFLICT", "key-1", "Conflict"),
        new SigningError("SIGNING_FAILED", "Failed to sign", false),
        new TalosStreamError(500, "stream failed", "https://api.test/stream"),
        new SchemaVersionMismatchError("1.0.0", "2.0.0"),
        new UnknownContractEventError("unknown_topic"),
        new MalformedContractEventError("Malformed ScVal"),
        new UnsupportedContractVersionError(3),
        new ContractEventError("Base contract event error"),
        new TalosWebhookError("Invalid signature", "INVALID_SIGNATURE"),
        new SellerQuoteError("INVALID_AMOUNT", "Amount must be positive"),
        new SqliteSeenStoreError("OPERATION_FAILED"),
        new ChaosInjectedError(FaultType.NETWORK_DROP, "Chaos network drop"),
        new DriftError("POST /api/talos", [{ path: "foo", message: "invalid", kind: "type_error" }]),
      ];

      expect(sampleInstances).toHaveLength(28);

      for (const instance of sampleInstances) {
        await expect(handleSdkError(async () => { throw instance; })).resolves.not.toThrow();
      }

      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleInfoSpy.mockRestore();
    });
  });
});
