/**
 * Horizon polling layer for the finality reconciler.
 *
 * Responsibilities:
 *   - Fetch a single transaction by hash from Horizon.
 *   - Fetch the current ledger sequence number.
 *   - Normalise all Horizon responses into the HorizonPollResult discriminated
 *     union so the state machine never touches raw SDK types.
 *   - Classify errors as retryable (transient) vs. non-retryable (permanent).
 *
 * This module performs I/O but contains no DB writes and no state-machine
 * logic.  It can be fully mocked in unit tests.
 */

import type {
  HorizonPollResult,
  HorizonProviderFailureReasonCode,
  HorizonFailureCategory,
} from "./types";

// ─── Horizon error type helpers ───────────────────────────────────────────────

/** Horizon SDK throws objects with a `response.status` field for HTTP errors. */
export function extractHttpStatus(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "response" in err &&
    err.response &&
    typeof err.response === "object" &&
    "status" in err.response
  ) {
    const status = (err.response as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Classify a Horizon error into a bounded, stable provider failure reason code.
 *
 * Mappings:
 * - 401 -> UNAUTHORIZED (authorization)
 * - 403 -> FORBIDDEN (authorization)
 * - 429 -> RATE_LIMITED (throttling)
 * - 503 -> PROVIDER_UNAVAILABLE (provider failure)
 * - 502 -> BAD_GATEWAY (provider failure)
 * - 504 -> GATEWAY_TIMEOUT (provider failure)
 * - 500 / other 5xx -> PROVIDER_ERROR (provider failure)
 * - 400 -> BAD_REQUEST (client error)
 * - null (network failure, connection reset, timeout) -> NETWORK_ERROR (provider failure)
 * - fallback -> UNKNOWN
 */
export function classifyHorizonError(
  err: unknown,
  httpStatus?: number | null,
): HorizonProviderFailureReasonCode {
  const status = httpStatus !== undefined ? httpStatus : extractHttpStatus(err);

  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "PROVIDER_UNAVAILABLE";
  if (status === 502) return "BAD_GATEWAY";
  if (status === 504) return "GATEWAY_TIMEOUT";
  if (typeof status === "number" && status >= 500 && status < 600) return "PROVIDER_ERROR";
  if (status === 400) return "BAD_REQUEST";

  const message = extractErrorMessage(err).toLowerCase();
  if (message.includes("401") || message.includes("unauthorized")) {
    return "UNAUTHORIZED";
  }
  if (message.includes("403") || message.includes("forbidden")) {
    return "FORBIDDEN";
  }
  if (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("throttl")
  ) {
    return "RATE_LIMITED";
  }
  if (message.includes("503") || message.includes("service unavailable")) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (message.includes("504") || message.includes("gateway timeout")) {
    return "GATEWAY_TIMEOUT";
  }
  if (message.includes("502") || message.includes("bad gateway")) {
    return "BAD_GATEWAY";
  }
  if (message.includes("500") || message.includes("internal server error")) {
    return "PROVIDER_ERROR";
  }
  if (
    status === null ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("abort")
  ) {
    return "NETWORK_ERROR";
  }

  return "UNKNOWN";
}

/**
 * Return the broad category for a provider failure reason code.
 */
export function getFailureCategory(
  reasonCode: HorizonProviderFailureReasonCode | string | undefined | null,
): HorizonFailureCategory {
  if (!reasonCode) return "unknown";
  switch (reasonCode) {
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "AUTHORIZATION_FAILURE":
      return "authorization";
    case "RATE_LIMITED":
    case "THROTTLED":
      return "throttling";
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_ERROR":
    case "PROVIDER_FAILURE":
    case "SERVER_ERROR":
    case "BAD_GATEWAY":
    case "GATEWAY_TIMEOUT":
    case "NETWORK_ERROR":
      return "provider_failure";
    default:
      return "unknown";
  }
}

/**
 * Returns true if the reason code or poll result represents an authorization failure.
 */
export function isAuthorizationFailure(
  reasonCodeOrPoll: HorizonProviderFailureReasonCode | HorizonPollResult | string | undefined | null,
): boolean {
  const code =
    typeof reasonCodeOrPoll === "object" && reasonCodeOrPoll !== null
      ? (reasonCodeOrPoll.outcome === "error" ? reasonCodeOrPoll.reasonCode : undefined)
      : reasonCodeOrPoll;
  return getFailureCategory(code) === "authorization";
}

/**
 * Returns true if the reason code or poll result represents a throttling / rate limit failure.
 */
export function isThrottlingFailure(
  reasonCodeOrPoll: HorizonProviderFailureReasonCode | HorizonPollResult | string | undefined | null,
): boolean {
  const code =
    typeof reasonCodeOrPoll === "object" && reasonCodeOrPoll !== null
      ? (reasonCodeOrPoll.outcome === "error" ? reasonCodeOrPoll.reasonCode : undefined)
      : reasonCodeOrPoll;
  return getFailureCategory(code) === "throttling";
}

/**
 * Returns true if the reason code or poll result represents an upstream provider or network failure.
 */
export function isProviderFailure(
  reasonCodeOrPoll: HorizonProviderFailureReasonCode | HorizonPollResult | string | undefined | null,
): boolean {
  const code =
    typeof reasonCodeOrPoll === "object" && reasonCodeOrPoll !== null
      ? (reasonCodeOrPoll.outcome === "error" ? reasonCodeOrPoll.reasonCode : undefined)
      : reasonCodeOrPoll;
  return getFailureCategory(code) === "provider_failure";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Poll Horizon for the status of a single transaction.
 *
 * @param txHash   The Stellar transaction hash (64 hex chars).
 * @param horizonUrl  Base URL of the Horizon server.
 * @returns A normalised HorizonPollResult, never throws.
 */
export async function pollTransaction(
  txHash: string,
  horizonUrl: string,
): Promise<HorizonPollResult> {
  try {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const server = new Horizon.Server(horizonUrl);
    const tx = await server.transactions().transaction(txHash).call();

    const ledger: number =
      typeof tx.ledger === "number"
        ? tx.ledger
        : parseInt(String(tx.ledger), 10);

    if (tx.successful) {
      return { outcome: "confirmed", ledger, successful: true };
    } else {
      // Transaction was included in a ledger but the operation set failed
      // (e.g. insufficient balance, bad sequence number already applied).
      const detail = extractResultCode(tx);
      return { outcome: "failed", ledger, successful: false, detail };
    }
  } catch (err) {
    const httpStatus = extractHttpStatus(err);

    if (httpStatus === 404) {
      // Transaction not yet on chain (or was never submitted)
      return { outcome: "not_found" };
    }

    // 429 rate-limit or 5xx transient: retryable
    const retryable =
      httpStatus === null || httpStatus === 429 || httpStatus >= 500;

    const reasonCode = classifyHorizonError(err, httpStatus);

    return {
      outcome: "error",
      message: extractErrorMessage(err),
      retryable,
      reasonCode,
    };
  }
}

/**
 * Fetch the current ledger sequence number from Horizon.
 *
 * Returns null on any error so callers can decide whether to skip the tick.
 */
export async function fetchCurrentLedger(horizonUrl: string): Promise<number | null> {
  try {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const server = new Horizon.Server(horizonUrl);
    const ledger = await server.ledgers().order("desc").limit(1).call();
    const record = ledger.records[0];
    if (!record) return null;
    const seq =
      typeof record.sequence === "number"
        ? record.sequence
        : parseInt(String(record.sequence), 10);
    return Number.isNaN(seq) ? null : seq;
  } catch {
    return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Try to extract a human-readable result code from a failed transaction
 * response.  Horizon returns XDR result codes in envelope extras.
 *
 * We return only non-sensitive diagnostic info (transaction-level result code).
 */
function extractResultCode(tx: object): string {
  try {
    // Horizon includes `result_meta_xdr`; for result codes look at extras
    const extras = (tx as { extras?: { result_codes?: { transaction?: string } } }).extras;
    return extras?.result_codes?.transaction ?? "tx_failed";
  } catch {
    return "tx_failed";
  }
}
