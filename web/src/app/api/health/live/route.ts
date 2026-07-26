/**
 * GET /api/health/live — Liveness probe
 *
 * Answers the single question: "Is the Node.js process alive?"
 * It performs NO external I/O — no DB query, no Horizon call.
 *
 * Use this probe for:
 *   - Kubernetes livenessProbe (restart the container when this fails)
 *   - Docker HEALTHCHECK as a cheap process-alive signal
 *
 * A liveness failure means the process itself is broken; the orchestrator
 * should restart it.  Dependency failures belong in the readiness probe
 * (GET /api/health/ready) and must NOT affect liveness.
 *
 * Response shape:
 *   200  { status: "ok",   uptime: <seconds>, ts: <ISO-8601> }
 *
 * Headers:
 *   Cache-Control: no-store   (never cache health responses)
 */

export const runtime = "nodejs";

export function GET() {
  return Response.json(
    {
      status: "ok",
      uptime: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
