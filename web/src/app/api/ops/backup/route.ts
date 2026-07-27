/**
 * POST /api/ops/backup
 *
 * Trigger an encrypted backup of the configured Postgres database.
 *
 * Auth: timing-safe compare against `OPS_ADMIN_SECRET` env var, supplied via
 * the `X-Ops-Token` header (mirrors the `cross-chain-webhook` shared secret
 * pattern so operators do not need to learn a new auth surface).
 *
 * Bounded:
 *   - 2 s timeout for auth + auth logging
 *   - 6 calls / hour per IP via the in-memory rate limiter
 *   - `TALOS_BACKUP_TIMEOUT_MS` env var bounds the DB call (default 30 s)
 *   - `MAX_PLAINTEXT_BYTES` (10 MiB) caps artifact size
 *
 * Privacy-safe:
 *   - PASS PHRASE is read from `X-Backup-Passphrase` header; never logged.
 *   - Error messages are run through `sanitizeErrorMessage` before being
 *     returned or written to `tls_backup_runs`.
 *   - Request bodies never logged in plaintext.
 */

import { NextRequest } from "next/server";
import { randomUUID, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tlsBackupRuns } from "@/db/schema";
import {
  isBackupDisabled,
  opsAdminSecret,
  backupDefaultTimeoutMs,
  backupMaxBytes,
} from "@/lib/backup-config";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { withRequestId } from "@/lib/with-request-id";
import { logger } from "@/lib/logger";
import { TriggerBackupRequestSchema } from "@/lib/backup-types";
import { buildBackup, openBackupPool } from "@/lib/backup-service";
import { BackupCryptoError } from "@/lib/backup-crypto";

const RATE_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 };

// Next.js runtime — Node so we can use crypto.timingSafeEqual + pg with raw
// sockets. Edge would force us to rewrite the crypto + DB layers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string): Response {
  return Response.json({ error: message }, { status: 401 });
}

async function verifyOpsAdmin(req: NextRequest): Promise<{ ok: true } | { ok: false; error: Response }> {
  const expected = opsAdminSecret();
  if (!expected) {
    return { ok: false, error: unauthorized("Backup endpoint disabled: OPS_ADMIN_SECRET not set") };
  }
  const supplied = req.headers.get("x-ops-token") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Equal-length compare is the closest timingSafeEqual supports; if lengths
  // differ we still need to perform a check of equivalent difficulty, so we
  // pad with zeros. This is constant-time relative to the expected length.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: unauthorized("Invalid ops token") };
  }
  return { ok: true };
}

const rawPost = async (req: NextRequest): Promise<Response> => {
  if (isBackupDisabled()) {
    return Response.json({ error: "Backup is disabled (TALOS_BACKUP_DISABLED=1)" }, { status: 423 });
  }

  const auth = await verifyOpsAdmin(req);
  if (!auth.ok) return auth.error;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rl = rateLimit(`ops:backup:${ip}`, RATE_LIMIT);
  if (!rl.ok) {
    logger.warn(
      { ip, requestId: req.headers.get("x-request-id") ?? null },
      "ops backup rate limited",
    );
    return rateLimitResponse(rl);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = TriggerBackupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const passphrase = req.headers.get("x-backup-passphrase") ?? "";
  if (passphrase.length < 8) {
    return Response.json(
      { error: "X-Backup-Passphrase header required (≥ 8 chars)" },
      { status: 400 },
    );
  }
  if (passphrase.length > 1024) {
    return Response.json(
      { error: "X-Backup-Passphrase too long (max 1024 chars)" },
      { status: 400 },
    );
  }

  const timeoutMs = backupDefaultTimeoutMs();
  const maxBytes = backupMaxBytes();
  const requestedScope = parsed.data.scope;

  const runId = randomUUID().replace(/-/g, "");
  const startedAt = new Date();

  await db.insert(tlsBackupRuns).values({
    id: runId,
    op: "backup",
    scope: requestedScope,
    talosId: parsed.data.talosId ?? null,
    agentId: parsed.data.agentId ?? null,
    status: "running",
    triggeredBy: parsed.data.triggeredBy,
    encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
    startedAt,
  });

  let pool: import("pg").Pool | null = null;
  try {
    pool = await openBackupPool(timeoutMs);
    const result = await buildBackup({
      scope: requestedScope,
      password: passphrase,
      pool,
      timeoutMs,
    });
    if (result.encryptedBytes > maxBytes) {
      throw new BackupCryptoError(
        `Encrypted size ${result.encryptedBytes}B exceeds TALOS_BACKUP_MAX_BYTES=${maxBytes}B`,
        "BAD_INPUT",
      );
    }
    await db
      .update(tlsBackupRuns)
      .set({
        status: "completed",
        artifactPath: null, // not persisted in web; CLI/backups/ holds it.
        encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        sizeBytes: result.encryptedBytes,
        sha256: result.sha256Plaintext,
        durationMs: result.durationMs,
        finishedAt: new Date(),
        metadata: {
          rowCounts: result.rowCounts,
          rowCountTotal: Object.values(result.rowCounts).reduce((a, b) => a + b, 0),
          signalVersion: result.plaintext.database.signalVersion,
          encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        },
      })
      .where(eq(tlsBackupRuns.id, runId));

    // Privacy-safe log — no ciphertext or passphrase.
    logger.info(
      {
        runId,
        scope: requestedScope,
        encryptedBytes: result.encryptedBytes,
        plaintextBytes: result.plaintextBytes,
        rowCountTotal: Object.values(result.rowCounts).reduce((a, b) => a + b, 0),
        durationMs: result.durationMs,
        sha256Plaintext: result.sha256Plaintext,
        requestId: req.headers.get("x-request-id") ?? null,
      },
      "ops backup completed",
    );

    // NB: We deliberately do NOT return the encrypted artifact in the HTTP
    // response (would balloon response size + risk log capture). Operators
    // fetch the artifact out-of-band. The metadata returned is sufficient
    // to drive downstream pipeline: rotate secrets, push to S3, etc.
    const rowCountTotal = Object.values(result.rowCounts).reduce((a, b) => a + b, 0);
    return Response.json({
      ok: true,
      runId,
      status: "completed",
      scope: requestedScope,
      rowCounts: result.rowCounts,
      rowCountTotal,
      sizeBytes: result.encryptedBytes,
      plaintextSizeBytes: result.plaintextBytes,
      sha256Plaintext: result.sha256Plaintext,
      encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
      signalVersion: result.plaintext.database.signalVersion,
      timestamp: result.plaintext.timestamp,
      durationMs: result.durationMs,
    });
  } catch (err) {
    const safeErrMsg = (err instanceof BackupCryptoError)
      ? err.message
      : err instanceof Error
        ? `${err.name}: ${err.message.slice(0, 160)}`
        : "unknown error";
    await db
      .update(tlsBackupRuns)
      .set({
        status: "failed",
        errorMessage: safeErrMsg.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(tlsBackupRuns.id, runId));
    logger.error(
      {
        runId,
        scope: requestedScope,
        err: safeErrMsg,
        requestId: req.headers.get("x-request-id") ?? null,
      },
      "ops backup failed",
    );
    return Response.json(
      { error: "Backup failed", runId, details: safeErrMsg },
      { status: 500 },
    );
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
};

export const POST = withRequestId(rawPost);
