/**
 * Per-agent resource quota enforcement library.
 *
 * Usage pattern
 * ─────────────
 *   const result = await checkAndIncrementQuota(db, talosId, "activity_writes");
 *   if (!result.ok) return quotaExceededResponse(result);
 *
 * Design notes
 * ────────────
 * Quotas are persisted in two tables:
 *
 *   tls_quota_configs  — limit + window definition (per-agent or platform default)
 *   tls_quota_usage    — atomic per-window usage counter
 *
 * The counter increment uses an UPSERT (INSERT … ON CONFLICT DO UPDATE) so that
 * concurrent requests on the same agent never double-count.  The increment and
 * the limit check happen in a single round-trip: we increment first, then read
 * back the new count.  This "increment-then-check" pattern means the counter can
 * exceed the limit by at most (concurrency – 1) in the absolute worst case, but
 * keeps the critical path at one DB query and avoids distributed locking.
 *
 * For a production multi-region deployment, replace the DB upsert with an
 * Upstash Redis INCR+EXPIRE pair for sub-millisecond atomic increments and
 * automatic window expiry without cron maintenance.
 *
 * Backward compatibility
 * ──────────────────────
 * Quota enforcement is disabled by default (enabled=false in platform defaults
 * when first deployed) and must be explicitly enabled per-resource via the admin
 * route GET /api/talos/:id/quota.  Existing agent behavior is therefore
 * unaffected on first deployment.
 *
 * Reset windows
 * ─────────────
 * "hourly"  → windowStart = UTC hour boundary (e.g. 14:00:00)
 * "daily"   → windowStart = UTC midnight       (e.g. 2026-07-24 00:00:00)
 * "monthly" → windowStart = UTC month start    (e.g. 2026-07-01 00:00:00)
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { tlsQuotaConfigs, tlsQuotaUsage } from "@/db/schema";
import type { db as appDb } from "@/db";
import { logger } from "@/lib/logger";
import type { OperationClass } from "@/lib/rate-limit-store";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported resource identifiers. */
export type QuotaResource =
  | "activity_writes"
  | "job_writes"
  | "revenue_writes"
  | "sse_connections";

/** Window granularity options. */
export type WindowSize = "hourly" | "daily" | "monthly";

/** Options for checkAndIncrementQuota, including operationClass and grace overrides. */
export interface CheckQuotaOptions {
  operationClass?: OperationClass;
  graceTtlMs?: number;
}

export const DEFAULT_QUOTA_STORE_GRACE_TTL_MS = 60_000;

/** The effective quota configuration for a (talosId, resource) pair. */
export interface QuotaConfig {
  talosId: string | null; // null = platform default
  resource: QuotaResource;
  maxCount: number;
  windowSize: WindowSize;
  enabled: boolean;
  notes: string | null;
}

/** Result of a quota check/increment call. */
export interface QuotaResult {
  /** false when the quota is exceeded and the request should be rejected. */
  ok: boolean;
  /** Effective maximum count for this window. */
  limit: number;
  /** Remaining count after this increment (0 = last slot just used). */
  remaining: number;
  /** Current usage count for this window (after increment). */
  used: number;
  /** When the current window resets (Unix epoch milliseconds). */
  resetAt: number;
  /** The resource that was checked. */
  resource: QuotaResource;
}

// ─── DB type alias (Drizzle's inferred type) ─────────────────────────────────

type Db = typeof appDb;

// ─── Window helpers ───────────────────────────────────────────────────────────

/**
 * Floor a Date to the nearest window boundary in UTC.
 * Returns a Date at the start of the current window.
 */
export function floorToWindow(date: Date, windowSize: WindowSize): Date {
  const d = new Date(date);
  // Always work in UTC
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);

  if (windowSize === "hourly") {
    // Already floored to hour
    return d;
  }

  d.setUTCHours(0);

  if (windowSize === "daily") {
    return d;
  }

  // monthly
  d.setUTCDate(1);
  return d;
}

/**
 * Compute the reset time (start of the NEXT window) given a window start
 * and window size.
 */
