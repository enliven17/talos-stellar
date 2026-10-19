/**
 * Example 08 — Errors and Retries
 *
 * Demonstrates how to handle errors across all SDK domains and configure
 * bounded retry policies.
 *
 * This example covers:
 *   1. Configuring status-code (`retryPolicy`) vs typed error (`retry`) policies.
 *   2. Exhaustive try/catch error narrowing across all 28 SDK error classes.
 *   3. Handling request signing errors (see docs/sdk-request-signing.md).
 *   4. Safe inspection of error envelopes, status codes, and Retry-After hints.
 */

import {
  TalosClient,
  resolveRetryPolicy,
  resolveRetryOptions,
  // ── HTTP API Error Hierarchy ──────────────────────────────────────────────
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
  // ── Pagination Errors ─────────────────────────────────────────────────────
  PaginationLimitExceededError,
  PaginationAbortedError,
  // ── Idempotency Errors ────────────────────────────────────────────────────
  IdempotencyConflictError,
  IdempotencyError,
  // ── Request Signing Errors ────────────────────────────────────────────────
  SigningError,
  // ── Streaming & SSE Errors ────────────────────────────────────────────────
  TalosStreamError,
  SchemaVersionMismatchError,
  // ── Contract Event Decoding Errors ────────────────────────────────────────
  ContractEventError,
  UnknownContractEventError,
  MalformedContractEventError,
  UnsupportedContractVersionError,
  // ── Webhook Verification Errors ───────────────────────────────────────────
  TalosWebhookError,
  // ── Commerce & A2A Seller Quote Errors ────────────────────────────────────
  SellerQuoteError,
  // ── Seen Store Persistence Errors ─────────────────────────────────────────
  SqliteSeenStoreError,
  // ── Chaos Testing Faults ──────────────────────────────────────────────────
  ChaosInjectedError,
  // ── Schema Drift Errors ───────────────────────────────────────────────────
  DriftError,
} from "../src/index.js";

// ── 1. Configuring Retry Policies ─────────────────────────────────────────────

/**
 * The SDK supports two complementary retry models:
 *
 * A. Status-Code Retry Policy (`retryPolicy`):
 *    - Enabled by default with maxAttempts: 3, retrying 429, 500, 502, 503, 504
 *      on idempotent methods (GET, HEAD, PUT, DELETE, OPTIONS).
 *    - Normalized and validated at construction via `resolveRetryPolicy()`.
 *    - Automatically disabled when `retry` is explicitly supplied without `retryPolicy`.
 *
 * B. Typed-Error Bounded Policy (`retry`):
 *    - Driven by `error.isRetryable === true` (429, 502/503/504, transport, timeout).
 *    - Normalized and validated at construction via `resolveRetryOptions()`.
 *    - Supports custom backoff, jitter, and Retry-After header clamping.
 */

// Inspect effective default retry policies:
export const defaultStatusCodePolicy = resolveRetryPolicy();
export const defaultTypedRetryPolicy = resolveRetryOptions();

export const client = new TalosClient({
  baseUrl: process.env.TALOS_API_URL ?? "https://talos-stellar.vercel.app",
  apiKey: process.env.TALOS_API_KEY,
  // Per-request timeout in milliseconds (surfaces as TalosTimeoutError)
  timeoutMs: 15_000,
  // Status-code driven policy
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
    retryMethods: ["GET", "HEAD", "OPTIONS"],
    retryStatusCodes: [429, 502, 503, 504],
    jitter: true,
  },
  // Bounded auto-retry policy driven by typed error retryability
  retry: {
    maxAttempts: 4,              // Hard-capped at 8
    idempotentOnly: true,        // POST/PATCH without idempotency key never auto-retried
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    maxRetryAfterMs: 30_000,     // Clamp server-supplied Retry-After header
    jitter: 0.25,
    onRetry: ({ attempt, error, delayMs }) => {
      console.warn(`[Retry ${attempt}] waiting ${delayMs}ms due to ${error.code} (${error.status})`);
    },
  },
  onError: ({ error, path, method, attempt, durationMs }) => {
    console.error(`[SDK Error] ${method} ${path} failed on attempt ${attempt} after ${durationMs}ms:`, error.message);
  },
});

