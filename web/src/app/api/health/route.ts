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

// Turbopack requires `runtime` to be a direct export — re-exports are rejected.
export const runtime = "nodejs";
export { GET } from "./ready/route";
