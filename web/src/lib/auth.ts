import { NextRequest } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/db";
import { tlsTalos, tlsApiAuditLogs, tlsApiKeys } from "@/db/schema";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import { withTransactionRetry } from "@/db/db-retry";
import {
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  computeEntryHash,
  isAuditChainEnabled,
  type AuditChainEntry,
} from "@/lib/audit-chain";
import { logger } from "@/lib/logger";
import { enqueue, jobsConfig } from "@/lib/jobs";
import { AUDIT_LOG_WRITE_QUEUE } from "@/lib/jobs/handlers/audit-log";

export const VALID_SCOPES = [
  "admin",
  "activity:write",
  "commerce:read",
  "commerce:write",
  "wallet:read",
  "wallet:sign",
  "settings:read",
  "settings:write",
  "revenue:read",
  "revenue:write",
] as const;

export type Scope = typeof VALID_SCOPES[number];
// Backwards-compatible name used by route authorization tests and consumers.
export type ApiScope = Scope;

/**
 * Generate a new scoped API key.
 * Returns the raw key (shown once) and its SHA-256 hash (stored in DB).
 */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = `tak_${randomBytes(32).toString("hex")}`;
  return { raw, hash: hashApiKey(raw) };
}

/**
 * Hash an API key using SHA-256.
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Extract the Bearer token from the Authorization header.
 * Returns null if missing or malformed.
 */
function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Verify API key from Authorization header against the TALOS's stored key.
 * Returns the talos record if valid, or a Response error to return early.
 *
 * All authenticated requests are logged to tls_api_audit_logs for security
 * hardening (key rotation auditing, anomaly detection, scope tracking).
 *
 * When the audit hash chain is enabled, each log entry is cryptographically
 * chained to the previous entry via SHA-256 hashing, making the log
 * tamper-evident.
 */
export async function verifyAgentApiKey(
  request: NextRequest,
  talosId: string,
  requiredScopes: Scope[] = [],
): Promise<
  | { ok: true; talos: { id: string } }
  | { ok: false; response: Response }
> {
  const token = extractBearerToken(request);

  if (!token) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 },
      ),
    };
  }

  const tokenHash = hashApiKey(token);

  const talos = await db
    .select({ id: tlsTalos.id, legacyApiKey: tlsTalos.apiKey })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, talosId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!talos) {
    return {
      ok: false,
      response: Response.json({ error: "TALOS not found" }, { status: 404 }),
    };
  }

  // 1. Try to match a scoped key
  const scopedKey = await db
    .select({ id: tlsApiKeys.id, scopes: tlsApiKeys.scopes, expiresAt: tlsApiKeys.expiresAt, status: tlsApiKeys.status })
    .from(tlsApiKeys)
    .where(
      and(
        eq(tlsApiKeys.talosId, talosId),
        eq(tlsApiKeys.keyHash, tokenHash),
        eq(tlsApiKeys.status, "active"),
      )
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  let authorized = false;
  let hasRequiredScopes = false;

  if (scopedKey) {
    if (scopedKey.status !== "active") {
      logger.warn({ talosId, keyId: scopedKey.id }, "auth.key.revoked");
      const isRevoked = scopedKey.status === "revoked";
      writeAuditLog(
        talos.id,
        request,
        403,
        isRevoked ? "revoked_key" : "inactive_key",
        requiredScopes,
      ).catch(() => {});
      return {
        ok: false,
        response: Response.json(
          { error: isRevoked ? "API key has been revoked" : "API key is not active" },
          { status: 403 },
        ),
      };
    }

    // Check expiry
    if (scopedKey.expiresAt && scopedKey.expiresAt < new Date()) {
      logger.warn({ talosId, keyId: scopedKey.id }, "auth.key.expired");
      writeAuditLog(talos.id, request, 403, "expired_key", requiredScopes).catch(() => {});
      return {
        ok: false,
        response: Response.json({ error: "API key has expired" }, { status: 403 }),
      };
    }

    authorized = true;
    // Update lastUsedAt in the background
    db.update(tlsApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(tlsApiKeys.id, scopedKey.id))
      .execute()
      .catch(() => {});

    hasRequiredScopes = requiredScopes.every(
      (scope) =>
        (scopedKey.scopes as string[]).includes(scope) || (scopedKey.scopes as string[]).includes("admin")
    );

    logger.info({ talosId, keyId: scopedKey.id, path: new URL(request.url).pathname }, "auth.key.resolved");
  } else if (talos.legacyApiKey) {
    // 2. Fallback to legacy API key
    if (
      talos.legacyApiKey.length === token.length &&
      timingSafeEqual(Buffer.from(talos.legacyApiKey), Buffer.from(token))
    ) {
      authorized = true;
      // Legacy keys are granted all scopes (admin equivalent) for backward compatibility
      hasRequiredScopes = true;

      logger.info({ talosId, path: new URL(request.url).pathname }, "auth.key.resolved (legacy)");
    }
  }

  if (!authorized) {
    logger.warn({ talosId, path: new URL(request.url).pathname }, "auth.key.denied");
    writeAuditLog(talos.id, request, 403, "invalid_key", requiredScopes).catch(() => {});
    return {
      ok: false,
      response: Response.json({ error: "Invalid API key" }, { status: 403 }),
    };
  }

  if (!hasRequiredScopes) {
    logger.warn({ talosId, requiredScopes, path: new URL(request.url).pathname }, "auth.scope.denied");
    writeAuditLog(talos.id, request, 403, "insufficient_scopes", requiredScopes).catch(() => {});
    return {
      ok: false,
      response: Response.json({ error: "Insufficient scopes", required: requiredScopes }, { status: 403 }),
    };
  }

  writeAuditLog(talos.id, request, 200).catch(() => {});

  return { ok: true, talos: { id: talos.id } };
}

