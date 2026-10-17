import type { OutboxEvent } from "./types";

/**
 * Dead-letter view of an outbox event: what an operator needs to triage a
 * failed delivery, and nothing else. Deliberately omits `payload` (domain
 * data, may carry payment proofs or user content), `dedupeKey` (often a tx
 * hash or idempotency key) and the lease fields. `GET /api/admin/outbox/:id`
 * remains the explicit, full-record escape hatch.
 */
export interface DeadLetterView {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  maxAttempts: number;
  /** Sanitized, truncated last consumer error; null if none was recorded. */
  lastError: string | null;
  createdAt: string;
  /** When the row last changed, i.e. when it was dead-lettered. */
  deadLetteredAt: string;
}

export interface DeadLetterSummary {
  total: number;
  byEventType: { eventType: string; count: number }[];
}

export interface DeadLetterQuery {
  eventType?: string;
  cursor?: string;
  limit: number;
}

export const DEAD_LETTER_DEFAULT_LIMIT = 25;
export const DEAD_LETTER_MAX_LIMIT = 100;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_VIEW_LENGTH = 300;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const REDACTED = "[redacted]";
const ERROR_REDACTIONS: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/g, // Stellar secret seeds
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWTs
  /\b(?:tak|tlk|talos_sk)_[A-Za-z0-9_]+/g, // TALOS API keys
  /\bBearer\s+[^\s,;]+/gi, // bearer credentials
  /\b[A-Za-z0-9+/]{80,}={0,2}/g, // long base64 blobs (signed XDR, payment proofs)
  /\b[0-9a-f]{32,}\b/gi, // long hex (hashes, signatures, raw keys)
];

/**
 * Make a stored `lastError` safe to show in an operator UI. Consumer errors
 * are free-form, so a handler could have thrown with a secret or a payment
 * proof in its message; redact the known shapes, keep the first line only,
 * and bound the length.
 */
export function sanitizeOutboxError(message: string | null | undefined): string | null {
  if (message == null) return null;
  let safe = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  for (const pattern of ERROR_REDACTIONS) safe = safe.replace(pattern, REDACTED);
  if (safe.length > MAX_ERROR_VIEW_LENGTH) safe = `${safe.slice(0, MAX_ERROR_VIEW_LENGTH)}…`;
  return safe || null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toDeadLetterView(event: OutboxEvent): DeadLetterView {
  return {
    id: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    attempts: event.attempts,
    maxAttempts: event.maxAttempts,
    lastError: sanitizeOutboxError(event.lastError),
    createdAt: iso(event.createdAt),
    deadLetteredAt: iso(event.updatedAt),
  };
}

export type ParseDeadLetterQueryResult =
  | { ok: true; query: DeadLetterQuery }
  | { ok: false; error: string };

/**
 * Validate `?eventType=&cursor=&limit=` for the dead-letter view. Rejects
 * (400) rather than silently coercing, so an operator never reads a page
 * that isn't what they asked for.
 */
export function parseDeadLetterQuery(params: URLSearchParams): ParseDeadLetterQueryResult {
  const query: DeadLetterQuery = { limit: DEAD_LETTER_DEFAULT_LIMIT };

  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) return { ok: false, error: "limit must be a positive integer" };
    const limit = Number(rawLimit);
    if (limit < 1 || limit > DEAD_LETTER_MAX_LIMIT) {
      return { ok: false, error: `limit must be between 1 and ${DEAD_LETTER_MAX_LIMIT}` };
    }
    query.limit = limit;
  }

  const rawCursor = params.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    const parsed = new Date(rawCursor);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== rawCursor) {
      return { ok: false, error: "cursor must be the nextCursor value from a previous page" };
    }
    query.cursor = rawCursor;
  }

  const rawEventType = params.get("eventType")?.trim();
  if (rawEventType) {
    if (rawEventType.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_PATTERN.test(rawEventType)) {
      return {
        ok: false,
        error: `eventType must be at most ${MAX_EVENT_TYPE_LENGTH} characters of letters, digits, '.', '_', ':' or '-'`,
      };
    }
    query.eventType = rawEventType;
  }

  return { ok: true, query };
}
