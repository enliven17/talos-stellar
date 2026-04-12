import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsApprovals, tlsActivities } from "@/db/schema";
import { desc, eq, gt, or, sql, inArray } from "drizzle-orm";

/**
 * GET /api/events?wallet=G...
 *
 * Server-Sent Events stream for real-time dashboard updates.
 * Replaces manual polling — the browser keeps one persistent connection.
 *
 * Events emitted:
 *   - "ping"      — keepalive every 15 s (prevents proxy timeouts)
 *   - "update"    — when new approvals or activities appear
 *   - "approval"  — when a pending approval is added/resolved
 *
 * The client calls refetch() on any "update" or "approval" event.
 */

const POLL_INTERVAL_MS = 8_000;  // check DB every 8 s
const KEEPALIVE_MS     = 15_000; // ping every 15 s

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return new Response("wallet parameter required", { status: 400 });
  }

  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        if (isClosed) return;
        try {
          controller.enqueue(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          );
        } catch {
          // Controller may already be closed
        }
      }

      // Send initial ping so the client knows the connection is live
      send("ping", { ts: Date.now() });

      // wallet is guaranteed non-null (checked above); cast to satisfy Drizzle's
      // nullable-column overloads which require `string` not `string | null`.
      const walletAddr: string = wallet;

      // Resolve TALOS IDs for this wallet (owner or patron)
      async function getTalosIds(): Promise<string[]> {
        const patronRows = await db
          .select({ talosId: tlsPatrons.talosId })
          .from(tlsPatrons)
          .where(eq(tlsPatrons.stellarPublicKey, walletAddr));

        const patronIds = patronRows.map((r) => r.talosId);

        const ownerRows = await db
          .select({ id: tlsTalos.id })
          .from(tlsTalos)
          .where(
            or(
              eq(tlsTalos.walletPublicKey, walletAddr),
              eq(tlsTalos.creatorPublicKey, walletAddr),
              eq(tlsTalos.investorPublicKey, walletAddr),
              eq(tlsTalos.treasuryPublicKey, walletAddr),
            ),
          );

        const ownerIds = ownerRows.map((r) => r.id);
        return [...new Set([...patronIds, ...ownerIds])];
      }

      // Track the latest seen timestamps per entity
      let lastApprovalAt = new Date();
      let lastActivityAt = new Date();
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      async function poll() {
        if (isClosed) return;
        try {
          const talosIds = await getTalosIds();
          if (talosIds.length === 0) return;

          // Check for new pending approvals
          const newApprovals = await db
            .select({ id: tlsApprovals.id, createdAt: tlsApprovals.createdAt })
            .from(tlsApprovals)
            .where(
              talosIds.length === 1
                ? eq(tlsApprovals.talosId, talosIds[0])
                : inArray(tlsApprovals.talosId, talosIds),
            )
            .orderBy(desc(tlsApprovals.createdAt))
            .limit(1);

          if (newApprovals[0] && newApprovals[0].createdAt > lastApprovalAt) {
            lastApprovalAt = newApprovals[0].createdAt;
            send("approval", { talosIds });
            send("update", { reason: "approval" });
          }

          // Check for new activities
          const newActivities = await db
            .select({ id: tlsActivities.id, createdAt: tlsActivities.createdAt })
            .from(tlsActivities)
            .where(
              talosIds.length === 1
                ? eq(tlsActivities.talosId, talosIds[0])
                : inArray(tlsActivities.talosId, talosIds),
            )
            .orderBy(desc(tlsActivities.createdAt))
            .limit(1);

          if (newActivities[0] && newActivities[0].createdAt > lastActivityAt) {
            lastActivityAt = newActivities[0].createdAt;
            send("update", { reason: "activity" });
          }
        } catch (err) {
          // DB error — silently continue; don't crash the stream
          console.warn("[SSE] poll error:", err);
        }
      }

      // Start poll loop
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);

      // Keepalive ping
      pingTimer = setInterval(() => {
        send("ping", { ts: Date.now() });
      }, KEEPALIVE_MS);

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        isClosed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (pingTimer) clearInterval(pingTimer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