/**
 * Resolve calling TALOS identity from Authorization header without a target talosId parameter.
 * Used by agent-initiated routes like /api/talos/me, /api/jobs/pending, /api/playbooks.
 */
export async function resolveTalosFromRequest(
  request: NextRequest,
  requiredScopes: Scope[] = [],
): Promise<
  | { ok: true; talos: Record<string, unknown> & { id: string } }
  | { ok: false; response: Response }
> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 },
      ),
    };
  }

  const tokenHash = hashApiKey(token);

  // 1. Try to match a scoped key
  const scopedKey = await db
    .select({
      id: tlsApiKeys.id,
      talosId: tlsApiKeys.talosId,
      scopes: tlsApiKeys.scopes,
      expiresAt: tlsApiKeys.expiresAt,
    })
    .from(tlsApiKeys)
    .where(
      and(
        eq(tlsApiKeys.keyHash, tokenHash),
        eq(tlsApiKeys.status, "active")
      )
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  if (scopedKey) {
    if (scopedKey.expiresAt && scopedKey.expiresAt < new Date()) {
      logger.warn({ talosId: scopedKey.talosId, keyId: scopedKey.id }, "auth.key.expired");
      writeAuditLog(scopedKey.talosId, request, 403, "expired_key", requiredScopes).catch(() => {});
      return {
        ok: false,
        response: Response.json({ error: "API key has expired" }, { status: 403 }),
      };
    }

    const hasRequiredScopes = requiredScopes.every(
      (scope) =>
        (scopedKey.scopes as string[]).includes(scope) || (scopedKey.scopes as string[]).includes("admin")
    );

    if (!hasRequiredScopes) {
      logger.warn({ talosId: scopedKey.talosId, requiredScopes, path: new URL(request.url).pathname }, "auth.scope.denied");
      writeAuditLog(scopedKey.talosId, request, 403, "insufficient_scopes", requiredScopes).catch(() => {});
      return {
        ok: false,
        response: Response.json({ error: "Insufficient scopes", required: requiredScopes }, { status: 403 }),
      };
    }

    db.update(tlsApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(tlsApiKeys.id, scopedKey.id))
      .execute()
      .catch(() => {});

    const talos = await db
      .select()
      .from(tlsTalos)
      .where(eq(tlsTalos.id, scopedKey.talosId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return {
        ok: false,
        response: Response.json({ error: "TALOS not found" }, { status: 404 }),
      };
    }

    logger.info({ talosId: talos.id, keyId: scopedKey.id, path: new URL(request.url).pathname }, "auth.key.resolved");
    writeAuditLog(talos.id, request, 200).catch(() => {});

    const { apiKey, ...safeTalos } = talos;
    return { ok: true, talos: safeTalos as Record<string, unknown> & { id: string } };
  }

  // 2. Fallback to legacy key matching across TALOS rows
  const allTalos = await db
    .select()
    .from(tlsTalos)
    .where(isNotNull(tlsTalos.apiKey));

  for (const talosRow of allTalos) {
    if (
      talosRow.apiKey &&
      talosRow.apiKey.length === token.length &&
      timingSafeEqual(Buffer.from(talosRow.apiKey), Buffer.from(token))
    ) {
      logger.info({ talosId: talosRow.id, path: new URL(request.url).pathname }, "auth.key.resolved (legacy)");
      writeAuditLog(talosRow.id, request, 200).catch(() => {});

      const { apiKey, ...safeTalos } = talosRow;
      return { ok: true, talos: safeTalos as Record<string, unknown> & { id: string } };
    }
  }

  logger.warn({ path: new URL(request.url).pathname }, "auth.key.denied");
  return {
    ok: false,
    response: Response.json({ error: "Invalid API key" }, { status: 403 }),
  };
}

/**
 * Persist one audit log entry. Called fire-and-forget — must not throw.
 *
 * When JOBS_ENABLED=true, this durably enqueues the write instead of
 * inserting directly: a transient DB error is retried with backoff by the
 * job worker rather than silently dropping the audit entry.
 */
async function writeAuditLog(
  talosId: string,
  request: NextRequest,
  statusCode: number,
  denialReason?: string,
  scopesRequired?: Scope[],
): Promise<void> {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    null;

  const url = new URL(request.url);

  if (jobsConfig.enabled) {
    await enqueue(AUDIT_LOG_WRITE_QUEUE, {
      talosId,
      method: request.method,
      path: url.pathname,
      statusCode,
      ipAddress: ip,
      denialReason: denialReason ?? null,
      scopesRequired: scopesRequired ?? null,
    }).catch(() => {});
    return;
  }

  if (isAuditChainEnabled()) {
    await writeAuditLogWithChain(talosId, request.method, url.pathname, statusCode, ip, denialReason, scopesRequired);
  } else {
    await db.insert(tlsApiAuditLogs).values({
      talosId,
      method: request.method,
      path: url.pathname,
      statusCode,
      ipAddress: ip,
      denialReason: denialReason ?? null,
      scopesRequired: scopesRequired ?? null,
    });
  }
}

/**
 * Write an audit log entry with a tamper-evident hash chain.
 */
async function writeAuditLogWithChain(
  talosId: string,
  method: string,
  path: string,
  statusCode: number,
  ipAddress: string | null,
  denialReason?: string,
  scopesRequired?: Scope[],
): Promise<void> {
  const now = new Date();
  const createdAt = now.toISOString();

  try {
    await withTransactionRetry(
      async (tx) => {
        const latestRows = await tx
          .select({
            sequenceNumber: tlsApiAuditLogs.sequenceNumber,
            entryHash: tlsApiAuditLogs.entryHash,
          })
          .from(tlsApiAuditLogs)
          .where(eq(tlsApiAuditLogs.talosId, talosId))
          .orderBy(desc(tlsApiAuditLogs.createdAt))
          .limit(1);

        const latest = latestRows[0] ?? null;

        const sequenceNumber = (latest?.sequenceNumber ?? -1) + 1;
        const previousHash = latest?.entryHash ?? GENESIS_HASH;

        const entry: AuditChainEntry = {
          sequenceNumber,
          talosId,
          method,
          path,
          statusCode,
          ipAddress,
          createdAt,
        };

        const entryHash = computeEntryHash(entry);

        await tx.insert(tlsApiAuditLogs).values({
          talosId,
          method,
          path,
          statusCode,
          ipAddress,
          denialReason: denialReason ?? null,
          scopesRequired: scopesRequired ?? null,
          sequenceNumber,
          previousHash,
          entryHash,
          chainVersion: AUDIT_CHAIN_VERSION,
          createdAt: now,
        });
      },
      { category: "JOB" },
    );
  } catch (err) {
    logger.error(
      { err, talosId, method, path, statusCode },
      "audit_chain_write_error",
    );
  }
}
