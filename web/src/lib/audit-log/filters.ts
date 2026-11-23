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
  limit?: number;
}

export type FilterParseOk = { ok: true; filters: AuditLogFilters };
export type FilterParseErr = { ok: false; error: string };
export type FilterParseResult = FilterParseOk | FilterParseErr;

export const MAX_Q_LEN = 200;
export const MAX_TALOS_ID_LEN = 128;
export const MAX_CURSOR_LEN = 64;
export const MAX_METHOD_LEN = 16;

const MAX_ID_LEN = MAX_TALOS_ID_LEN;

/** Stable error thrown when audit-log filter validation fails before query execution. */
export class AuditLogFilterError extends Error {
  readonly code = "INVALID_AUDIT_FILTER" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuditLogFilterError";
  }
}

/** Escape `%` / `_` / `\` so user input is treated as a literal substring in ILIKE. */
export function escapeIlikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function parseIsoDate(raw: string, label: string): FilterParseErr | { ok: true; iso: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: `${label} must be a valid ISO-8601 timestamp` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${label} must be a valid ISO-8601 timestamp` };
  }
  if (trimmed.length > MAX_CURSOR_LEN) {
    return { ok: false, error: `${label} must be at most ${MAX_CURSOR_LEN} characters` };
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: `${label} must be a valid ISO-8601 timestamp` };
  }
  return { ok: true, iso: d.toISOString() };
}

/**
 * Validate and normalize an `AuditLogFilters` object before constructing
 * database queries. Rejects oversized or malformed actor (`talosId`), action
 * (`method`, `q`, `denialReason`), and `cursor` / date bounds with stable
 * error messages so callers never execute partial queries.
 */
export function validateAuditLogFilters(filter: AuditLogFilters): FilterParseResult {
  const normalized: AuditLogFilters = {};

  if (filter.talosId !== undefined) {
    if (typeof filter.talosId !== "string") {
      return { ok: false, error: `talosId must be 1–${MAX_TALOS_ID_LEN} characters` };
    }
    const trimmed = filter.talosId.trim();
    if (!trimmed || trimmed.length > MAX_TALOS_ID_LEN) {
      return { ok: false, error: `talosId must be 1–${MAX_TALOS_ID_LEN} characters` };
    }
    normalized.talosId = trimmed;
  }

  if (filter.method !== undefined) {
    if (typeof filter.method !== "string" || filter.method.length > MAX_METHOD_LEN) {
      return {
        ok: false,
        error: `Invalid method. Must be one of: ${VALID_HTTP_METHODS.join(", ")}`,
      };
    }
    const upper = filter.method.trim().toUpperCase();
    if (!VALID_HTTP_METHODS.includes(upper as HttpMethod)) {
      return {
        ok: false,
        error: `Invalid method. Must be one of: ${VALID_HTTP_METHODS.join(", ")}`,
      };
    }
    normalized.method = upper as HttpMethod;
  }

  if (filter.q !== undefined) {
    if (typeof filter.q !== "string") {
      return { ok: false, error: "q must be a non-empty search string" };
    }
    const trimmed = filter.q.trim();
    if (!trimmed) {
      return { ok: false, error: "q must be a non-empty search string" };
    }
    if (trimmed.length > MAX_Q_LEN) {
      return { ok: false, error: `q must be at most ${MAX_Q_LEN} characters` };
    }
    normalized.q = trimmed;
  }

  if (filter.statusCode !== undefined) {
    if (
      typeof filter.statusCode !== "number" ||
      !Number.isInteger(filter.statusCode) ||
      filter.statusCode < 100 ||
      filter.statusCode > 599
    ) {
      return { ok: false, error: "statusCode must be between 100 and 599" };
    }
    normalized.statusCode = filter.statusCode;
  }

  if (filter.statusClass !== undefined) {
    if (!VALID_STATUS_CLASSES.includes(filter.statusClass)) {
      return {
        ok: false,
        error: `Invalid statusClass. Must be one of: ${VALID_STATUS_CLASSES.join(", ")}`,
      };
    }
    if (normalized.statusCode !== undefined) {
      return { ok: false, error: "statusCode and statusClass are mutually exclusive" };
    }
    normalized.statusClass = filter.statusClass;
  }

  if (filter.denialReason !== undefined) {
    if (typeof filter.denialReason !== "string") {
      return { ok: false, error: `denialReason must be 1–${MAX_Q_LEN} characters` };
    }
    const trimmed = filter.denialReason.trim();
    if (!trimmed || trimmed.length > MAX_Q_LEN) {
      return { ok: false, error: `denialReason must be 1–${MAX_Q_LEN} characters` };
    }
    normalized.denialReason = trimmed;
  }

  if (filter.from !== undefined) {
    const parsed = parseIsoDate(filter.from, "from");
    if (!parsed.ok) return parsed;
    normalized.from = parsed.iso;
  }

  if (filter.to !== undefined) {
    const parsed = parseIsoDate(filter.to, "to");
    if (!parsed.ok) return parsed;
    normalized.to = parsed.iso;
  }

  if (normalized.from && normalized.to && normalized.from > normalized.to) {
    return { ok: false, error: "from must be earlier than or equal to to" };
  }

  if (filter.cursor !== undefined) {
    const parsed = parseIsoDate(filter.cursor, "cursor");
    if (!parsed.ok) return parsed;
    normalized.cursor = parsed.iso;
  }

  if (filter.limit !== undefined) {
    if (typeof filter.limit !== "number" || !Number.isFinite(filter.limit)) {
      return { ok: false, error: "limit must be a positive integer" };
    }
    normalized.limit = filter.limit;
  }

  return { ok: true, filters: normalized };
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