export function nextWindowStart(windowStart: Date, windowSize: WindowSize): Date {
  const d = new Date(windowStart);
  if (windowSize === "hourly") {
    d.setUTCHours(d.getUTCHours() + 1);
  } else if (windowSize === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
  } else {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d;
}

// ─── Config resolution ────────────────────────────────────────────────────────

/**
 * Resolve the effective quota configuration for a (talosId, resource) pair.
 *
 * Precedence:
 *   1. Agent-specific row (talosId = id, resource = resource)
 *   2. Platform default  (talosId IS NULL, resource = resource)
 *   3. Hard-coded fallback (quota disabled — no enforcement)
 */
export async function resolveQuotaConfig(
  db: Db,
  talosId: string,
  resource: QuotaResource,
): Promise<QuotaConfig> {
  // Fetch both agent-specific and platform-default in one query
  const rows = await db
    .select()
    .from(tlsQuotaConfigs)
    .where(
      and(
        eq(tlsQuotaConfigs.resource, resource),
        or(eq(tlsQuotaConfigs.talosId, talosId), isNull(tlsQuotaConfigs.talosId)),
      ),
    );

  // Agent-specific override takes precedence
  const agentRow = rows.find((r) => r.talosId === talosId);
  if (agentRow) {
    return {
      talosId: agentRow.talosId,
      resource: agentRow.resource as QuotaResource,
      maxCount: agentRow.maxCount,
      windowSize: agentRow.windowSize as WindowSize,
      enabled: agentRow.enabled,
      notes: agentRow.notes ?? null,
    };
  }

  // Platform default
  const platformRow = rows.find((r) => r.talosId === null);
  if (platformRow) {
    return {
      talosId: null,
      resource: platformRow.resource as QuotaResource,
      maxCount: platformRow.maxCount,
      windowSize: platformRow.windowSize as WindowSize,
      enabled: platformRow.enabled,
      notes: platformRow.notes ?? null,
    };
  }

  // Hard-coded safe fallback: quota disabled
  return {
    talosId: null,
    resource,
    maxCount: 10_000,
    windowSize: "daily",
    enabled: false,
    notes: "No quota config found — enforcement disabled (safe fallback)",
  };
}

// ─── Outage state tracking for quota store ───────────────────────────────────

let _quotaStoreOutageStartTime: number | null = null;
let _quotaStoreConsecutiveFailures = 0;

/** Read current quota store outage status. */
export function getQuotaStoreOutageStatus(): {
  isOutage: boolean;
  outageDurationMs: number;
  consecutiveFailures: number;
} {
  const isOutage = _quotaStoreConsecutiveFailures > 0;
  const outageDurationMs = _quotaStoreOutageStartTime ? Date.now() - _quotaStoreOutageStartTime : 0;
  return { isOutage, outageDurationMs, consecutiveFailures: _quotaStoreConsecutiveFailures };
}

/** Reset quota store outage tracking (used in tests). */
export function _resetQuotaStoreOutage(): void {
  _quotaStoreOutageStartTime = null;
  _quotaStoreConsecutiveFailures = 0;
}

function recordQuotaStoreSuccess(): void {
  if (_quotaStoreOutageStartTime !== null || _quotaStoreConsecutiveFailures > 0) {
    logger.info(
      { previousFailures: _quotaStoreConsecutiveFailures },
      "quota: store connection recovered from outage",
    );
    _quotaStoreOutageStartTime = null;
    _quotaStoreConsecutiveFailures = 0;
  }
}

function handleQuotaStoreFailure(
  err: unknown,
  talosId: string,
  resource: QuotaResource,
  opClass: OperationClass,
  graceTtlMs: number,
  fallbackLimit: number,
  fallbackWindowSize: WindowSize,
): QuotaResult {
  if (_quotaStoreOutageStartTime === null) {
    _quotaStoreOutageStartTime = Date.now();
  }
  _quotaStoreConsecutiveFailures += 1;
  const outageDurationMs = Date.now() - _quotaStoreOutageStartTime;

  logger.warn(
    {
      err,
      talosId,
      resource,
      opClass,
      outageDurationMs,
      consecutiveFailures: _quotaStoreConsecutiveFailures,
    },
    "quota: store unavailable, evaluating bounded grace outage policy",
  );

  const now = new Date();
  const windowStart = floorToWindow(now, fallbackWindowSize);
  const resetAt = nextWindowStart(windowStart, fallbackWindowSize).getTime();

  // Payment and privileged paths are strictly fail-closed during verified outages
  if (opClass === "payment" || opClass === "privileged" || resource === "job_writes" || resource === "revenue_writes") {
    logger.error(
      { talosId, resource, opClass, outageDurationMs },
      "quota: fail-closed enforced for payment/privileged path during store outage",
    );
    return {
      ok: false,
      limit: fallbackLimit,
      remaining: 0,
      used: fallbackLimit,
      resetAt,
      resource,
    };
  }

  // Bounded grace window check
  if (outageDurationMs > graceTtlMs) {
    logger.error(
      { talosId, resource, opClass, outageDurationMs, graceTtlMs },
      "quota: outage exceeded bounded grace period, failing closed",
    );
    return {
      ok: false,
      limit: fallbackLimit,
      remaining: 0,
      used: fallbackLimit,
      resetAt,
      resource,
    };
  }

  // Within bounded grace period for standard/read/SSE operations: fail open
  return {
    ok: true,
    limit: fallbackLimit,
    remaining: 1,
    used: 0,
    resetAt,
    resource,
  };
}

// ─── Core check + increment ──────────────────────────────────────────────────

/**
 * Atomically increment the usage counter for (talosId, resource) in the
 * current window, then check whether the new count exceeds the limit.
 *
 * If quota enforcement is disabled for this resource the function returns
 * `ok: true` immediately without touching tls_quota_usage (zero overhead).
 *
 * @param db       Drizzle DB instance
 * @param talosId  Agent being checked
 * @param resource Resource being consumed
 * @returns        QuotaResult describing the outcome
 */
export async function checkAndIncrementQuota(
  db: Db,
  talosId: string,
  resource: QuotaResource,
  options?: CheckQuotaOptions,
): Promise<QuotaResult> {
  // Infer operation class: explicit option takes precedence, otherwise job_writes/revenue_writes default to payment
  const opClass: OperationClass =
    options?.operationClass ??
    (resource === "job_writes" || resource === "revenue_writes"
      ? "payment"
      : resource === "sse_connections"
      ? "read"
      : "standard");

  const envGrace = process.env.QUOTA_STORE_GRACE_TTL_MS
    ? parseInt(process.env.QUOTA_STORE_GRACE_TTL_MS, 10) || DEFAULT_QUOTA_STORE_GRACE_TTL_MS
    : DEFAULT_QUOTA_STORE_GRACE_TTL_MS;
  const graceTtlMs = options?.graceTtlMs ?? envGrace;

  let config: QuotaConfig;
  try {
    config = await resolveQuotaConfig(db, talosId, resource);
  } catch (err) {
    return handleQuotaStoreFailure(
      err,
      talosId,
      resource,
      opClass,
      graceTtlMs,
      10_000,
      "daily",
    );
  }

  const now = new Date();
  const windowStart = floorToWindow(now, config.windowSize);
  const resetAt = nextWindowStart(windowStart, config.windowSize).getTime();

  if (!config.enabled) {
    recordQuotaStoreSuccess();
    return {
      ok: true,
      limit: config.maxCount,
      remaining: config.maxCount,
      used: 0,
      resetAt,
      resource,
    };
  }

  try {
    // Atomic upsert: increment counter, create row on first use within window
    const [row] = await db
      .insert(tlsQuotaUsage)
      .values({
        talosId,
        resource,
        windowStart,
        count: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [tlsQuotaUsage.talosId, tlsQuotaUsage.resource, tlsQuotaUsage.windowStart],
        set: {
          count: sql`${tlsQuotaUsage.count} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ count: tlsQuotaUsage.count });

    recordQuotaStoreSuccess();

    const used = row?.count ?? 1;
    const remaining = Math.max(0, config.maxCount - used);
    const ok = used <= config.maxCount;

    return { ok, limit: config.maxCount, remaining, used, resetAt, resource };
  } catch (err) {
    return handleQuotaStoreFailure(
      err,
      talosId,
      resource,
      opClass,
      graceTtlMs,
      config.maxCount,
      config.windowSize,
    );
  }
}

/**
 * Read the current usage for (talosId, resource) in the current window WITHOUT
 * incrementing the counter.  Used by the admin quota route.
 */
export async function readQuotaUsage(
  db: Db,
  talosId: string,
  resource: QuotaResource,
): Promise<QuotaResult> {
  const config = await resolveQuotaConfig(db, talosId, resource);

  const now = new Date();
  const windowStart = floorToWindow(now, config.windowSize);
  const resetAt = nextWindowStart(windowStart, config.windowSize).getTime();

  const row = await db
    .select({ count: tlsQuotaUsage.count })
    .from(tlsQuotaUsage)
    .where(
      and(
        eq(tlsQuotaUsage.talosId, talosId),
        eq(tlsQuotaUsage.resource, resource),
        eq(tlsQuotaUsage.windowStart, windowStart),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  const used = row?.count ?? 0;
  const remaining = Math.max(0, config.maxCount - used);
  const ok = used <= config.maxCount;

  return { ok, limit: config.maxCount, remaining, used, resetAt, resource };
}

// ─── Response helpers ────────────────────────────────────────────────────────

/**
 * Build a 429 Response with X-Quota-* headers when a quota is exceeded.
 */
export function quotaExceededResponse(result: QuotaResult): Response {
  return new Response(
    JSON.stringify({
      error: "Quota exceeded",
      resource: result.resource,
      limit: result.limit,
      resetAt: new Date(result.resetAt).toISOString(),
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...buildQuotaHeaders(result),
      },
    },
  );
}

/**
 * Return the X-Quota-* header set for a given QuotaResult.
 * Attach these to 200/201 responses so clients can monitor their usage.
 */
export function buildQuotaHeaders(result: QuotaResult): Record<string, string> {
  return {
    "X-Quota-Limit": String(result.limit),
    "X-Quota-Remaining": String(result.remaining),
    "X-Quota-Used": String(result.used),
    "X-Quota-Reset": String(Math.ceil(result.resetAt / 1000)),
    "X-Quota-Resource": result.resource,
  };
}

/**
 * Apply X-Quota-* headers to an existing Response object (mutates headers).
 */
export function applyQuotaHeaders(response: Response, result: QuotaResult): Response {
  const headers = buildQuotaHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

/** All trackable resources — used for bulk reads on the admin route. */
export const ALL_QUOTA_RESOURCES: QuotaResource[] = [
  "activity_writes",
  "job_writes",
  "revenue_writes",
  "sse_connections",
];
