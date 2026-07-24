/**
 * Reconciler configuration — resolved once at module load from env vars.
 *
 * All env vars are optional with safe defaults so the reconciler can be
 * deployed without extra configuration.  Set RECONCILER_ENABLED=true to
 * activate the background loop.
 */
import type { ReconcilerConfig } from "./types";

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`[reconciler] Invalid value for ${key}: "${raw}" — must be a positive integer`);
  }
  return parsed;
}

export function loadReconcilerConfig(): ReconcilerConfig {
  return {
    enabled: process.env.RECONCILER_ENABLED === "true",

    pollIntervalMs: parseIntEnv("RECONCILER_POLL_INTERVAL_MS", 30_000),

    maxLedgerGap: parseIntEnv("RECONCILER_MAX_LEDGER_GAP", 120),

    notFoundThreshold: parseIntEnv("RECONCILER_NOT_FOUND_THRESHOLD", 10),

    batchSize: parseIntEnv("RECONCILER_BATCH_SIZE", 50),

    horizonUrl:
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",

    confirmationDepth: parseIntEnv("RECONCILER_CONFIRMATION_DEPTH", 1),
  };
}

/** Singleton config — call loadReconcilerConfig() once at startup. */
export const reconcilerConfig: ReconcilerConfig = loadReconcilerConfig();
