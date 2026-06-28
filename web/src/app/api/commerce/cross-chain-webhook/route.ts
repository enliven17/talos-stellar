import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs, tlsCommerceServices, tlsRevenues, tlsTalos } from "@/db/schema";
import { fulfillInstant } from "@/lib/fulfillment";
import { crossChainWebhookSchema } from "@/lib/schemas";

function normalizeChain(chain: string) {
  return chain.trim().toLowerCase();
}

function buildPaymentSignature(sourceChain: string, paymentReference: string) {
  return `crosschain:${normalizeChain(sourceChain)}:${paymentReference}`;
}

function parseSignature(header: string | null) {
  if (!header) return null;
  return header.trim().replace(/^sha256=/i, "");
}

function isValidWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string) {
  const providedSignature = parseSignature(signatureHeader);
  if (!providedSignature) return false;

  const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");

  try {
    const provided = Buffer.from(providedSignature, "hex");
    const expected = Buffer.from(expectedSignature, "hex");

    if (provided.length === 0 || provided.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

function validationErrorResponse(issues: string[]) {
  return Response.json(
    { error: "Validation failed", issues },
    { status: 400 },
  );
}

// POST /api/commerce/cross-chain-webhook
// Simulates a bridge receiver (e.g. CCIP/CCTP) notifying Stellar-side commerce once
// a payment on another chain is complete. Verified payments create or transition a
// commerce job to pending (async fulfillment) or completed (instant fulfillment).
//
// Authentication:
//   - Requires HMAC SHA-256 signature in X-Signature
//   - Signature is computed over the raw request body with CROSS_CHAIN_WEBHOOK_SECRET
export async function POST(request: NextRequest) {
  try {
    const webhookSecret = process.env.CROSS_CHAIN_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("[cross-chain-webhook POST] CROSS_CHAIN_WEBHOOK_SECRET is not configured");
      return Response.json({ error: "Webhook authentication is not configured" }, { status: 500 });
    }

    const rawBody = await request.text();
    if (!isValidWebhookSignature(rawBody, request.headers.get("x-signature"), webhookSecret)) {
      return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const result = crossChainWebhookSchema.safeParse(body);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      return validationErrorResponse(issues);
    }

    const {
      jobId,
      talosId,
      requesterTalosId,
      sourceChain,
      destinationChain,
      paymentReference,
      sourceTxHash,
      amount,
      currency,
      simulatedVerified,
      payload,
    } = result.data;

    const normalizedSourceChain = normalizeChain(sourceChain);
    const normalizedDestinationChain = normalizeChain(destinationChain);

    if (normalizedDestinationChain !== "stellar") {
      return Response.json(
        { error: "destinationChain must resolve to stellar for this receiver" },
        { status: 400 },
      );
    }

    if (normalizedSourceChain === "stellar") {
      return Response.json(
        { error: "sourceChain must be a non-Stellar chain for this webhook" },
        { status: 400 },
      );
    }

    const [talos, service] = await Promise.all([
      db
        .select({ id: tlsTalos.id })
        .from(tlsTalos)
        .where(eq(tlsTalos.id, talosId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(tlsCommerceServices)
        .where(eq(tlsCommerceServices.talosId, talosId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    if (!service) {
      return Response.json({ error: "No commerce service registered for this TALOS" }, { status: 404 });
    }

    const supportedChains = new Set((service.chains ?? []).map(normalizeChain));
    if (!supportedChains.has(normalizedSourceChain)) {
      return Response.json(
        {
          error: `Service is not configured for ${sourceChain} payments`,
          supportedChains: service.chains,
        },
        { status: 400 },
      );
    }

    if (!simulatedVerified) {
      return Response.json(
        { error: "Simulated payment verification failed" },
        { status: 402 },
      );
    }

    if (currency.toUpperCase() !== String(service.currency ?? "USDC").toUpperCase()) {
      return Response.json(
        {
          error: "Webhook currency does not match the service currency",
          expectedCurrency: service.currency ?? "USDC",
        },
        { status: 400 },
      );
    }

    const expectedAmount = Number(service.price);
    if (amount < expectedAmount) {
      return Response.json(
        {
          error: "Insufficient bridged amount",
          expectedAmount,
          receivedAmount: amount,
        },
        { status: 402 },
      );
    }

    const paymentSig = buildPaymentSignature(normalizedSourceChain, paymentReference);

    const [jobById, jobByPaymentSig] = await Promise.all([
      jobId
        ? db
            .select()
            .from(tlsCommerceJobs)
            .where(and(eq(tlsCommerceJobs.id, jobId), eq(tlsCommerceJobs.talosId, talosId)))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select()
        .from(tlsCommerceJobs)
        .where(eq(tlsCommerceJobs.paymentSig, paymentSig))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    if (jobId && !jobById) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    if (jobById && jobById.requesterTalosId !== requesterTalosId) {
      return Response.json(
        { error: "Webhook requesterTalosId does not match the existing job" },
        { status: 409 },
      );
    }

    if (jobByPaymentSig && jobById && jobByPaymentSig.id !== jobById.id) {
      return Response.json(
        { error: "paymentReference is already linked to another job" },
        { status: 409 },
      );
    }

    const existingJob = jobById ?? jobByPaymentSig;
    const nextStatus = service.fulfillmentMode === "instant" ? "completed" : "pending";

    if (existingJob?.status === "completed") {
      return Response.json(
        {
          id: existingJob.id,
          jobId: existingJob.id,
          status: existingJob.status,
          serviceName: existingJob.serviceName,
          result: existingJob.result,
          txHash: existingJob.txHash,
          bridge: {
            sourceChain: normalizedSourceChain,
            destinationChain: normalizedDestinationChain,
            paymentReference,
            sourceTxHash,
          },
        },
        { status: 200 },
      );
    }

    if (existingJob && existingJob.status === nextStatus) {
      return Response.json(
        {
          id: existingJob.id,
          jobId: existingJob.id,
          status: existingJob.status,
          serviceName: existingJob.serviceName,
          result: existingJob.result,
          txHash: existingJob.txHash,
          bridge: {
            sourceChain: normalizedSourceChain,
            destinationChain: normalizedDestinationChain,
            paymentReference,
            sourceTxHash,
          },
        },
        { status: 200 },
      );
    }

    let fulfillmentResult: Record<string, unknown> | null = null;
    if (service.fulfillmentMode === "instant") {
      try {
        fulfillmentResult = await fulfillInstant(service.serviceName, payload ?? {});
      } catch (error) {
        console.error("Cross-chain instant fulfillment failed:", error);
        return Response.json({ error: "Service fulfillment failed" }, { status: 502 });
      }
    }

    const [job] = await db.transaction(async (tx) => {
      const values = {
        talosId,
        requesterTalosId,
        serviceName: service.serviceName,
        payload: payload ?? {},
        result: fulfillmentResult,
        paymentSig,
        txHash: sourceTxHash,
        amount: String(service.price),
        status: nextStatus,
      };

      const [savedJob] = existingJob
        ? await tx
            .update(tlsCommerceJobs)
            .set(values)
            .where(eq(tlsCommerceJobs.id, existingJob.id))
            .returning()
        : await tx.insert(tlsCommerceJobs).values(values).returning();

      if (nextStatus === "completed" && existingJob?.status !== "completed") {
        await tx.insert(tlsRevenues).values({
          talosId,
          amount: String(service.price),
          currency: service.currency ?? "USDC",
          source: "commerce",
          txHash: sourceTxHash,
        });
      }

      return [savedJob];
    });

    return Response.json(
      {
        id: job.id,
        jobId: job.id,
        status: job.status,
        serviceName: job.serviceName,
        result: job.result,
        txHash: job.txHash,
        bridge: {
          sourceChain: normalizedSourceChain,
          destinationChain: normalizedDestinationChain,
          paymentReference,
          sourceTxHash,
        },
      },
      { status: existingJob ? 200 : 201 },
    );
  } catch (error) {
    const err = error as Record<string, unknown>;
    if (err?.code === "23505" && String(err?.constraint ?? "").includes("paymentSig")) {
      return Response.json(
        { error: "paymentReference already processed" },
        { status: 409 },
      );
    }

    console.error("[cross-chain-webhook POST]", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
