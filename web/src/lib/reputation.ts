import { db } from "@/db";
import { tlsReputations, tlsCommerceJobs, tlsReputationLedger } from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";

export interface ReputationData {
  providerId: string;
  serviceName: string;
  score: number;
  confidence: number;
  samples: number;
  freshness: Date;
  version: string;
  safeReason: {
    safe: boolean;
    reasons: string[];
  };
}

export interface ReputationLedgerEvent {
  talosId: string;
  serviceName: string;
  jobId: string;
  eventType: 'settled' | 'delivery' | 'deadline' | 'refund' | 'dispute' | 'cancellation' | 'repeat' | 'counterparty';
  amount?: string | number;
  counterparty?: string | null;
  txHash?: string | null;
  paymentSig?: string | null;
  timestamp?: Date;
  version?: string;
  metadata?: any;
}

const CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL for caching/staleness tests
const ALGORITHM_VERSION = "1.0.0";

/**
 * Ingest a reputation event into the ledger.
 */
export async function ingestReputationEvent(
  event: ReputationLedgerEvent,
  tx?: any
): Promise<void> {
  const client = tx || db;
  const amountStr = event.amount !== undefined ? String(event.amount) : "0";
  try {
    const insertBuilder = client
      .insert(tlsReputationLedger)
      .values({
        talosId: event.talosId,
        serviceName: event.serviceName,
        jobId: event.jobId,
        eventType: event.eventType,
        amount: amountStr,
        counterparty: event.counterparty ?? null,
        txHash: event.txHash ?? null,
        paymentSig: event.paymentSig ?? null,
        timestamp: event.timestamp ?? new Date(),
        version: event.version ?? "1.0.0",
        metadata: event.metadata ?? null,
      });

    if (insertBuilder && typeof insertBuilder.onConflictDoNothing === "function") {
      await insertBuilder.onConflictDoNothing({
        target: [tlsReputationLedger.jobId, tlsReputationLedger.eventType],
      });
    } else {
      await insertBuilder;
    }
  } catch (err) {
    if (!process.env.VITEST) {
      console.error("ingestReputationEvent error:", err);
    }
  }
}

/**
 * Get the cached reputation for a provider and service, or compute it if missing or stale.
 */
export async function getOrCreateReputation(
  talosId: string,
  serviceName: string,
  forceRefresh = false
): Promise<ReputationData> {
  const now = new Date();

  // 1. Check database cache
  const cached = await db
    .select()
    .from(tlsReputations)
    .where(
      and(
        eq(tlsReputations.talosId, talosId),
        eq(tlsReputations.serviceName, serviceName)
      )
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  if (
    cached &&
    !forceRefresh &&
    now.getTime() - cached.freshness.getTime() < CACHE_TTL_MS
  ) {
    return {
      providerId: cached.talosId,
      serviceName: cached.serviceName,
      score: Number(cached.score),
      confidence: Number(cached.confidence),
      samples: cached.samples,
      freshness: cached.freshness,
      version: cached.version,
      safeReason: cached.safeReason as { safe: boolean; reasons: string[] },
    };
  }

  // 1.5 Scan for any expired jobs in tlsCommerceJobs and ingest a deadline event if needed
  const expiredJobs = await db
    .select({
      id: tlsCommerceJobs.id,
      amount: tlsCommerceJobs.amount,
      requesterTalosId: tlsCommerceJobs.requesterTalosId,
      txHash: tlsCommerceJobs.txHash,
      paymentSig: tlsCommerceJobs.paymentSig,
      createdAt: tlsCommerceJobs.createdAt,
    })
    .from(tlsCommerceJobs)
    .where(
      and(
        eq(tlsCommerceJobs.talosId, talosId),
        eq(tlsCommerceJobs.serviceName, serviceName),
        eq(tlsCommerceJobs.status, "pending"),
        lt(tlsCommerceJobs.leaseExpiresAt, now)
      )
    );

  for (const job of expiredJobs) {
    await ingestReputationEvent({
      talosId,
      serviceName,
      jobId: job.id,
      eventType: "deadline",
      amount: job.amount,
      counterparty: job.requesterTalosId,
      txHash: job.txHash,
      paymentSig: job.paymentSig,
      timestamp: now,
    });
  }

  // 2. Fetch all ledger events for this provider/service
  const events = await db
    .select()
    .from(tlsReputationLedger)
    .where(
      and(
        eq(tlsReputationLedger.talosId, talosId),
        eq(tlsReputationLedger.serviceName, serviceName)
      )
    );

  // Group events by jobId to compute metrics
  const jobEventsMap = new Map<string, typeof events>();
  for (const event of events) {
    if (!jobEventsMap.has(event.jobId)) {
      jobEventsMap.set(event.jobId, []);
    }
    jobEventsMap.get(event.jobId)!.push(event);
  }

  let completed = 0;
  let failed = 0;

  for (const [_, jobEvents] of jobEventsMap.entries()) {
    const hasDelivery = jobEvents.some((e) => e.eventType === "delivery");
    if (hasDelivery) {
      completed++;
    } else {
      const hasFailedIndicator = jobEvents.some(
        (e) =>
          e.eventType === "deadline" ||
          e.eventType === "dispute" ||
          e.eventType === "refund" ||
          e.eventType === "cancellation"
      );
      if (hasFailedIndicator) {
        failed++;
      }
    }
  }

  const samples = completed + failed;
  // Bounded reputation score: ratio of completed to total (completed + failed)
  const score = samples > 0 ? completed / samples : 1.0;
  // Bounded confidence function: samples / (samples + 3)
  const confidence = samples > 0 ? samples / (samples + 3) : 0.0;

  // Determine safety reason breakdown (e.g. requires >= 0.8 score and confidence >= 0.4 unless cold-start)
  const safe = score >= 0.8 && (samples === 0 || confidence >= 0.4);
  const reasons: string[] = [];

  if (samples === 0) {
    reasons.push("Cold-start provider, no evidence collected yet");
  } else {
    reasons.push(`Completion rate: ${Math.round(score * 100)}%`);
    reasons.push(`Evidence: ${samples} samples`);
    if (score < 0.8) {
      reasons.push("Unsafe: low completion rate");
    }
    if (confidence < 0.4) {
      reasons.push("Low confidence: insufficient samples");
    }
  }

  const safeReason = { safe, reasons };

  // 3. Upsert reputation into the database cache
  if (cached) {
    await db
      .update(tlsReputations)
      .set({
        score: String(score),
        confidence: String(confidence),
        samples,
        freshness: now,
        version: ALGORITHM_VERSION,
        safeReason,
      })
      .where(eq(tlsReputations.id, cached.id));
  } else {
    await db.insert(tlsReputations).values({
      talosId,
      serviceName,
      score: String(score),
      confidence: String(confidence),
      samples,
      freshness: now,
      version: ALGORITHM_VERSION,
      safeReason,
    });
  }

  return {
    providerId: talosId,
    serviceName,
    score,
    confidence,
    samples,
    freshness: now,
    version: ALGORITHM_VERSION,
    safeReason,
  };
}

