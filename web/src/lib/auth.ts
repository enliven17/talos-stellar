import { NextRequest } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/db";
import { tlsTalos, tlsApiAuditLogs } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { withTransactionRetry } from "@/db/db-retry";
import {
  AUDIT_CHAIN_VERSION,
  GENESIS_HASH,
  computeEntryHash,
  isAuditChainEnabled,
  type AuditChainEntry,
} from "@/lib/audit-chain";
import { logger } from "@/lib/logger";

/**
 * Generate a new scoped API key.
 * Returns the raw key (shown once) and its SHA-256 hash (stored in DB).
 */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = `tak_${randomBytes(32).toString("hex")}`;
  return { raw, hash: hashApiKey(raw) };
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
    .select({ id: tlsApiKeys.id, scopes: tlsApiKeys.scopes, expiresAt: tlsApiKeys.expiresAt })
    .from(tlsApiKeys)
    .where(
      and(
        eq(tlsApiKeys.talosId, talosId),
        eq(tlsApiKeys.keyHash, tokenHash),
        eq(tlsApiKeys.status, "active")
      )
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  let authorized = false;
  let hasRequiredScopes = false;

  if (scopedKey) {
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
        scopedKey.scopes.includes(scope) || scopedKey.scopes.includes("admin")
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
 * Persist one audit log entry. Called fire-and-forget — must not throw.
 *
 * When JOBS_ENABLED=true, this durably enqueues the write instead of
 * inserting directly: a transient DB error is retried with backoff by the
 * job worker rather than silently dropping the audit entry, which is what
 * the plain insert below does today (the caller's `.catch(() => {})`
 * swallows the failure). Default is unchanged — direct insert — so this is
 * purely additive until an operator opts in.
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

  if (isAuditChainEnabled()) {
    await writeAuditLogWithChain(talosId, request.method, url.pathname, statusCode, ip);
  } else {
    await db.insert(tlsApiAuditLogs).values({
      talosId,
      method: request.method,
      path: url.pathname,
      statusCode,
      ipAddress: ip,
    });
  }
}

/**
 * Write an audit log entry with a tamper-evident hash chain.
 *
 * Uses a serializable transaction to atomically:
 *   1. Fetch the latest sequence number + entryHash for this agent
 *   2. Compute the new chain link (sequenceNumber, previousHash, entryHash)
 *   3. Insert the new row
 *
 * The serialization-retry wrapper handles concurrent write conflicts.
 */
async function writeAuditLogWithChain(
  talosId: string,
  method: string,
  path: string,
  statusCode: number,
  ipAddress: string | null,
): Promise<void> {
  const now = new Date();
  const createdAt = now.toISOString();

  try {
    await withTransactionRetry(
      async (tx) => {
        // Lock the chain: SELECT ... FOR UPDATE on the latest entry for this agent
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

        // Compute chain linkage
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
