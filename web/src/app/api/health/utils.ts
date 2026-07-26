/**
 * Shared utilities for health probe routes.
 *
 * withTimeout wraps any promise and rejects after `ms` milliseconds.
 * It clears its own timer on both resolution and rejection so it never
 * leaks a dangling timer handle.
 */

export const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

/** DB check timeout — 2 s */
export const DB_TIMEOUT_MS = 2_000;

/** Stellar Horizon check timeout — 3 s */
export const STELLAR_TIMEOUT_MS = 3_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}
