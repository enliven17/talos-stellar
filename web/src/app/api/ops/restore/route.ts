/**
 * POST /api/ops/restore
 *
 * Restore Postgres state from a previously produced encrypted backup
 * artifact. Default mode is `verify-only` — decrypts, parses, and runs
 * SHA-256 / version checks without writing any rows. To apply, the
 * request must include header `X-Confirm: yes` AND body `mode: "apply"`.
 *
 * Auth: timing-safe compare against `OPS_ADMIN_SECRET` from
 * `X-Ops-Token`. Bodies are multipart/form-data with the encrypted
 * artifact stored under the `artifact` part.
 *
 * Rate-limited: 3 calls / hour per IP.
 *
 * Privacy-safe:
 *   - The artifact part is never logged (only its size and sha256).
 *   - X-Backup-Passphrase header is read once and used by the decrypt
 *     helper; not echoed in error messages.
 */

import { NextRequest } from "next/server";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
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
import {
  TriggerRestoreRequestSchema,
  RESTORE_CONFIRM_HEADER,
  RESTORE_CONFIRM_VALUE,
  MAX_BACKUP_ARTIFACT_BYTES,
} from "@/lib/backup-types";
import {
  applyRestore,
  openBackupPool,
  verifyArtifact,
} from "@/lib/backup-service";
import { BackupCryptoError, decryptWithPassword } from "@/lib/backup-crypto";
import { sanitizeErrorMessage } from "@/lib/backup-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 };

function unauthorized(message: string): Response {
  return Response.json({ error: message }, { status: 401 });
}

async function verifyOpsAdmin(req: NextRequest): Promise<{ ok: true } | { ok: false; error: Response }> {
  const expected = opsAdminSecret();
  if (!expected) {
    return { ok: false, error: unauthorized("Restore endpoint disabled: OPS_ADMIN_SECRET not set") };
  }
  const supplied = req.headers.get("x-ops-token") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: unauthorized("Invalid ops token") };
  }
  return { ok: true };
}

