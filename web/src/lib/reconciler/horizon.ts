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

import type { HorizonPollResult } from "./types";

// ─── Horizon error type helpers ───────────────────────────────────────────────

/** Horizon SDK throws objects with a `response.status` field for HTTP errors. */
function extractHttpStatus(err: unknown): number | null {
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

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
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

    return {
      outcome: "error",
      message: extractErrorMessage(err),
      retryable,
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
function extractResultCode(tx: { result_meta_xdr?: unknown; [key: string]: unknown }): string {
  try {
    // Horizon includes `result_meta_xdr`; for result codes look at extras
    const extras = (tx as { extras?: { result_codes?: { transaction?: string } } }).extras;
    return extras?.result_codes?.transaction ?? "tx_failed";
  } catch {
    return "tx_failed";
  }
}
