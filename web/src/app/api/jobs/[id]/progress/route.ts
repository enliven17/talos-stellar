import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs } from "@/db/schema";
import { resolveTalosFromRequest } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { parseBody, reportJobProgressSchema } from "@/lib/schemas";
import {
  acquireConnection,
  releaseConnection,
  recordDbQueries,
} from "@/lib/sse-pool";
import {
  jobProgressFingerprint,
  sanitizeProgressInput,
  toPublicJobProgressView,
  TERMINAL_JOB_STATUSES,
} from "@/lib/job-progress";
import { withTraceContext } from "@/lib/tracing";

/**
 * GET  /api/jobs/:id/progress — SSE stream of job progress for authenticated clients
 * POST /api/jobs/:id/progress — provider reports mid-job progress (percent/stage/message)
 *
 * Auth: Bearer TALOS API key with commerce:read (GET) / commerce:write (POST).
 * Authorization: caller must be the provider (`talosId`) or requester (`requesterTalosId`).
 *
 * Events (GET):
 *   ping      — keepalive
 *   snapshot  — initial privacy-safe job view
 *   progress  — status / lease / progress / result changed
 *   done      — terminal status reached (stream closes after this)
 *
 * Privacy: paymentSig, payload, idempotency caches, and sensitive result keys
 * are never emitted. Progress messages matching secret-like patterns are redacted.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 2_000;
const PING_INTERVAL_MS = 15_000;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 500;

function resolveLimit(
  value: string | null,
): { ok: true; limit: number } | { ok: false; message: string } {
  if (value === null) return { ok: true, limit: DEFAULT_EVENT_LIMIT };
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  const parsed = Number(value);
  if (parsed === 0) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  if (parsed > MAX_EVENT_LIMIT) {
    return { ok: false, message: `limit must not exceed ${MAX_EVENT_LIMIT}` };
  }
  return { ok: true, limit: parsed };
}

function isAuthorizedViewer(
  callerTalosId: string,
  job: { talosId: string; requesterTalosId: string },
): boolean {
  return callerTalosId === job.talosId || callerTalosId === job.requesterTalosId;
}

async function loadJob(id: string) {
  recordDbQueries(1);
  return db
    .select({
      id: tlsCommerceJobs.id,
      status: tlsCommerceJobs.status,
      talosId: tlsCommerceJobs.talosId,
      requesterTalosId: tlsCommerceJobs.requesterTalosId,
      serviceName: tlsCommerceJobs.serviceName,
      leasedBy: tlsCommerceJobs.leasedBy,
      leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt,
      fencingToken: tlsCommerceJobs.fencingToken,
      progress: tlsCommerceJobs.progress,
      result: tlsCommerceJobs.result,
      updatedAt: tlsCommerceJobs.updatedAt,
      createdAt: tlsCommerceJobs.createdAt,
    })
    .from(tlsCommerceJobs)
    .where(eq(tlsCommerceJobs.id, id))
    .limit(1)
    .then((r) => r[0] ?? null);
}

async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await resolveTalosFromRequest(request, ["commerce:read"]);
  if (!auth.ok) return auth.response;
  const callerTalosId = auth.talos.id;

  const limitResult = resolveLimit(request.nextUrl.searchParams.get("limit"));
  if (!limitResult.ok) {
    return new Response(limitResult.message, { status: 400 });
  }
  const eventLimit = limitResult.limit;

  // Authz before allocating an SSE slot.
  const initial = await loadJob(id);
  if (!initial) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }
  if (!isAuthorizedViewer(callerTalosId, initial)) {
    return Response.json({ error: "Not authorized to view this job" }, { status: 403 });
  }

  if (!acquireConnection()) {
    return new Response("Too many SSE connections — retry later", {
      status: 503,
      headers: { "Retry-After": "10", "Content-Type": "text/plain" },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      let eventsSent = 0;
      let lastFingerprint = "";

      const pollTimer = setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);
      const pingTimer = setInterval(() => {
        if (!send("ping", { ts: Date.now() })) cleanup();
      }, PING_INTERVAL_MS);

      function send(event: string, data: unknown): boolean {
        if (isClosed || eventsSent >= eventLimit) return false;
        try {
          controller.enqueue(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          );
          eventsSent++;
          if (eventsSent >= eventLimit) cleanup();
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
          // already closed
        }
      }

      request.signal.addEventListener("abort", cleanup);

      function emitView(
        job: NonNullable<Awaited<ReturnType<typeof loadJob>>>,
        eventName: "snapshot" | "progress",
      ) {
        const view = toPublicJobProgressView(job);
        const fp = jobProgressFingerprint(view);
        if (eventName === "progress" && fp === lastFingerprint) return;
        lastFingerprint = fp;
        send(eventName, view);
        if (TERMINAL_JOB_STATUSES.has(view.status)) {
          send("done", { id: view.id, status: view.status });
          cleanup();
        }
      }

      // Immediate snapshot from the pre-authz load (may be slightly stale — first
      // poll reconciles). Avoids an extra DB round-trip before the stream opens.
      emitView(initial, "snapshot");
      if (isClosed) return;

      async function poll() {
        if (isClosed) return;
        try {
          const job = await loadJob(id);
          if (!job) {
            send("error", { error: "Job not found" });
            cleanup();
            return;
          }
          if (!isAuthorizedViewer(callerTalosId, job)) {
            send("error", { error: "Not authorized to view this job" });
            cleanup();
            return;
          }
          emitView(job, "progress");
        } catch (err) {
          logger.warn({ jobId: id, err }, "job_progress_sse_poll_error");
        }
      }
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

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await resolveTalosFromRequest(request, ["commerce:write"]);
    if (!auth.ok) return auth.response;
    const callerTalosId = auth.talos.id;

    const { data, error } = await parseBody(request, reportJobProgressSchema);
    if (error) return error;

    if (
      data.percent === undefined &&
      data.stage === undefined &&
      data.message === undefined
    ) {
      return Response.json(
        { error: "At least one of percent, stage, or message is required" },
        { status: 400 },
      );
    }

    const job = await db
      .select()
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    // Only the provider agent may publish progress.
    if (job.talosId !== callerTalosId) {
      return Response.json(
        { error: "Not authorized to report progress for this job" },
        { status: 403 },
      );
    }

    if (job.status === "completed") {
      return Response.json(
        { error: "Job already completed" },
        { status: 409 },
      );
    }

    // If leased by another live worker, reject.
    if (
      job.leasedBy &&
      job.leasedBy !== callerTalosId &&
      job.leaseExpiresAt &&
      job.leaseExpiresAt > new Date()
    ) {
      return Response.json(
        {
          error: "Job is leased by another worker",
          detail: "Only the current lease holder may report progress",
        },
        { status: 409 },
      );
    }

    if (
      data.fencingToken !== undefined &&
      data.fencingToken !== job.fencingToken
    ) {
      return Response.json(
        {
          error: "Fencing token mismatch",
          detail:
            "Re-acquire a lease via POST /api/jobs/:id/claim before reporting progress",
        },
        { status: 409 },
      );
    }

    const sanitized = sanitizeProgressInput(data);
    const progress = {
      ...sanitized,
      updatedAt: new Date().toISOString(),
      reportedBy: callerTalosId,
    };

    const whereClause =
      data.fencingToken !== undefined
        ? and(
            eq(tlsCommerceJobs.id, id),
            eq(tlsCommerceJobs.talosId, callerTalosId),
            eq(tlsCommerceJobs.status, "pending"),
            eq(tlsCommerceJobs.fencingToken, data.fencingToken),
          )
        : and(
            eq(tlsCommerceJobs.id, id),
            eq(tlsCommerceJobs.talosId, callerTalosId),
            eq(tlsCommerceJobs.status, "pending"),
          );

    const [updated] = await db
      .update(tlsCommerceJobs)
      .set({ progress })
      .where(whereClause)
      .returning({
        id: tlsCommerceJobs.id,
        status: tlsCommerceJobs.status,
        progress: tlsCommerceJobs.progress,
        fencingToken: tlsCommerceJobs.fencingToken,
        updatedAt: tlsCommerceJobs.updatedAt,
      });

    if (!updated) {
      return Response.json(
        {
          error: "Unable to update progress",
          detail: "Job may have completed or fencing token is stale",
        },
        { status: 409 },
      );
    }

    logger.info(
      {
        jobId: id,
        talosId: callerTalosId,
        percent: sanitized.percent,
        stage: sanitized.stage,
      },
      "job_progress_reported",
    );

    return Response.json({
      id: updated.id,
      status: updated.status,
      progress: updated.progress,
      fencingToken: updated.fencingToken,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    logger.error({ jobId: id, err }, "report_job_progress_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
export const POST = withTraceContext(handlePost);
