/**
 * Shared pagination limit parser for list API endpoints.
 *
 * Rules:
 * - If the query param is absent, return `defaultLimit`.
 * - Reject values that are not a string representation of a whole integer
 *   (e.g. "1.5", "abc", "" are all invalid → 400).
 * - Reject zero and negative values → 400.
 * - Clamp values above `maxLimit` down to `maxLimit` (rather than a 400,
 *   so callers asking for "a lot" still succeed with a safe cap).
 *
 * Returns either:
 *   { ok: true;  limit: number }
 *   { ok: false; response: Response }   — caller should return this Response immediately.
 */
export function parseLimit(
  raw: string | null,
  defaultLimit: number,
  maxLimit: number,
): { ok: true; limit: number } | { ok: false; response: Response } {
  // Absent → use default
  if (raw === null) {
    return { ok: true, limit: defaultLimit };
  }

  // Must be a non-empty string of only digits (no sign, no decimal point)
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      response: Response.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      ),
    };
  }

  const n = parseInt(raw, 10);

  // Zero is not a valid page size
  if (n === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      ),
    };
  }

  // Clamp to max (silent cap — still a valid request, just bounded)
  return { ok: true, limit: Math.min(n, maxLimit) };
}
