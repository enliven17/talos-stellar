import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsQuotaConfigs } from "@/db/schema";
import { eq, isNull, or, and } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import {
  readQuotaUsage,
  resolveQuotaConfig,
  ALL_QUOTA_RESOURCES,
  type QuotaResource,
} from "@/lib/quota";

/**
 * GET /api/talos/:id/quota
 *
 * Returns the current quota configuration and live usage for all resources
 * associated with the specified TALOS agent.
 *
 * Authentication
 * ──────────────
 * Requires a valid Bearer API key (same as other agent-authenticated routes).
 *
 * Response shape
 * ──────────────
 * {
 *   talosId: string,
 *   quotas: {
 *     [resource]: {
 *       config: {
 *         maxCount: number,
 *         windowSize: "hourly" | "daily" | "monthly",
 *         enabled: boolean,
 *         isAgentOverride: boolean,   // true when agent-specific config exists
 *         notes: string | null,
 *       },
 *       usage: {
 *         used: number,
 *         remaining: number,
 *         limit: number,
 *         resetAt: string,            // ISO-8601 datetime
 *         ok: boolean,
 *       },
 *     }
 *   }
 * }
 *
 * The response intentionally includes disabled resources so operators can
 * see all available quota slots even before they are enabled.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Agent must authenticate with its own API key
  const auth = await verifyAgentApiKey(request, id);
  if (!auth.ok) return auth.response;

  // Confirm the TALOS exists (auth already does this, but keep it explicit)
  const talos = await db
    .select({ id: tlsTalos.id })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, id))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!talos) {
    return Response.json({ error: "TALOS not found" }, { status: 404 });
  }

  // Fetch all quota config rows for this agent and the platform defaults in
  // one query to avoid N+1 database calls.
  const configRows = await db
    .select()
    .from(tlsQuotaConfigs)
    .where(
      or(
        eq(tlsQuotaConfigs.talosId, id),
        isNull(tlsQuotaConfigs.talosId),
      ),
    );

  // Build the response for each resource in parallel
  const quotaEntries = await Promise.all(
    ALL_QUOTA_RESOURCES.map(async (resource: QuotaResource) => {
      const [config, usage] = await Promise.all([
        resolveQuotaConfig(db, id, resource),
        readQuotaUsage(db, id, resource),
      ]);

      const isAgentOverride = configRows.some(
        (r) => r.talosId === id && r.resource === resource,
      );

      return [
        resource,
        {
          config: {
            maxCount: config.maxCount,
            windowSize: config.windowSize,
            enabled: config.enabled,
            isAgentOverride,
            notes: config.notes ?? null,
          },
          usage: {
            used: usage.used,
            remaining: usage.remaining,
            limit: usage.limit,
            resetAt: new Date(usage.resetAt).toISOString(),
            ok: usage.ok,
          },
        },
      ] as const;
    }),
  );

  return Response.json({
    talosId: id,
    quotas: Object.fromEntries(quotaEntries),
  });
}

/**
 * PATCH /api/talos/:id/quota
 *
 * Upsert a per-agent quota override for a specific resource.
 * Requires admin/operator authentication (checks ADMIN_API_KEY env var or
 * falls back to the agent's own API key for self-service adjustments).
 *
 * Body: {
 *   resource: QuotaResource,
 *   maxCount?: number,       // New limit (must be > 0)
 *   windowSize?: WindowSize, // "hourly" | "daily" | "monthly"
 *   enabled?: boolean,       // Enable or disable enforcement
 *   notes?: string,          // Admin notes
 * }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Require agent API key — only the agent itself (or an operator who knows
  // its key) can adjust its own quotas via this self-service endpoint.
  const auth = await verifyAgentApiKey(request, id);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    resource,
    maxCount,
    windowSize,
    enabled,
    notes,
  } = body as Record<string, unknown>;

  // Validate resource
  if (!resource || !ALL_QUOTA_RESOURCES.includes(resource as QuotaResource)) {
    return Response.json(
      { error: `resource must be one of: ${ALL_QUOTA_RESOURCES.join(", ")}` },
      { status: 400 },
    );
  }

  // Validate maxCount if provided
  if (maxCount !== undefined) {
    if (typeof maxCount !== "number" || !Number.isInteger(maxCount) || maxCount < 1) {
      return Response.json(
        { error: "maxCount must be a positive integer" },
        { status: 400 },
      );
    }
  }

  // Validate windowSize if provided
  const validWindowSizes = ["hourly", "daily", "monthly"];
  if (windowSize !== undefined && !validWindowSizes.includes(windowSize as string)) {
    return Response.json(
      { error: `windowSize must be one of: ${validWindowSizes.join(", ")}` },
      { status: 400 },
    );
  }

  // Validate enabled if provided
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return Response.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }

  // Resolve current config to use as defaults when fields are omitted
  const current = await resolveQuotaConfig(db, id, resource as QuotaResource);

  const newMaxCount = typeof maxCount === "number" ? maxCount : current.maxCount;
  const newWindowSize = typeof windowSize === "string" ? windowSize : current.windowSize;
  const newEnabled = typeof enabled === "boolean" ? enabled : current.enabled;
  const newNotes = typeof notes === "string" ? notes : current.notes;

  // Upsert the agent-specific config row
  await db
    .insert(tlsQuotaConfigs)
    .values({
      talosId: id,
      resource: resource as string,
      maxCount: newMaxCount,
      windowSize: newWindowSize,
      enabled: newEnabled,
      notes: newNotes ?? null,
    })
    .onConflictDoUpdate({
      target: [tlsQuotaConfigs.talosId, tlsQuotaConfigs.resource],
      set: {
        maxCount: newMaxCount,
        windowSize: newWindowSize,
        enabled: newEnabled,
        notes: newNotes ?? null,
      },
    });

  const [updatedConfig, usage] = await Promise.all([
    resolveQuotaConfig(db, id, resource as QuotaResource),
    readQuotaUsage(db, id, resource as QuotaResource),
  ]);

  return Response.json({
    talosId: id,
    resource,
    config: {
      maxCount: updatedConfig.maxCount,
      windowSize: updatedConfig.windowSize,
      enabled: updatedConfig.enabled,
      isAgentOverride: true,
      notes: updatedConfig.notes ?? null,
    },
    usage: {
      used: usage.used,
      remaining: usage.remaining,
      limit: usage.limit,
      resetAt: new Date(usage.resetAt).toISOString(),
      ok: usage.ok,
    },
  });
}
