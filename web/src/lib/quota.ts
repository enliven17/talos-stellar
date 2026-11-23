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

import { createHash } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { tlsQuotaConfigs, tlsQuotaScopeUsage, tlsQuotaUsage } from "@/db/schema";
import { VALID_SCOPES, type Scope } from "@/lib/api-scopes";
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
  /**
   * Whether this call consumed a unit by incrementing tls_quota_usage.
   *
   *   – disabled quotas: false (the no-write path is preserved)
   *   – enabled quotas, under or at the limit: true
   *   – enabled quotas, exhausted (ok=false): true — the counter is
   *     incremented before the limit check, so a rejected attempt is still
   *     counted and surfaces as `used` on the decision
   *   – readQuotaUsage: false (read-only)
   */
  incremented: boolean;
}

/** Input accepted by response and header helpers, including unknown/null reset times. */
export type QuotaHeaderInput = Omit<QuotaResult, "resetAt"> & {
  resetAt?: number | null;
};

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
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d;
}

export interface WindowBoundaries {
  /** UTC timestamp (Date) for start of the current window. */
  windowStart: Date;
  /** Unix epoch milliseconds when the current window resets (start of the next window). */
  resetAt: number;
  /** ISO-8601 string representation of resetAt, used in JSON response bodies. */
  resetAtIso: string;
  /** Unix epoch seconds string representation of resetAt, used in X-Quota-Reset headers. */
  resetAtHeader: string;
}

/**
 * Canonical calculation of quota window boundaries and reset representations.
 * Ensures consistent reset time calculation across response bodies and HTTP headers,
 * accepting an optional injected clock (Date or Unix epoch ms) for predictable testing
 * across month transitions, leap days, and exact window boundaries.
 *
 * @param now        Current time or injected clock (Date or timestamp in ms)
 * @param windowSize Granularity of quota window ("hourly" | "daily" | "monthly")
 */
