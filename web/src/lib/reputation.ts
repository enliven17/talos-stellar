import { db } from "@/db";
import { tlsReputations, tlsCommerceJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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

const CACHE_TTL_MS = 60 * 1000; // 60 seconds TTL for caching/staleness tests
const ALGORITHM_VERSION = "1.0.0";

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

  // 2. Compute reputation from jobs
  const jobs = await db
    .select({
      status: tlsCommerceJobs.status,
      leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt,
    })
    .from(tlsCommerceJobs)
    .where(
      and(
        eq(tlsCommerceJobs.talosId, talosId),
        eq(tlsCommerceJobs.serviceName, serviceName)
      )
    );

  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    if (job.status === "completed") {
      completed++;
    } else if (
      job.status === "failed" ||
      (job.status !== "completed" && job.leaseExpiresAt && job.leaseExpiresAt < now)
    ) {
      failed++;
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
