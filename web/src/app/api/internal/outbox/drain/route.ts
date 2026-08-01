import { NextRequest } from "next/server";
import { verifyInternalSecret } from "@/lib/admin-auth";
import { dispatchOnce, outboxConfig } from "@/lib/outbox";
// Side-effect import: registers every outbox consumer. Required here (and
// only here / in the worker script) because this route actually dispatches
// events — writeOutboxEvent()-only call sites don't need the registry.
import "@/lib/outbox/consumers";

/**
 * POST /api/internal/outbox/drain
 *
 * Leases and dispatches one bounded batch of due events, then returns.
 * Meant to be hit on an interval by an external scheduler (Vercel Cron, a
 * Railway cron service, etc.) — see web/OUTBOX.md. For a long-lived
 * deployment, scripts/outbox-worker.ts runs the same dispatchOnce() in a
 * continuous loop instead.
 *
 * No-op (200, summary:null) when OUTBOX_ENABLED is false.
 */
export async function POST(request: NextRequest) {
  const auth = verifyInternalSecret(request, "OUTBOX_DISPATCH_SECRET", "x-outbox-dispatch-secret");
  if (!auth.ok) return auth.response;

  if (!outboxConfig.enabled) {
    return Response.json({ enabled: false, summary: null });
  }

  try {
    const summary = await dispatchOnce();
    return Response.json({ enabled: true, summary });
  } catch (err) {
    console.error("[internal/outbox/drain POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
