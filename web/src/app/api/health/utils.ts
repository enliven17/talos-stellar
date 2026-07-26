/**
 * Shared utilities for health probe routes.
 *
 * withTimeout wraps any promise-producing function and rejects after `ms`
 * milliseconds.  It propagates an `AbortSignal` to the caller so that
 * in-flight I/O (e.g. `fetch`) can be *actively cancelled* on timeout
 * instead of continuing in the background.
 *
 * The timer handle is cleared on every code path (resolve, reject, timeout)
 * so no dangling timer is ever leaked.
 */

export const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

/** DB check timeout — 2 s */
export const DB_TIMEOUT_MS = 2_000;

/** Stellar Horizon check timeout — 3 s */
export const STELLAR_TIMEOUT_MS = 3_000;

export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort(new Error("timeout"));
      reject(new Error("timeout"));
    }, ms);
  });

  const main = Promise.race([fn(controller.signal), timeout]).finally(() => {
    clearTimeout(timerId);
    if (!controller.signal.aborted) {
      controller.abort();
    }
  });

  return main;
}
