/**
 * Parsing and sanitisation for browser-delivered CSP violation reports.
 *
 * Two wire formats reach us (both are JSON):
 *  - `report-to` / `application/reports+json`: an array of
 *    `{ type, url, user_agent, body }` envelopes.
 *  - legacy `report-uri` / `application/csp-report`:
 *    `{ "csp-report": { "violated-directive", ... } }`.
 *
 * Reports are unauthenticated input, so everything extracted here is
 * type-checked, control-character stripped, query-stripped and truncated
 * before it can reach a log line.
 */

/** Reject oversized request bodies before parsing them. */
export const MAX_CSP_REPORT_BYTES = 16 * 1024;

/** Bound the number of log lines a single report batch can produce. */
export const MAX_REPORTS_PER_BATCH = 10;

/** Truncate every extracted field so one report cannot bloat the log. */
const MAX_FIELD_LENGTH = 300;

const RECOGNIZED_KEYS = [
  "violated-directive",
  "effective-directive",
  "document-uri",
  "blocked-uri",
  "source-file",
] as const;

export interface CspReportSummary {
  /** e.g. `script-src-elem` — the directive that blocked the resource. */
  directive: string | null;
  /** Document the violation happened on (origin + path, query stripped). */
  document: string | null;
  /** What was blocked (origin + path where applicable, truncated). */
  blocked: string | null;
  /** Source file of the violation when the browser reports one. */
  source: string | null;
  line: number | null;
  column: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Collapse control characters (log safety) and trim. */
function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function truncate(value: string): string {
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}...`
    : value;
}

/** Single-line, control-char stripped, truncated string — or null. */
function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const singleLine = stripControlChars(value);
  return singleLine ? truncate(singleLine) : null;
}

/**
 * URL-shaped fields lose their query string and hash (they may carry tokens)
 * and are truncated. Non-URL values (`inline`, `eval`, `data:...`) keep their
 * truncated literal form so the report stays diagnosable.
 */
function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = stripControlChars(value);
  if (!raw) return null;

  try {
    // blob: URLs wrap another URL — clean the inner one instead.
    const candidate = raw.startsWith("blob:") ? raw.slice(5) : raw;
    const url = new URL(candidate);
    // Opaque origins (data:, about:...) — keep the scheme only.
    const normalized =
      url.origin === "null" ? url.protocol : `${url.origin}${url.pathname}`;
    return truncate(normalized);
  } catch {
    // Not a URL ("inline", "eval", host-only fragments) — keep it literal.
    return truncate(raw);
  }
}

function cleanNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,10}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function isCspReportShape(record: Record<string, unknown>): boolean {
  return RECOGNIZED_KEYS.some((key) => key in record);
}

/** Unwrap one wire-format entry into a bare CSP report record. */
function unwrapReport(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;

  const legacy = asRecord(record["csp-report"]);
  if (legacy) return isCspReportShape(legacy) ? legacy : null;

  const body = asRecord(record.body);
  if (body) return isCspReportShape(body) ? body : null;

  return isCspReportShape(record) ? record : null;
}

function summarize(record: Record<string, unknown>): CspReportSummary {
  return {
    directive: cleanString(
      record["violated-directive"] ?? record["effective-directive"],
    ),
    document: cleanUrl(record["document-uri"]),
    blocked: cleanUrl(record["blocked-uri"]),
    source: cleanUrl(record["source-file"]),
    line: cleanNumber(record["line-number"]),
    column: cleanNumber(record["column-number"]),
  };
}

/**
 * Parse a raw CSP report body.
 *
 * @returns `null` when the body is not valid JSON (caller should reject it),
 *          otherwise the recognised reports (possibly empty) capped at
 *          {@link MAX_REPORTS_PER_BATCH}.
 */
export function parseCspReports(raw: string): CspReportSummary[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const summaries: CspReportSummary[] = [];

  for (const entry of entries) {
    if (summaries.length >= MAX_REPORTS_PER_BATCH) break;
    const record = unwrapReport(entry);
    if (record) summaries.push(summarize(record));
  }

  return summaries;
}