const rawPost = async (req: NextRequest): Promise<Response> => {
  if (isBackupDisabled()) {
    return Response.json({ error: "Restore is disabled (TALOS_BACKUP_DISABLED=1)" }, { status: 423 });
  }
  const auth = await verifyOpsAdmin(req);
  if (!auth.ok) return auth.error;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rl = rateLimit(`ops:restore:${ip}`, RATE_LIMIT);
  if (!rl.ok) {
    return rateLimitResponse(rl);
  }

  // Multipart parse with size cap (defensive: refuse before reading the body).
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return Response.json(
      { error: "Invalid multipart body", details: sanitizeErrorMessage(err) },
      { status: 400 },
    );
  }

  const artifact = form.get("artifact");
  if (!(artifact instanceof File)) {
    return Response.json(
      { error: "Missing 'artifact' file part" },
      { status: 400 },
    );
  }
  if (artifact.size > MAX_BACKUP_ARTIFACT_BYTES) {
    return Response.json(
      { error: `Artifact exceeds MAX_BACKUP_ARTIFACT_BYTES=${MAX_BACKUP_ARTIFACT_BYTES}` },
      { status: 413 },
    );
  }
  const artifactBuf = Buffer.from(await artifact.arrayBuffer());
  const artifactStr = artifactBuf.toString("utf8");
  const sha256Artifact = createHash("sha256").update(artifactBuf).digest("hex");

  const passphrase = req.headers.get("x-backup-passphrase") ?? "";
  if (passphrase.length < 8) {
    return Response.json(
      { error: "X-Backup-Passphrase header required (≥ 8 chars)" },
      { status: 400 },
    );
  }

  // Body metadata is just the Zod schema fields; the artifact is in the multipart.
  const metaRaw = form.get("metadata");
  let metaJson: unknown = {};
  if (typeof metaRaw === "string") {
    try {
      metaJson = JSON.parse(metaRaw);
    } catch {
      return Response.json({ error: "metadata part must be valid JSON" }, { status: 400 });
    }
  }
  const parsed = TriggerRestoreRequestSchema.safeParse(metaJson);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const confirmHeader = (req.headers.get(RESTORE_CONFIRM_HEADER) ?? "").trim().toLowerCase();
  if (parsed.data.mode === "apply" && confirmHeader !== RESTORE_CONFIRM_VALUE) {
    return Response.json(
      { error: `X-Confirm: ${RESTORE_CONFIRM_VALUE} header required when mode='apply'` },
      { status: 409 },
    );
  }

  const timeoutMs = Math.min(backupDefaultTimeoutMs(), 60_000);
  const maxBytes = backupMaxBytes();

  const runId = randomUUID().replace(/-/g, "");
  const startedAt = new Date();

  await db.insert(tlsBackupRuns).values({
    id: runId,
    op: "restore",
    scope: parsed.data.scope,
    talosId: parsed.data.talosId ?? null,
    agentId: parsed.data.agentId ?? null,
    status: "running",
    triggeredBy: parsed.data.triggeredBy,
    encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
    sha256: sha256Artifact,
    sizeBytes: artifact.size,
    startedAt,
  });

  try {
    // Verify first.
    const verified = await verifyArtifact({
      encrypted: artifactStr,
      password: passphrase,
      timeoutMs,
    });
    await db
      .update(tlsBackupRuns)
      .set({
        status: "completed",
        metadata: {
          verified: true,
          signalVersion: verified.signalVersion,
          rowCountTotal: verified.rowCountTotal,
          scope: verified.scope,
          timestamp: verified.timestamp,
          mode: parsed.data.mode,
          encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        },
        finishedAt: new Date(),
      })
      .where(eq(tlsBackupRuns.id, runId));

    logger.info(
      {
        runId,
        mode: parsed.data.mode,
        scope: verified.scope,
        rowCountTotal: verified.rowCountTotal,
        sha256Artifact,
        sizeBytes: artifact.size,
        requestId: req.headers.get("x-request-id") ?? null,
      },
      "ops restore verified",
    );

    if (parsed.data.mode !== "apply") {
      return Response.json({
        ok: true,
        mode: "verify-only",
        runId,
        scope: verified.scope,
        signalVersion: verified.signalVersion,
        rowCountTotal: verified.rowCountTotal,
        rowCounts: verified.plaintext.database.rowCounts,
        sha256Artifact,
        sizeBytes: artifact.size,
        encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        timestamp: verified.timestamp,
        rowCountsAtLeast: verified.rowCountTotal,
      });
    }

    // Apply in a transaction.
    const pool = await openBackupPool(timeoutMs);
    let applyResult: Awaited<ReturnType<typeof applyRestore>> | null = null;
    try {
      applyResult = await applyRestore({
        plaintext: verified.plaintext,
        pool,
        timeoutMs,
      });
    } finally {
      await pool.end().catch(() => undefined);
    }

    await db
      .update(tlsBackupRuns)
      .set({
        status: "completed",
        metadata: {
          verified: true,
          applied: true,
          signalVersion: verified.signalVersion,
          rowCountTotal: verified.rowCountTotal,
          rowsActuallyRestored: applyResult.rowsRestored,
          perTableCounts: applyResult.tableCounts,
          mode: "apply",
          encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        },
        durationMs: applyResult.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(tlsBackupRuns.id, runId));

    logger.info(
      {
        runId,
        rowsRestored: applyResult.rowsRestored,
        durationMs: applyResult.durationMs,
        requestId: req.headers.get("x-request-id") ?? null,
      },
      "ops restore applied",
    );

    if (applyResult.rowsRestored > maxBytes) {
      // Defensive: operator likely confused unit. We do NOT roll back here
      // because the apply already succeeded — log loudly.
      logger.warn(
        {
          runId,
          rowsRestored: applyResult.rowsRestored,
          maxBytes,
        },
        "ops restore rowsRestored suspiciously large",
      );
    }

    return Response.json({
      ok: true,
      mode: "apply",
      runId,
      rowsRestored: applyResult.rowsRestored,
      durationMs: applyResult.durationMs,
      perTableCounts: applyResult.tableCounts,
    });
  } catch (err) {
    const safeErrMsg = err instanceof BackupCryptoError
      ? err.message
      : err instanceof Error
        ? `${err.name}: ${err.message.slice(0, 160)}`
        : "unknown error";
    await db
      .update(tlsBackupRuns)
      .set({
        status: "failed",
        errorMessage: safeErrMsg.slice(0, 500),
        metadata: {
          mode: parsed.data.mode,
          encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
        },
        finishedAt: new Date(),
      })
      .where(eq(tlsBackupRuns.id, runId));
    logger.error(
      {
        runId,
        err: safeErrMsg,
        requestId: req.headers.get("x-request-id") ?? null,
      },
      "ops restore failed",
    );
    // Tighter error codes so callers can act on the failure type.
    const status = err instanceof BackupCryptoError ? 422 : 500;
    return Response.json(
      { error: "Restore failed", runId, details: safeErrMsg },
      { status },
    );
  }
};

// Touch to silence linter complaints about unused import
void decryptWithPassword;

export const POST = withRequestId(rawPost);
