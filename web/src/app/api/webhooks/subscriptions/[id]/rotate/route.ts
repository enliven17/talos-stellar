/**
 * Webhook signing-secret rotation API.
 *
 * POST /api/webhooks/subscriptions/:id/rotate
 *   Rotate the signing secret with a grace window (dual-sign, no downtime).
 *   Body: { secret?: string, generate?: boolean, graceSeconds?: number }
 *   When generate=true, the new plaintext secret is returned once.
 *
 * POST /api/webhooks/subscriptions/:id/rotate  with { finalize: true }
 *   Clear the previous secret early once consumers have switched.
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { parseBody } from "@/lib/schemas";
import {
  finalizeWebhookSecretRotation,
  rotateWebhookSecret,
} from "@/lib/webhooks/rotation";

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

const rotateSchema = z
  .object({
    secret: z.string().min(16).max(256).optional(),
    generate: z.boolean().optional(),
    graceSeconds: z.number().int().optional(),
    finalize: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.finalize) return true;
      return Boolean(data.generate) || Boolean(data.secret);
    },
    { message: "Provide secret, generate=true, or finalize=true" },
  )
  .refine(
    (data) => !(data.finalize && (data.secret || data.generate)),
    { message: "finalize cannot be combined with secret/generate" },
  );

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, rotateSchema);
    if (error) return error;

    if (data.finalize) {
      const result = await finalizeWebhookSecretRotation({
        subscriptionId: id,
        talosId: callerTalosId,
      });
      if ("error" in result) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result);
    }

    const result = await rotateWebhookSecret({
      subscriptionId: id,
      talosId: callerTalosId,
      newSecret: data.secret,
      generate: data.generate,
      graceSeconds: data.graceSeconds,
    });

    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json(result, { status: 200 });
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "webhook_secret_rotate_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