export function computeQuotaWindow(
  now: Date | number = new Date(),
  windowSize: WindowSize,
): WindowBoundaries {
  const clockDate = typeof now === "number" ? new Date(now) : new Date(now);
  const windowStart = floorToWindow(clockDate, windowSize);
  const nextStart = nextWindowStart(windowStart, windowSize);
  const resetAt = nextStart.getTime();

  return {
    windowStart,
    resetAt,
    resetAtIso: new Date(resetAt).toISOString(),
    resetAtHeader: String(Math.ceil(resetAt / 1000)),
  };
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
    if (!validateQuotaLimit(agentRow.maxCount)) {
      throw new QuotaConfigError(
        `Unsafe quota limit for agent "${talosId}" resource "${resource}": maxCount=${agentRow.maxCount}`,
      );
    }
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
    if (!validateQuotaLimit(platformRow.maxCount)) {
      throw new QuotaConfigError(
        `Unsafe platform quota limit for resource "${resource}": maxCount=${platformRow.maxCount}`,
      );
    }
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
 * `ok: true` immediately without touching tls_quota_usage (zero overhead) and
 * reports `incremented: false`.  Enabled quotas always increment exactly once,
 * so `incremented` is true for admitted, at-limit, and exhausted decisions.
 *
 * @param db       Drizzle DB instance
 * @param talosId  Agent being checked
 * @param resource Resource being consumed
 * @param scopeOrClock Optional per-scope label, or an injected clock
 * @param clock       Optional injected clock when a scope is provided
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
  const policy = config.talosId === talosId ? "agent" : "platform";

  if (!config.enabled) {
    recordQuotaStoreSuccess();
    return {
      ok: true,
      limit: config.maxCount,
      remaining: config.maxCount,
      used: 0,
      resetAt: boundaries.resetAt,
      resource,
      incremented: false,
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
 *
 * @param db       Drizzle DB instance
 * @param talosId  Agent being checked
 * @param resource Resource being consumed
 * @param clock    Optional injected clock (Date or timestamp in ms)
 */
export async function readQuotaUsage(
  db: Db,
  talosId: string,
  resource: QuotaResource,
  clock?: Date | number,
): Promise<QuotaResult> {
  const config = await resolveQuotaConfig(db, talosId, resource);

  const now = new Date();
  const windowStart = floorToWindow(now, config.windowSize);
  const resetAt = nextWindowStart(windowStart, config.windowSize).getTime();
  const policy = config.talosId === talosId ? "agent" : "platform";

  const row = await db
    .select({ count: tlsQuotaUsage.count })
    .from(tlsQuotaUsage)
    .where(
      and(
        eq(tlsQuotaUsage.talosId, talosId),
        eq(tlsQuotaUsage.resource, resource),
        eq(tlsQuotaUsage.windowStart, boundaries.windowStart),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  const used = row?.count ?? 0;
  const remaining = Math.max(0, config.maxCount - used);
  const ok = used <= config.maxCount;

  // Read-only: usage is never incremented by this helper.
  return {
    ok,
    limit: config.maxCount,
    remaining,
    used,
    resetAt,
    resource,
    incremented: false,
  };
}

// ─── Response helpers ────────────────────────────────────────────────────────

/**
 * Build a 429 Response with bounded `Retry-After` and `X-Quota-*` headers
 * when a quota is exceeded.
 */
export function quotaExceededResponse(
  result: QuotaHeaderInput,
  options?: RetryAfterOptions,
): Response {
  const retryAfterSec = computeRetryAfterSeconds(result.resetAt, options);
  const resetIso = formatResetIsoString(result.resetAt);

  return new Response(
    JSON.stringify({
      error: "Quota exceeded",
      resource: result.resource,
      limit: result.limit,
      resetAt: new Date(result.resetAt).toISOString(),
      incremented: result.incremented,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        ...buildQuotaHeaders(result),
      },
    },
  );
}

/**
 * Return the X-Quota-* header set for a given QuotaResult.
 * Attach these to 200/201 responses so clients can monitor their usage.
 * X-Quota-Incremented reports whether the paired decision consumed a unit.
 */
export function buildQuotaHeaders(result: QuotaHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Quota-Limit": String(result.limit),
    "X-Quota-Remaining": String(result.remaining),
    "X-Quota-Used": String(result.used),
    "X-Quota-Resource": result.resource,
    "X-Quota-Incremented": String(result.incremented),
  };
  const resetSeconds = formatResetEpochSeconds(result.resetAt);
  if (resetSeconds !== null) {
    headers["X-Quota-Reset"] = resetSeconds;
  }
  return headers;
}

/**
 * Build a detailed quota explanation object for response bodies.
 * Includes the human-readable explanation and all relevant quota metadata.
 * Safe to include in responses to authenticated owners — excludes other agents
 * and internal administrative secrets.
 */
export function buildQuotaExplanation(result: QuotaResult): QuotaExplanation {
  return {
    resource: result.resource,
    limit: result.limit,
    remaining: result.remaining,
    used: result.used,
    resetAt: new Date(result.resetAt).toISOString(),
    windowSize: result.windowSize,
    policy: result.policy,
    explanation: result.explanation,
    ok: result.ok,
  };
}

/** Detailed quota explanation for response bodies. */
export interface QuotaExplanation {
  resource: QuotaResource;
  limit: number;
  remaining: number;
  used: number;
  resetAt: string; // ISO-8601
  windowSize: WindowSize;
  policy: "agent" | "platform";
  explanation: string;
  ok: boolean;
}

/**
 * Apply X-Quota-* headers to an existing Response object (mutates headers).
 * Removes any stale `X-Quota-Reset` header when the reset timestamp is unknown.
 */
export function applyQuotaHeaders(response: Response, result: QuotaHeaderInput): Response {
  const headers = buildQuotaHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  if (headers["X-Quota-Reset"] === undefined) {
    response.headers.delete("X-Quota-Reset");
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

// ─── Reproducible Quota-Window Usage Statement ───────────────────────────────

/** Schema version for exported quota-window usage statements. */
export const QUOTA_STATEMENT_SCHEMA_VERSION = "1.0.0";

/** Default source policy version stamped onto exported usage statements. */
export const QUOTA_POLICY_VERSION = "quota-policy/v1";

/** Origin of the effective quota policy applied to a resource. */
export type QuotaPolicySource = "agent_override" | "platform_default" | "fallback";

/** One resource row in a reproducible quota-window usage statement. */
export interface QuotaWindowStatementEntry {
  resource: QuotaResource;
  windowSize: WindowSize;
  windowStart: string;
  windowEnd: string;
  windowStartMs: number;
  windowEndMs: number;
  enabled: boolean;
  policySource: QuotaPolicySource;
  limit: number;
  used: number;
  remaining: number;
  overage: number;
  withinQuota: boolean;
  unit: "requests";
}

/** Reproducible, integer-unit quota-window usage statement for one agent. */
export interface QuotaWindowUsageStatement {
  schemaVersion: string;
  sourcePolicyVersion: string;
  talosId: string;
  entries: QuotaWindowStatementEntry[];
  totals: {
    resources: number;
    limit: number;
    used: number;
    remaining: number;
    overage: number;
  };
  /** SHA-256 hex digest of the canonical statement payload (excluding digest). */
  digest: string;
}

/** Input record for a single resource when building a statement. */
export interface QuotaWindowStatementResourceInput {
  resource: QuotaResource;
  windowSize: WindowSize;
  enabled: boolean;
  policySource: QuotaPolicySource;
  limit: number;
  used: number;
}

/** Input parameters for `buildQuotaWindowStatement`. */
export interface BuildQuotaWindowStatementInput {
  talosId: string;
  asOf: Date;
  sourcePolicyVersion?: string;
  resources: readonly QuotaWindowStatementResourceInput[];
}

function assertNonNegativeSafeInteger(value: number, fieldName: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function assertValidWindowSize(windowSize: string): WindowSize {
  if (windowSize !== "hourly" && windowSize !== "daily" && windowSize !== "monthly") {
    throw new Error(`Unsupported windowSize: ${windowSize}`);
  }
  return windowSize;
}

/**
 * Build a reproducible quota-window usage statement for one authorized agent.
 *
 * Guarantees:
 * - Stable UTC window boundaries (`floorToWindow` / `nextWindowStart`)
 * - Strict non-negative integer units for all counts and epoch timestamps
 * - Includes `sourcePolicyVersion` and per-resource `policySource`
 * - Strictly allowlists structural fields so private request payloads and
 *   free-form notes are never included in the exported statement
 * - Canonical resource ordering and deterministic SHA-256 `digest`
 */
export function buildQuotaWindowStatement(
  input: BuildQuotaWindowStatementInput,
): QuotaWindowUsageStatement {
  const talosId = typeof input.talosId === "string" ? input.talosId.trim() : "";
  if (!talosId) {
    throw new Error("talosId must be a non-empty string");
  }

  if (!(input.asOf instanceof Date) || Number.isNaN(input.asOf.getTime())) {
    throw new Error("asOf must be a valid Date");
  }

  const sourcePolicyVersion = (input.sourcePolicyVersion ?? QUOTA_POLICY_VERSION).trim();
  if (!sourcePolicyVersion) {
    throw new Error("sourcePolicyVersion must be a non-empty string");
  }

  const seenResources = new Set<QuotaResource>();
  const entryMap = new Map<QuotaResource, QuotaWindowStatementEntry>();

  for (const item of input.resources) {
    if (!ALL_QUOTA_RESOURCES.includes(item.resource)) {
      throw new Error(`Unsupported quota resource: ${String(item.resource)}`);
    }
    if (seenResources.has(item.resource)) {
      throw new Error(`Duplicate quota resource in statement: ${item.resource}`);
    }
    seenResources.add(item.resource);

    const windowSize = assertValidWindowSize(item.windowSize);
    const limit = assertNonNegativeSafeInteger(item.limit, `${item.resource}.limit`);
    const used = assertNonNegativeSafeInteger(item.used, `${item.resource}.used`);
    const remaining = Math.max(0, limit - used);
    const overage = Math.max(0, used - limit);

    const windowStartDate = floorToWindow(input.asOf, windowSize);
    const windowEndDate = nextWindowStart(windowStartDate, windowSize);
    const windowStartMs = assertNonNegativeSafeInteger(
      windowStartDate.getTime(),
      `${item.resource}.windowStartMs`,
    );
    const windowEndMs = assertNonNegativeSafeInteger(
      windowEndDate.getTime(),
      `${item.resource}.windowEndMs`,
    );

    const policySource: QuotaPolicySource =
      item.policySource === "agent_override" ||
      item.policySource === "platform_default" ||
      item.policySource === "fallback"
        ? item.policySource
        : "fallback";

    entryMap.set(item.resource, {
      resource: item.resource,
      windowSize,
      windowStart: windowStartDate.toISOString(),
      windowEnd: windowEndDate.toISOString(),
      windowStartMs,
      windowEndMs,
      enabled: Boolean(item.enabled),
      policySource,
      limit,
      used,
      remaining,
      overage,
      withinQuota: used <= limit,
      unit: "requests",
    });
  }

  // Canonical ordering by ALL_QUOTA_RESOURCES so the statement is always reproducible.
  const entries: QuotaWindowStatementEntry[] = [];
  for (const resource of ALL_QUOTA_RESOURCES) {
    const entry = entryMap.get(resource);
    if (entry) {
      entries.push(entry);
    }
  }

  const totals = {
    resources: entries.length,
    limit: entries.reduce((sum, e) => sum + e.limit, 0),
    used: entries.reduce((sum, e) => sum + e.used, 0),
    remaining: entries.reduce((sum, e) => sum + e.remaining, 0),
    overage: entries.reduce((sum, e) => sum + e.overage, 0),
  };

  const canonicalPayload = {
    schemaVersion: QUOTA_STATEMENT_SCHEMA_VERSION,
    sourcePolicyVersion,
    talosId,
    entries,
    totals,
  };

  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalPayload))
    .digest("hex");

  return {
    ...canonicalPayload,
    digest,
  };
}

/**
 * Export a reproducible quota-window usage statement for one authorized agent
 * by reading its effective quota configs and usage counters for the window
 * containing `asOf` (defaults to current UTC time).
 */
export async function exportQuotaWindowStatement(
  db: Db,
  talosId: string,
  options?: { asOf?: Date; sourcePolicyVersion?: string },
): Promise<QuotaWindowUsageStatement> {
  const asOf = options?.asOf ?? new Date();
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new Error("asOf must be a valid Date");
  }

  const configRows = await db
    .select()
    .from(tlsQuotaConfigs)
    .where(
      or(
        eq(tlsQuotaConfigs.talosId, talosId),
        isNull(tlsQuotaConfigs.talosId),
      ),
    );

  const resources = await Promise.all(
    ALL_QUOTA_RESOURCES.map(async (resource): Promise<QuotaWindowStatementResourceInput> => {
      const [config, usage] = await Promise.all([
        resolveQuotaConfig(db, talosId, resource),
        readQuotaUsage(db, talosId, resource, asOf),
      ]);

      const hasAgentOverride = configRows.some(
        (r) => r.talosId === talosId && r.resource === resource,
      );
      const hasPlatformDefault = configRows.some(
        (r) => r.talosId === null && r.resource === resource,
      );

      const policySource: QuotaPolicySource = hasAgentOverride
        ? "agent_override"
        : hasPlatformDefault
          ? "platform_default"
          : "fallback";

      return {
        resource,
        windowSize: config.windowSize,
        enabled: config.enabled,
        policySource,
        limit: usage.limit,
        used: usage.used,
      };
    }),
  );

  return buildQuotaWindowStatement({
    talosId,
    asOf,
    sourcePolicyVersion: options?.sourcePolicyVersion,
    resources,
  });
}
