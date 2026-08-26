/* eslint-disable @typescript-eslint/no-explicit-any */
import { db as defaultDb } from "@/db";
import { logger } from "@/lib/logger";

export type TransactionCategory = "MONEY" | "TOKEN" | "PATRON" | "JOB" | "GENESIS";

export interface TransactionRetryOptions {
  category?: TransactionCategory;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  enabled?: boolean;
  dbInstance?: { transaction: (cb: (tx: any) => Promise<any>) => Promise<any> };
}

export class SerializationRetryExhaustedError extends Error {
  public readonly category: TransactionCategory;
  public readonly attempts: number;
  public readonly durationMs: number;
  public readonly originalError: unknown;

  constructor(category: TransactionCategory, attempts: number, durationMs: number, originalError: unknown) {
    const msg = (originalError as { message?: string })?.message ?? String(originalError);
    super(`Transaction retry exhausted for category ${category} after ${attempts} attempts (${durationMs}ms): ${msg}`);
    this.name = "SerializationRetryExhaustedError";
    this.category = category;
    this.attempts = attempts;
    this.durationMs = durationMs;
    this.originalError = originalError;
  }
}

const RETRYABLE_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "EHOSTUNREACH",
]);

/**
 * Classify whether an error is a retryable database error (serialization conflict,
 * deadlock, lock timeout, or transient database connection failure).
 */
export function isRetryableDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const errorObj = err as Record<string, unknown>;
  const code = String(errorObj.code ?? errorObj.sqlState ?? "");
  const causeCode = String((errorObj.cause as Record<string, unknown> | undefined)?.code ?? "");

  if (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_SQLSTATES.has(causeCode)) {
    return true;
  }

  if (RETRYABLE_NETWORK_CODES.has(code) || RETRYABLE_NETWORK_CODES.has(causeCode)) {
    return true;
  }

  const message = String(errorObj.message ?? "").toLowerCase();
  if (
    message.includes("serialization failure") ||
    message.includes("deadlock detected") ||
    message.includes("could not serialize access due to concurrent update") ||
    message.includes("could not serialize access due to read/write dependencies") ||
    message.includes("lock not available") ||
    message.includes("connection terminated") ||
    message.includes("connection closed") ||
    message.includes("connection refused")
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate exponential backoff delay with full jitter.
 */
export function calculateJitteredDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number
): number {
  const cappedAttempt = Math.min(attempt, 30);
  const exponential = initialDelayMs * Math.pow(2, cappedAttempt - 1);
  const capped = Math.min(maxDelayMs, exponential);
  return Math.floor(Math.random() * capped);
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return defaultValue;
  return val.toLowerCase() !== "false" && val !== "0";
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Executes a database transaction with bounded, jittered retries for
 * serialization conflicts and transient DB errors.
 */
export async function withTransactionRetry<T>(
  txCallback: (tx: any) => Promise<T>,
  options: TransactionRetryOptions = {}
): Promise<T> {
  const category = options.category ?? "JOB";
  const enabled = options.enabled ?? getEnvBoolean("DB_TRANSACTION_RETRY_ENABLED", true);
  const maxRetries = options.maxRetries ?? getEnvNumber("DB_TRANSACTION_RETRY_MAX_RETRIES", 5);
  const initialDelayMs = options.initialDelayMs ?? getEnvNumber("DB_TRANSACTION_RETRY_INITIAL_DELAY_MS", 50);
  const maxDelayMs = options.maxDelayMs ?? getEnvNumber("DB_TRANSACTION_RETRY_MAX_DELAY_MS", 1000);
  const database = options.dbInstance ?? defaultDb;

  if (!enabled) {
    return database.transaction(txCallback);
  }

  const startTime = Date.now();
  let attempt = 1;

  while (true) {
    try {
      const result = await database.transaction(txCallback);

      if (attempt > 1) {
        const durationMs = Date.now() - startTime;
        logger.info(
          {
            category,
            attempts: attempt,
            durationMs,
          },
          "db_transaction_retry_success"
        );
      }

      return result;
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const retryable = isRetryableDbError(err);
      const errObj = err as Record<string, unknown> | null;

      if (retryable && attempt <= maxRetries) {
        const delayMs = calculateJitteredDelay(attempt, initialDelayMs, maxDelayMs);
        const errorCode = String(
          errObj?.code ?? errObj?.sqlState ?? (errObj?.cause as Record<string, unknown> | undefined)?.code ?? "UNKNOWN"
        );

        logger.warn(
          {
            category,
            attempt,
            maxRetries,
            delayMs,
            durationMs,
            errorCode,
            errorMessage: errObj?.message ?? String(err),
          },
          "db_transaction_retry_attempt"
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt++;
      } else if (retryable && attempt > maxRetries) {
        const errorCode = String(
          errObj?.code ?? errObj?.sqlState ?? (errObj?.cause as Record<string, unknown> | undefined)?.code ?? "UNKNOWN"
        );

        logger.error(
          {
            category,
            attempts: attempt,
            maxRetries,
            durationMs,
            errorCode,
          },
          "db_transaction_retry_exhausted"
        );

        throw new SerializationRetryExhaustedError(category, attempt, durationMs, err);
      } else {
        throw err;
      }
    }
  }
}
