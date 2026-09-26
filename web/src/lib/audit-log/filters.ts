/**
 * Pure filter parsing / validation for the admin audit-log list API.
 * Kept free of DB / Next imports so Vitest can cover boundary cases
 * without spinning up a route fixture.
 */

export const VALID_HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof VALID_HTTP_METHODS)[number];

export const VALID_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof VALID_STATUS_CLASSES)[number];

export interface AuditLogFilters {
  talosId?: string;
  method?: HttpMethod;
  /** Case-insensitive substring match against `path` (and denialReason). */
  q?: string;
  statusCode?: number;
  statusClass?: StatusClass;
  denialReason?: string;
  /** Inclusive lower bound (ISO-8601). */
  from?: string;
  /** Inclusive upper bound (ISO-8601). */
  to?: string;
  /** Exclusive createdAt cursor (ISO-8601), paginating newest-first. */
  cursor?: string;
  limit: number;
}

export type FilterParseOk = { ok: true; filters: AuditLogFilters };
export type FilterParseErr = { ok: false; error: string };
export type FilterParseResult = FilterParseOk | FilterParseErr;

const MAX_Q_LEN = 200;
const MAX_ID_LEN = 128;

/** Escape `%` / `_` / `\` so user input is treated as a literal substring in ILIKE. */
export function escapeIlikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function parseIsoDate(raw: string, label: string): FilterParseErr | { ok: true; iso: string } {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: `${label} must be a valid ISO-8601 timestamp` };
  }
  return { ok: true, iso: d.toISOString() };
}

/**
 * Parse admin audit-log query params into a typed filter object.
 * Rejects malformed / out-of-range inputs with an explicit error string
 * (never echoes secrets or raw payloads).
 */
export function parseAuditLogFilters(
  params: URLSearchParams,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): FilterParseResult {
  const defaultLimit = opts.defaultLimit ?? 50;
  const maxLimit = opts.maxLimit ?? 200;

  const filters: AuditLogFilters = { limit: defaultLimit };

  const talosId = params.get("talosId");
  if (talosId !== null) {
    const trimmed = talosId.trim();
    if (!trimmed || trimmed.length > MAX_ID_LEN) {
      return { ok: false, error: `talosId must be 1–${MAX_ID_LEN} characters` };
    }
    filters.talosId = trimmed;
  }

  const method = params.get("method");
  if (method !== null) {
    const upper = method.trim().toUpperCase();
    if (!VALID_HTTP_METHODS.includes(upper as HttpMethod)) {
      return {
        ok: false,
        error: `Invalid method. Must be one of: ${VALID_HTTP_METHODS.join(", ")}`,
      };
    }
    filters.method = upper as HttpMethod;
  }

  const q = params.get("q");
  if (q !== null) {
    const trimmed = q.trim();
    if (!trimmed) {
      return { ok: false, error: "q must be a non-empty search string" };
    }
    if (trimmed.length > MAX_Q_LEN) {
      return { ok: false, error: `q must be at most ${MAX_Q_LEN} characters` };
    }
    filters.q = trimmed;
  }

  const statusCodeRaw = params.get("statusCode");
  if (statusCodeRaw !== null) {
    if (!/^\d{3}$/.test(statusCodeRaw)) {
      return { ok: false, error: "statusCode must be a 3-digit HTTP status" };
    }
    const code = parseInt(statusCodeRaw, 10);
    if (code < 100 || code > 599) {
      return { ok: false, error: "statusCode must be between 100 and 599" };
    }
    filters.statusCode = code;
  }

  const statusClass = params.get("statusClass");
  if (statusClass !== null) {
    if (!VALID_STATUS_CLASSES.includes(statusClass as StatusClass)) {
      return {
        ok: false,
        error: `Invalid statusClass. Must be one of: ${VALID_STATUS_CLASSES.join(", ")}`,
      };
    }
    if (filters.statusCode !== undefined) {
      return { ok: false, error: "statusCode and statusClass are mutually exclusive" };
    }
    filters.statusClass = statusClass as StatusClass;
  }

  const denialReason = params.get("denialReason");
  if (denialReason !== null) {
    const trimmed = denialReason.trim();
    if (!trimmed || trimmed.length > MAX_Q_LEN) {
      return { ok: false, error: `denialReason must be 1–${MAX_Q_LEN} characters` };
    }
    filters.denialReason = trimmed;
  }

  const from = params.get("from");
  if (from !== null) {
    const parsed = parseIsoDate(from, "from");
    if (!parsed.ok) return parsed;
    filters.from = parsed.iso;
  }

  const to = params.get("to");
  if (to !== null) {
    const parsed = parseIsoDate(to, "to");
    if (!parsed.ok) return parsed;
    filters.to = parsed.iso;
  }

  if (filters.from && filters.to && filters.from > filters.to) {
    return { ok: false, error: "from must be earlier than or equal to to" };
  }

  const cursor = params.get("cursor");
  if (cursor !== null) {
    const parsed = parseIsoDate(cursor, "cursor");
    if (!parsed.ok) return parsed;
    filters.cursor = parsed.iso;
  }

  const limitRaw = params.get("limit");
  if (limitRaw === null) {
    filters.limit = defaultLimit;
  } else if (!/^\d+$/.test(limitRaw)) {
    return { ok: false, error: "limit must be a positive integer" };
  } else {
    const n = parseInt(limitRaw, 10);
    if (n === 0) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    filters.limit = Math.min(n, maxLimit);
  }

  return { ok: true, filters };
}

/** Map a status class filter onto an inclusive [min, max] statusCode range. */
export function statusClassRange(statusClass: StatusClass): { min: number; max: number } {
  switch (statusClass) {
    case "2xx":
      return { min: 200, max: 299 };
    case "3xx":
      return { min: 300, max: 399 };
    case "4xx":
      return { min: 400, max: 499 };
    case "5xx":
      return { min: 500, max: 599 };
  }
}
