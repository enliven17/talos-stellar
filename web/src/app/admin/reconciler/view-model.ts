export type ReconcilerStatus = "pending" | "confirmed" | "failed" | "unknown";

export interface RecordRowInput {
  id?: string | number;
  txHash?: string | null;
  sourceType?: string | null;
  sourceId?: string | number | null;
  finalityStatus?: string | null;
  pollCount?: number | null;
  lastError?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface RecordRow {
  id: string;
  txHashShort: string;
  sourceType: string;
  sourceId: string;
  status: ReconcilerStatus;
  pollCount: number;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReconcilerStatsInput {
  pending?: number | null;
  confirmed?: number | null;
  failed?: number | null;
  total?: number | null;
  lastTickAt?: string | Date | null;
  lastTickDurationMs?: number | null;
  lastError?: string | null;
  healthy?: boolean | null;
}

export interface StatsView {
  healthy: boolean;
  healthyLabel: string;
  pending: number;
  confirmed: number;
  failed: number;
  total: number;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
}

export interface TickSummaryInput {
  processed?: number | null;
  confirmed?: number | null;
  failed?: number | null;
  skipped?: number | null;
  durationMs?: number | null;
  error?: string | null;
  partial?: boolean | null;
  message?: string | null;
}

export interface TickSummaryView {
  partial: boolean;
  success: boolean;
  processed: number;
  confirmed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  error: string | null;
  message: string | null;
}

const STATUSES: ReadonlySet<ReconcilerStatus> = new Set(["pending", "confirmed", "failed", "unknown"]);

export const STATUS_FILTERS: ReadonlyArray<ReconcilerStatus> = [
  "pending",
  "confirmed",
  "failed",
];

export function normalizeStatus(value: unknown): ReconcilerStatus {
  if (typeof value !== "string") return "unknown";
  const lowered = value.trim().toLowerCase();
  if (STATUSES.has(lowered as ReconcilerStatus)) {
    return lowered as ReconcilerStatus;
  }
  return "unknown";
}

export function truncateTxHash(hash: unknown, visible: number = 8): string {
  if (typeof hash !== "string") return "";
  const trimmed = hash.trim();
  if (trimmed.length === 0) return "";
  const size = Math.max(1, Math.floor(visible));
  if (trimmed.length <= size * 2 + 1) return trimmed;
  return `${trimmed.slice(0, size)}...${trimmed.slice(-size)}`;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function toIdString(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

export function toRecordRow(input: RecordRowInput): RecordRow {
  return {
    id: toIdString(input.id),
    txHashShort: truncateTxHash(input.txHash),
    sourceType: typeof input.sourceType === "string" ? input.sourceType : "",
    sourceId: toIdString(input.sourceId),
    status: normalizeStatus(input.finalityStatus),
    pollCount: toCount(input.pollCount),
    lastError: typeof input.lastError === "string" && input.lastError.trim().length > 0 ? input.lastError : null,
    createdAt: toIsoString(input.createdAt),
    updatedAt: toIsoString(input.updatedAt),
  };
}

export function toRecordRows(inputs: ReadonlyArray<RecordRowInput> | null | undefined): RecordRow[] {
  if (!Array.isArray(inputs)) return [];
  return inputs.map(toRecordRow);
}

export function toStatsView(input: ReconcilerStatsInput | null | undefined): StatsView {
  const stats = input ?? {};
  const pending = toCount(stats.pending);
  const confirmed = toCount(stats.confirmed);
  const failed = toCount(stats.failed);
  const total = typeof stats.total === "number" ? toCount(stats.total) : pending + confirmed + failed;
  const healthy = typeof stats.healthy === "boolean" ? stats.healthy : failed === 0;
  return {
    healthy,
    healthyLabel: healthy ? "Healthy" : "Degraded",
    pending,
    confirmed,
    failed,
    total,
    lastTickAt: toIsoString(stats.lastTickAt),
    lastTickDurationMs: typeof stats.lastTickDurationMs === "number" && Number.isFinite(stats.lastTickDurationMs) ? stats.lastTickDurationMs : null,
    lastError: typeof stats.lastError === "string" && stats.lastError.trim().length > 0 ? stats.lastError : null,
  };
}

export function toTickSummaryView(input: TickSummaryInput | null | undefined): TickSummaryView {
  const summary = input ?? {};
  const error = typeof summary.error === "string" && summary.error.trim().length > 0 ? summary.error : null;
  const partial = summary.partial === true || error !== null;
  return {
    partial,
    success: !partial,
    processed: toCount(summary.processed),
    confirmed: toCount(summary.confirmed),
    failed: toCount(summary.failed),
    skipped: toCount(summary.skipped),
    durationMs: typeof summary.durationMs === "number" && Number.isFinite(summary.durationMs) ? summary.durationMs : null,
    error,
    message: typeof summary.message === "string" && summary.message.trim().length > 0 ? summary.message : null,
  };
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toISOString().replace("T", " ").replace(/(\.\d{3})?Z$/, " UTC");
}

export function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${value / 1000}.00s`;
}
