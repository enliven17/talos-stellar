/**
 * Shared validation and parsing helper for public analytics endpoint response limits.
 *
 * Rules:
 * - Absent param (null | undefined) → returns defaultLimit
 * - Non-empty string with non-digits (e.g. "abc", "1.5", "-1", "0", "") → 400 Bad Request
 * - Values exceeding maxLimit → 400 Bad Request (explicit error response)
 * - Valid positive integer within [1, maxLimit] → returns parsed limit
 */

export interface AnalyticsLimitResult {
  ok: true;
  limit: number;
}

export interface AnalyticsLimitError {
  ok: false;
  response: Response;
}

export function parseAnalyticsLimit(
  raw: string | null | undefined,
  defaultLimit: number,
  maxLimit: number,
  paramName = "limit",
): AnalyticsLimitResult | AnalyticsLimitError {
  // Absent param → use default
  if (raw === null || raw === undefined) {
    return { ok: true, limit: defaultLimit };
  }

  // Must be a non-empty string of digits only (no signs, decimal points, spaces)
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      response: Response.json(
        { error: `${paramName} must be a positive integer` },
        { status: 400 },
      ),
    };
  }

  const n = parseInt(raw, 10);

  // 0 is not a valid limit
  if (n === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: `${paramName} must be a positive integer` },
        { status: 400 },
      ),
    };
  }

  // Exceeds route-configured max limit → return 400
  if (n > maxLimit) {
    return {
      ok: false,
      response: Response.json(
        { error: `${paramName} exceeds maximum allowed limit of ${maxLimit}` },
        { status: 400 },
      ),
    };
  }

  return { ok: true, limit: n };
}
