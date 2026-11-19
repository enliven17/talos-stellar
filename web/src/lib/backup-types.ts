/**
 * Typed interfaces + Zod schemas for backup/restore admin endpoints.
 *
 * Privacy-safe by construction:
 *   - Free-form `metadata` fields must be explicitly enumerated; arbitrary
 *     operator secrets or webhook bodies cannot be smuggled in.
 *   - Server-side errors are wrapped in `sanitizeErrorMessage` to never
 *     echo back base64 ciphertext or internal paths.
 */

import { z } from "zod";

export const BACKUP_RUN_OPS = ["backup", "restore", "verify"] as const;
export const BACKUP_RUN_SCOPES = ["system", "config"] as const;
export const BACKUP_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type BackupRunOp = (typeof BACKUP_RUN_OPS)[number];
export type BackupRunScope = (typeof BACKUP_RUN_SCOPES)[number];
export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

// Envelope persisted in `tlsAPI_audit_logs.metadata` for restore API calls.
export const AuditMetadataSchema = z.object({
  talosId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  rowsRestored: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  encryption: z.string().nullable().optional(),
});

// POST /api/ops/backup body
export const TriggerBackupRequestSchema = z.object({
  scope: z.enum(BACKUP_RUN_SCOPES),
  talosId: z.string().min(1).max(256).nullable().optional(),
  agentId: z.string().min(1).max(256).nullable().optional(),
  triggeredBy: z.string().min(1).max(64).default("api"),
});

export type TriggerBackupRequest = z.infer<typeof TriggerBackupRequestSchema>;

// POST /api/ops/restore body — artifact is uploaded as multipart so we don't
// accept the blob in JSON. Body fields are minimal: just identifiers for
// auditing. The actual artifact arrives in the multipart part named
// "artifact".
export const TriggerRestoreRequestSchema = z.object({
  mode: z.enum(["verify-only", "apply"]).default("verify-only"),
  scope: z.enum(BACKUP_RUN_SCOPES),
  talosId: z.string().min(1).max(256).nullable().optional(),
  agentId: z.string().min(1).max(256).nullable().optional(),
  triggeredBy: z.string().min(1).max(64).default("api"),
});

export type TriggerRestoreRequest = z.infer<typeof TriggerRestoreRequestSchema>;

// GET /api/ops/backup/status query
export const BackupStatusQuerySchema = z.object({
  scope: z.enum(BACKUP_RUN_SCOPES).optional(),
  op: z.enum(BACKUP_RUN_OPS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BackupStatusQuery = z.infer<typeof BackupStatusQuerySchema>;

// 5 MiB upper bound for artifact uploads — way above any plausible pg_dump
// for this schema footprint, but still defensive against disk-fill DoS.
export const MAX_BACKUP_ARTIFACT_BYTES = 5 * 1024 * 1024;

// Confirm-destructive header. Required for `mode: "apply"` restores.
export const RESTORE_CONFIRM_HEADER = "x-confirm";
export const RESTORE_CONFIRM_VALUE = "yes";

/**
 * Sanitise an error message so server-side details (paths, base64 blobs,
 * stack frames, secrets) never leak through operator-facing APIs.
 *
 * Replaces anything that looks like an ENC:: blob, a long hex/base64 string,
 * or an absolute filesystem path with `*`. Caps total output length.
 */
export function sanitizeErrorMessage(raw: unknown, maxLen = 200): string {
  if (raw == null) return "unknown error";
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (raw instanceof Error) s = raw.message;
  else {
    try {
      s = JSON.stringify(raw);
    } catch {
      s = String(raw);
    }
  }
  // ENC:: base64 blob
  s = s.replace(/ENC::[A-Za-z0-9+/=]+/g, "*");
  // 32+ char hex/base64 blobs (tokens, keys, hashes leaked into stray msg)
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, "*");
  s = s.replace(/\b[A-Za-z0-9+/=]{64,}={0,2}\b/g, "*");
  // /var/..., \Users\..., home paths
  s = s.replace(/\/[\w./-]+\.(?:sql|tar\.[gx]z|enc|json|dump)/g, "*");
  s = s.replace(/(?:\/|\\)(?:[\w.-]+\/)+[\w.-]+/g, "*");
  // Pin to single line for log readability.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s || "unknown error";
}
