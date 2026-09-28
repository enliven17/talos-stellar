/**
 * Privacy-safe commerce-job progress helpers for SSE streaming and POST updates.
 *
 * Never expose payment proofs, seeds, API keys, or raw payloads on the wire.
 */

const SENSITIVE_KEY_RE =
  /(secret|seed|private|password|token|authorization|apikey|payment|proof|signature|mnemonic)/i;

export type JobProgressReport = {
  percent: number | null;
  stage: string | null;
  message: string | null;
  updatedAt: string;
  reportedBy: string;
};

export type PublicJobProgressView = {
  id: string;
  status: string;
  talosId: string;
  requesterTalosId: string;
  serviceName: string;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  progress: JobProgressReport | null;
  /** Present only when status is terminal (`completed`). Values are redacted. */
  result: Record<string, unknown> | null;
  updatedAt: string;
  createdAt: string;
};

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

export function sanitizeProgressInput(input: {
  percent?: number;
  stage?: string;
  message?: string;
}): { percent: number | null; stage: string | null; message: string | null } {
  let percent: number | null =
    typeof input.percent === "number" && Number.isFinite(input.percent)
      ? Math.round(input.percent)
      : null;
  if (percent !== null) {
    percent = Math.max(0, Math.min(100, percent));
  }

  const stage =
    typeof input.stage === "string" && input.stage.trim()
      ? input.stage.trim().slice(0, 64)
      : null;

  let message: string | null =
    typeof input.message === "string" && input.message.trim()
      ? input.message.trim().slice(0, 280)
      : null;
  if (message && SENSITIVE_KEY_RE.test(message)) {
    message = "[redacted]";
  }

  return { percent, stage, message };
}

export function toPublicJobProgressView(job: {
  id: string;
  status: string;
  talosId: string;
  requesterTalosId: string;
  serviceName: string;
  leasedBy: string | null;
  leaseExpiresAt: Date | string | null;
  fencingToken: number;
  progress?: unknown;
  result?: unknown;
  updatedAt: Date | string;
  createdAt: Date | string;
}): PublicJobProgressView {
  const progressRaw =
    job.progress && typeof job.progress === "object"
      ? (job.progress as Record<string, unknown>)
      : null;

  const progress: JobProgressReport | null = progressRaw
    ? {
        percent:
          typeof progressRaw.percent === "number" ? progressRaw.percent : null,
        stage: typeof progressRaw.stage === "string" ? progressRaw.stage : null,
        message:
          typeof progressRaw.message === "string" ? progressRaw.message : null,
        updatedAt:
          typeof progressRaw.updatedAt === "string"
            ? progressRaw.updatedAt
            : new Date(
                job.updatedAt instanceof Date
                  ? job.updatedAt
                  : String(job.updatedAt),
              ).toISOString(),
        reportedBy:
          typeof progressRaw.reportedBy === "string"
            ? progressRaw.reportedBy
            : "",
      }
    : null;

  const isTerminal = job.status === "completed";
  const result =
    isTerminal && job.result && typeof job.result === "object"
      ? (redactValue(job.result) as Record<string, unknown>)
      : null;

  const leaseExpiresAt =
    job.leaseExpiresAt instanceof Date
      ? job.leaseExpiresAt.toISOString()
      : job.leaseExpiresAt
        ? String(job.leaseExpiresAt)
        : null;

  return {
    id: job.id,
    status: job.status,
    talosId: job.talosId,
    requesterTalosId: job.requesterTalosId,
    serviceName: job.serviceName,
    leasedBy: job.leasedBy ?? null,
    leaseExpiresAt,
    fencingToken: job.fencingToken ?? 0,
    progress,
    result,
    updatedAt:
      job.updatedAt instanceof Date
        ? job.updatedAt.toISOString()
        : String(job.updatedAt),
    createdAt:
      job.createdAt instanceof Date
        ? job.createdAt.toISOString()
        : String(job.createdAt),
  };
}

/** Stable fingerprint for change detection (status / lease / progress / result). */
export function jobProgressFingerprint(view: PublicJobProgressView): string {
  return [
    view.status,
    view.leasedBy ?? "",
    view.leaseExpiresAt ?? "",
    String(view.fencingToken),
    view.progress?.percent ?? "",
    view.progress?.stage ?? "",
    view.progress?.message ?? "",
    view.progress?.updatedAt ?? "",
    view.updatedAt,
    view.result ? "has-result" : "",
  ].join("|");
}

export const TERMINAL_JOB_STATUSES = new Set(["completed"]);