// ── 2. Exhaustive Error Narrowing Example ──────────────────────────────────────

/**
 * Handle errors across all 28 exported SDK error classes.
 *
 * Subtypes must be checked before parent classes (e.g. TalosServerRetryableError
 * before TalosServerError, and UnknownContractEventError before ContractEventError).
 */
export async function handleSdkError(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    // ── HTTP API Errors (rooted at TalosAPIError) ───────────────────────────
    if (error instanceof TalosRateLimitError) {
      // HTTP 429: Too Many Requests (Retryable)
      const waitTimeMs = error.retryAfterMs ?? 1_000;
      console.warn(`Rate limit exceeded. Reset in ${waitTimeMs}ms. Limit: ${error.limit}, Remaining: ${error.remaining}`);
    } else if (error instanceof TalosValidationError) {
      // HTTP 400 or 422: Validation Error (Non-retryable)
      console.error("Validation failed with issues:", error.issues, error.validationDetails);
    } else if (error instanceof TalosAuthenticationError) {
      // HTTP 401: Unauthorized (Non-retryable)
      console.error("Invalid or expired API key. Please check your credentials.");
    } else if (error instanceof TalosForbiddenError) {
      // HTTP 403: Forbidden (Non-retryable)
      console.error("Access forbidden: caller lacks permissions for this resource.");
    } else if (error instanceof TalosNotFoundError) {
      // HTTP 404: Not Found (Non-retryable)
      console.error(`Resource at path ${error.path} was not found.`);
    } else if (error instanceof TalosConflictError) {
      // HTTP 409: Conflict (Non-retryable)
      console.error("Resource state conflict:", error.data);
    } else if (error instanceof TalosPaymentError) {
      // HTTP 402: Payment Required (Non-retryable)
      console.error("x402 payment challenge received:", error.challenge);
    } else if (error instanceof TalosServerRetryableError) {
      // HTTP 502, 503, 504: Gateway / Upstream Server Error (Retryable)
      console.warn(`Server temporarily unavailable (${error.status}). Server said: ${error.apiMessage}`);
    } else if (error instanceof TalosServerError) {
      // HTTP 500: Fatal Server Error (Non-retryable in typed policy)
      console.error(`Unhandled internal server error (${error.status}):`, error.apiMessage);
    } else if (error instanceof TalosTimeoutError) {
      // Request timeout or aborted by client (Retryable)
      console.warn(`Request timed out after configured duration: ${error.message}`);
    } else if (error instanceof TalosTransportError) {
      // Network drop, DNS failure, connection reset, or fetch unavailable (Retryable)
      console.warn("Network transport error occurred:", error.cause ?? error.message);
    } else if (error instanceof TalosAPIError) {
      // Catch-all for any other HTTP status or unmapped TalosAPIError
      console.error(`Talos API Error (${error.status}, code=${error.code}):`, error.message);

    // ── Pagination Errors ───────────────────────────────────────────────────
    } else if (error instanceof PaginationLimitExceededError) {
      // Thrown by AsyncPaginationIterator when limits are exceeded (Non-retryable)
      console.error("Pagination aborted: exceeded configured safety limits.");
    } else if (error instanceof PaginationAbortedError) {
      // Thrown by AsyncPaginationIterator when aborted via AbortSignal (Non-retryable)
      console.info("Pagination was stopped by caller abort signal.");

    // ── Idempotency Errors ──────────────────────────────────────────────────
    } else if (error instanceof IdempotencyConflictError) {
      // Reusing an idempotency key with a mutated request payload (Non-retryable)
      console.error(`Idempotency key "${error.conflictingKey}" payload mismatch on ${error.path}. Generate a new key.`);
    } else if (error instanceof IdempotencyError) {
      // Client-side idempotency storage or execution failure (Non-retryable)
      console.error(`Idempotency failure [${error.code}] for key ${error.key}:`, error.message);

    // ── Request Signing Errors ──────────────────────────────────────────────
    } else if (error instanceof SigningError) {
      // Pluggable request signing failed (key mismatch, signature failure, body too large).
      // See docs/sdk-request-signing.md for troubleshooting, rollout, and limits.
      console.error(`Request signing error [${error.code}]: ${error.message}`);

    // ── Event Stream & SSE Errors ───────────────────────────────────────────
    } else if (error instanceof TalosStreamError) {
      // Server-Sent Events stream connection failure (Retryable via reconnect)
      console.warn(`SSE stream failure (${error.status}) at ${error.url}: ${error.body}`);
    } else if (error instanceof SchemaVersionMismatchError) {
      // SSE schema version incompatibility (Non-retryable without SDK upgrade)
      console.error(`Stream schema mismatch: requested "${error.requested}", server sent "${error.serverAcknowledged}"`);

    // ── Soroban / Stellar Contract Event Decoding Errors ────────────────────
    } else if (error instanceof UnknownContractEventError) {
      // Unrecognized contract event symbol (Non-retryable)
      console.warn(`Unknown contract event symbol: "${error.symbol}"`);
    } else if (error instanceof MalformedContractEventError) {
      // Event topics or data failed ScVal schema decoding (Non-retryable)
      console.error("Malformed contract event payload:", error.message);
    } else if (error instanceof UnsupportedContractVersionError) {
      // Event payload version unsupported by catalog (Non-retryable)
      console.error(`Unsupported contract event version: ${error.version}`);
    } else if (error instanceof ContractEventError) {
      // Base contract event error (Non-retryable)
      console.error("Contract event decoding failed:", error.message);

    // ── Webhook Verification Errors ─────────────────────────────────────────
    } else if (error instanceof TalosWebhookError) {
      // Signature mismatch, expired timestamp, or replay detected (Non-retryable)
      console.error(`Webhook verification failed [${error.code}]: ${error.message}`);

    // ── Commerce & Seller Quote Errors ──────────────────────────────────────
    } else if (error instanceof SellerQuoteError) {
      // Seller quote construction validation failure (Non-retryable)
      console.error(`Seller quote invalid [${error.code}] on field "${error.field ?? "unknown"}": ${error.message}`);

    // ── SQLite Persistence Errors ───────────────────────────────────────────
    } else if (error instanceof SqliteSeenStoreError) {
      // Persistent seen-store database failure (Non-retryable)
      console.error(`SQLite seen store error [${error.code}]: ${error.message}`);

    // ── Chaos Testing Faults ────────────────────────────────────────────────
    } else if (error instanceof ChaosInjectedError) {
      // Synthetic chaos fault injected during testing
      console.info(`Chaos fault injected [${error.faultType}]: ${error.message}`);

    // ── Schema Drift Errors ─────────────────────────────────────────────────
    } else if (error instanceof DriftError) {
      // Request payload violated published server schema (Non-retryable)
      console.error(`Schema drift detected on route ${error.routeKey}:`, error.violations);

    // ── Standard Uncaught Errors ────────────────────────────────────────────
    } else if (error instanceof Error) {
      console.error("Standard error encountered:", error.message);
    } else {
      console.error("Unknown error value thrown:", error);
    }
  }
}

// ── 3. Example Execution ──────────────────────────────────────────────────────

async function main() {
  console.log("SDK Errors and Retries Example loaded.");
  console.log("Configured retryPolicy maxAttempts:", defaultStatusCodePolicy.maxAttempts);
  console.log("Configured typed retry maxAttempts:", defaultTypedRetryPolicy.maxAttempts);

  // Trigger error narrowing demonstration with a sample error
  await handleSdkError(async () => {
    throw new TalosRateLimitError(429, "Rate limit exceeded", "/api/talos", {
      retryAfterMs: 2_500,
      headers: {
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor((Date.now() + 2_500) / 1000)),
      },
    });
  });
}

if (process.argv[1]?.endsWith("08-error-handling-and-retries.ts")) {
  main().catch(console.error);
}
