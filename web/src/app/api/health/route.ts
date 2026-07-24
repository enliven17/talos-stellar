/**
 * GET /api/health — Backward-compatible alias for the readiness probe.
 *
 * Delegates to GET /api/health/ready.  Existing monitors wired to this
 * URL continue to work without reconfiguration.
 *
 * Prefer the explicit sub-paths for new integrations:
 *   GET /api/health/live   — liveness  (process alive, no I/O)
 *   GET /api/health/ready  — readiness (DB + Stellar checks)
 */

export { runtime, GET } from "./ready/route";
