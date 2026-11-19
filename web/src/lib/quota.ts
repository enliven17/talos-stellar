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
import { tlsQuotaConfigs, tlsQuotaUsage } from "@/db/schema";
import type { db as appDb } from "@/db";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported resource identifiers. */
export type QuotaResource =
  | "activity_writes"
  | "job_writes"
  | "revenue_writes"
  | "sse_connections";

/** Window granularity options. */
export type WindowSize = "hourly" | "daily" | "monthly";

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
): Promise<QuotaResult> {
  const config = await resolveQuotaConfig(db, talosId, resource);

  const now = new Date();
  const windowStart = floorToWindow(now, config.windowSize);
  const resetAt = nextWindowStart(windowStart, config.windowSize).getTime();

  if (!config.enabled) {
    return {
      ok: true,
      limit: config.maxCount,
      remaining: config.maxCount,
      used: 0,
      resetAt,
      resource,
    };
  }

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

  const used = row?.count ?? 1;
  const remaining = Math.max(0, config.maxCount - used);
  const ok = used <= config.maxCount;

  return { ok, limit: config.maxCount, remaining, used, resetAt, resource };
}

/**
 * Read the current usage for (talosId, resource) in the current window WITHOUT
 * incrementing the counter.  Used by the admin quota route.
 */
export async function readQuotaUsage(
  db: Db,
  talosId: string,
  resource: QuotaResource,
  asOf: Date = new Date(),
): Promise<QuotaResult> {
  const config = await resolveQuotaConfig(db, talosId, resource);

  const windowStart = floorToWindow(asOf, config.windowSize);
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
