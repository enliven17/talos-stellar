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

export const DEFAULT_HORIZON = "https://horizon.stellar.org";
export const DB_TIMEOUT_MS = 2000;
export const STELLAR_TIMEOUT_MS = 3000;

export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);

    Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
