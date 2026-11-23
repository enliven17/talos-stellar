/**
 * Webhook destination verification handshake.
 *
 * POST /api/webhooks/subscriptions/:id/verify
 *   Body (optional): { "token": "<challenge>" }
 *   - Without a token: re-sends a signed `endpoint.verification` challenge to
 *     the subscription URL (via the SSRF-guarded fetch). The destination must
 *     echo the challenge in a 2xx response to become verified.
 *   - With a token: completes an out-of-band verification using the challenge
 *     issued by the most recent failed handshake, before it expires.
 */

import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookSubscriptions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import {
  parseJsonBody,
  performDestinationHandshake,
  verifySubscriptionChallengeToken,
} from "@/lib/webhooks/verification";

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

const verifySchema = z.object({
  token: z.string().min(1).max(256).optional(),
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

    let token: string | undefined;
    const contentLength = request.headers.get("content-length");
    if (contentLength && contentLength !== "0") {
      const { data, error } = await parseJsonBody(request, verifySchema);
      if (error) return error;
      token = data.token;
    }

    const subscription = await db
      .select({
        id: tlsWebhookSubscriptions.id,
        url: tlsWebhookSubscriptions.url,
        secretCiphertext: tlsWebhookSubscriptions.secretCiphertext,
        signatureVersion: tlsWebhookSubscriptions.signatureVersion,
      })
      .from(tlsWebhookSubscriptions)
      .where(
        and(
          eq(tlsWebhookSubscriptions.id, id),
          eq(tlsWebhookSubscriptions.talosId, callerTalosId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!subscription) {
      return Response.json({ error: "Subscription not found" }, { status: 404 });
    }

    const result = token
      ? await verifySubscriptionChallengeToken({ subscriptionId: id, talosId: callerTalosId, token })
      : await performDestinationHandshake({
          subscriptionId: id,
          talosId: callerTalosId,
          url: subscription.url,
          secretCiphertext: subscription.secretCiphertext,
          signatureVersion: subscription.signatureVersion,
        });

    const body = {
      id,
      status: result.status,
      verifiedAt: result.verifiedAt ?? null,
      expiresAt: result.expiresAt ?? null,
      error: result.error ?? null,
    };
    return Response.json(body, { status: result.success ? 200 : 422 });
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "verify_webhook_destination_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRequestId(_POST);
