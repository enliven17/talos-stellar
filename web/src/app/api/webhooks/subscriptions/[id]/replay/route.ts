import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookSubscriptions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { parseBody } from "@/lib/schemas";
import { replayEvents } from "@/lib/webhooks/replay";

async function resolveCallerTalos(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const talos = await db
    .select({ id: tlsTalos.id })
    .from(tlsTalos)
    .where(eq(tlsTalos.apiKey, token))
    .limit(1)
    .then((r) => r[0] ?? null);
  return talos?.id ?? null;
}

const replaySchema = z
  .object({
    replayId: z.string().min(1, "replayId cannot be empty").max(100, "replayId too long"),
    startTime: z.string().datetime({ message: "Invalid ISO datetime for startTime" }),
    endTime: z.string().datetime({ message: "Invalid ISO datetime for endTime" }),
  })
  .refine((data) => new Date(data.startTime) <= new Date(data.endTime), {
    message: "startTime must be before or equal to endTime",
    path: ["startTime"],
  });

async function _POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    // Verify subscription belongs to caller
    const subscription = await db
      .select({ id: tlsWebhookSubscriptions.id })
      .from(tlsWebhookSubscriptions)
      .where(and(eq(tlsWebhookSubscriptions.id, id), eq(tlsWebhookSubscriptions.talosId, callerTalosId)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!subscription) {
      return Response.json({ error: "Subscription not found" }, { status: 404 });
    }

    const { data, error } = await parseBody(request, replaySchema);
    if (error) return error;

    const result = await replayEvents(
      id,
      new Date(data.startTime),
      new Date(data.endTime),
      data.replayId,
    );

    return Response.json({ replayed: result.replayedCount }, { status: 202 });
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "webhook_replay_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRequestId(_POST);
