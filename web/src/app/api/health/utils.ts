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