/**
 * Side-effect import: registers every job handler. Anything that leases and
 * runs jobs (the drain route, the worker script) must import this before
 * calling runOnce() — enqueue-only callers (e.g. auth.ts) don't need it.
 */
import "./audit-log";
