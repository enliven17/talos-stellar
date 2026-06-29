import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsApprovals, tlsActivities } from "@/db/schema";
import { desc, eq, inArray, or } from "drizzle-orm";
import {
  acquireConnection,
  releaseConnection,
  recordDbQueries,
} from "@/lib/sse-pool";

export { getSseMetrics } from "@/lib/sse-pool";

/**
 * GET /api/events?wallet=G...
 *
 * Server-Sent Events stream for real-time dashboard updates.
 * The browser keeps one persistent connection; the server pushes events when
 * new approvals or activities appear for the given wallet.
 *
 * ── Vercel / serverless deployment constraint ─────────────────────────────
 * Vercel serverless functions have a hard execution-time limit (300 s on Pro,
 * 60 s on Hobby). A long-lived SSE connection will be forcibly killed when that
 * limit is reached, causing the browser to reconnect and restart the stream.
 *
 * Two recommended alternatives when Vercel's limit becomes a problem:
 *
 *   Option A — persistent service (best real-time fidelity)
 *     Move this endpoint to Railway or Fly.io where connections live as long
 *     as the process. Costs ~$5–10/mo for a 512 MB container and removes all
 *     timeout concerns. The rest of the Next.js app stays on Vercel.
 *
 *   Option B — short-poll + ETag (simplest, zero extra infra)
 *     Replace with GET /api/events/poll that returns 304 Not Modified when
 *     nothing changed. Clients poll every 10–15 s. Slightly lower real-time
 *     fidelity but fully serverless-compatible and eliminates the connection-
 *     count problem entirely.
 *
 * The SSE_MAX_CONNECTIONS env var caps active connections per process (default
 * 200). On multi-container Vercel deployments, each container enforces its own
 * cap independently — total fleet capacity = cap × container_count.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Events emitted:
 *   "ping"     — keepalive / zombie probe (every 30 s)
 *   "update"   — new activities detected
 *   "approval" — pending approval added or resolved
 */

const POLL_INTERVAL_MS = 8_000;
const PING_INTERVAL_MS = 30_000;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return new Response("wallet parameter required", { status: 400 });
  }

  // Reject before allocating any resources when the pool is full.
  if (!acquireConnection()) {
    return new Response("Too many SSE connections — retry later", {
      status: 503,
      headers: { "Retry-After": "10", "Content-Type": "text/plain" },
    });
  }

  const walletAddr = wallet;

  // Resolve TALOS IDs once per connection, not on every poll tick.
  //
  // The original implementation called this inside setInterval, running two DB
  // queries per client every 8 s. At 50 concurrent users that is 750 DB queries
  // per minute for an ID lookup whose result is stable for the session lifetime.
  // Now it runs exactly 2 queries per connection — at connection open only.
  async function fetchTalosIds(): Promise<string[]> {
    recordDbQueries(2);
    const [patronRows, ownerRows] = await Promise.all([
      db
        .select({ talosId: tlsPatrons.talosId })
        .from(tlsPatrons)
        .where(eq(tlsPatrons.stellarPublicKey, walletAddr)),
      db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(
          or(
            eq(tlsTalos.walletPublicKey, walletAddr),
            eq(tlsTalos.creatorPublicKey, walletAddr),
            eq(tlsTalos.investorPublicKey, walletAddr),
            eq(tlsTalos.treasuryPublicKey, walletAddr),
          ),
        ),
    ]);

    return [
      ...new Set([
        ...patronRows.map((r) => r.talosId),
        ...ownerRows.map((r) => r.id),
      ]),
    ];
  }

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      function send(event: string, data: unknown): boolean {
        if (isClosed) return false;
        try {
          controller.enqueue(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          );
          return true;
        } catch {
          return false;
        }
      }

      function cleanup() {
        if (isClosed) return;
        isClosed = true;
        releaseConnection();
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        try {
          controller.close();
        } catch {
          // Already closed — safe to ignore.
        }
      }

      // Register the abort listener before the first await so that a disconnect
      // that arrives while fetchTalosIds() is running is caught immediately. If
      // it were registered after the await, any abort that fired in the meantime
      // would be silently dropped and the connection slot would never be released.
      request.signal.addEventListener("abort", cleanup);

      send("ping", { ts: Date.now() });

      let talosIds: string[];
      try {
        talosIds = await fetchTalosIds();
      } catch (err) {
        console.warn("[SSE] failed to resolve talosIds on connect:", err);
        cleanup();
        return;
      }

      // The client may have disconnected while fetchTalosIds() was in flight.
      if (isClosed) return;

      // talosIds is now fixed for this connection's lifetime. If a wallet gains
      // or loses TALOS access mid-session, the browser must reconnect to pick up
      // the change (explicit invalidation is not yet implemented).

      let lastApprovalAt = new Date();
      let lastActivityAt = new Date();

      async function poll() {
        if (isClosed || talosIds.length === 0) return;

        const approvalFilter =
          talosIds.length === 1
            ? eq(tlsApprovals.talosId, talosIds[0])
            : inArray(tlsApprovals.talosId, talosIds);

        const activityFilter =
          talosIds.length === 1
            ? eq(tlsActivities.talosId, talosIds[0])
            : inArray(tlsActivities.talosId, talosIds);

        try {
          recordDbQueries(2);
          const [newApprovals, newActivities] = await Promise.all([
            db
              .select({ id: tlsApprovals.id, createdAt: tlsApprovals.createdAt })
              .from(tlsApprovals)
              .where(approvalFilter)
              .orderBy(desc(tlsApprovals.createdAt))
              .limit(1),
            db
              .select({ id: tlsActivities.id, createdAt: tlsActivities.createdAt })
              .from(tlsActivities)
              .where(activityFilter)
              .orderBy(desc(tlsActivities.createdAt))
              .limit(1),
          ]);

          if (newApprovals[0] && newApprovals[0].createdAt > lastApprovalAt) {
            lastApprovalAt = newApprovals[0].createdAt;
            send("approval", { talosIds });
            send("update", { reason: "approval" });
          }

          if (newActivities[0] && newActivities[0].createdAt > lastActivityAt) {
            lastActivityAt = newActivities[0].createdAt;
            send("update", { reason: "activity" });
          }
        } catch (err) {
          console.warn("[SSE] poll error:", err);
        }
      }

      pollTimer = setInterval(poll, POLL_INTERVAL_MS);

      // Ping doubles as a zombie-connection probe. When a client disconnects
      // behind a proxy that doesn't relay the TCP RST, `request.signal` never
      // fires "abort". Attempting to write to the closed stream will throw
      // (or return false from send()), at which point we clean up immediately
      // rather than leaking the connection for the rest of the process lifetime.
      // Worst-case detection latency with this approach is PING_INTERVAL_MS (30 s).
      pingTimer = setInterval(() => {
        if (!send("ping", { ts: Date.now() })) cleanup();
      }, PING_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
