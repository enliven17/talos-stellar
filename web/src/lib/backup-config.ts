/**
 * Backup module config helpers.
 *
 * Single source of truth for env-driven knobs. Operators may disable the
 * backup module entirely with `TALOS_BACKUP_DISABLED=1` to satisfy the
 * "explicitly gated rollout" acceptance criterion.
 *
 * REQUIRED for backup module to function:
 *   - OPS_ADMIN_SECRET  (shared secret; timing-safe compare against
 *     Authorization: Bearer <secret> header or X-Ops-Token header)
 *
 * RECOMMENDED for safe operation:
 *   - TALOS_BACKUP_RETENTION_DAYS  (default 14)
 *   - TALOS_BACKUP_MAX_BYTES       (default 5 MiB)
 *
 * The encrypted artifact includes the encryption label so an operator can
 * inspect backups years later without source code at hand.
 */

const ENC_LABEL_BASE = "AES-256-GCM#PBKDF2-SHA256";

export function isBackupDisabled(): boolean {
  return process.env.TALOS_BACKUP_DISABLED === "1";
}

export function opsAdminSecret(): string {
  const v = process.env.OPS_ADMIN_SECRET ?? "";
  return v;
}

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "";
}

export function backupRetentionDays(): number {
  const raw = process.env.TALOS_BACKUP_RETENTION_DAYS;
  const n = raw ? Number(raw) : 14;
  if (!Number.isFinite(n) || n < 1 || n > 365) return 14;
  return Math.floor(n);
}

export function backupMaxBytes(): number {
  const raw = process.env.TALOS_BACKUP_MAX_BYTES;
  const n = raw ? Number(raw) : 5 * 1024 * 1024;
  if (!Number.isFinite(n) || n < 1024) return 5 * 1024 * 1024;
  return Math.floor(n);
}

export function backupDefaultTimeoutMs(): number {
  const raw = process.env.TALOS_BACKUP_TIMEOUT_MS;
  const n = raw ? Number(raw) : 30_000;
  if (!Number.isFinite(n) || n < 1_000 || n > 5 * 60_000) return 30_000;
  return Math.floor(n);
}

export function artifactRootDir(): string {
  return process.env.TALOS_BACKUP_DIR ?? ".backups";
}

export function ENCRYPTION_LABEL_FOR_BACKUP(): string {
  return `${ENC_LABEL_BASE}#200000`;
}

// Re-exported for callers that don't want to import two modules.
export { databaseUrl as DATABASE_URL };
