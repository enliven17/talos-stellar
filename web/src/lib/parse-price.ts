/**
 * Shared price range parser for marketplace API endpoints.
 *
 * Rules:
 * - Absent or empty string → undefined (no constraint applied).
 * - Non-numeric, negative, or NaN → 400 with a clear message.
 * - minPrice > maxPrice → 400 explaining the reversed range.
 * - minPrice === maxPrice → valid (single-price filter).
 * - Zero is valid (free tier).
 * - Values are returned as numbers suitable for a numeric DB column comparison.
 *
 * Usage:
 *   const parsed = parsePriceRange(
 *     searchParams.get("minPrice"),
 *     searchParams.get("maxPrice"),
 *   );
 *   if (!parsed.ok) return parsed.response;
 *   const { minPrice, maxPrice } = parsed; // both may be undefined
 */

export type ParsePriceRangeResult =
  | { ok: true; minPrice: number | undefined; maxPrice: number | undefined }
  | { ok: false; response: Response };

/**
 * Parse and cross-validate `minPrice` and `maxPrice` query string values.
 *
 * Individual values are validated first (each must be a finite non-negative
 * number), then the pair is checked for a reversed range.  Both being absent
 * is the normal unfiltered case and is always valid.
 */
export function parsePriceRange(
  rawMin: string | null,
  rawMax: string | null,
): ParsePriceRangeResult {
  const minResult = parseSinglePrice(rawMin, "minPrice");
  if (!minResult.ok) return minResult;

  const maxResult = parseSinglePrice(rawMax, "maxPrice");
  if (!maxResult.ok) return maxResult;

  const minPrice = minResult.value;
  const maxPrice = maxResult.value;

  if (
    minPrice !== undefined &&
    maxPrice !== undefined &&
    minPrice > maxPrice
  ) {
    return {
      ok: false,
      response: Response.json(
        {
          error:
            `minPrice (${minPrice}) must be less than or equal to maxPrice (${maxPrice})`,
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, minPrice, maxPrice };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type SingleResult =
  | { ok: true; value: number | undefined }
  | { ok: false; response: Response };

function parseSinglePrice(raw: string | null, param: string): SingleResult {
  if (raw === null || raw === "") return { ok: true, value: undefined };

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return {
      ok: false,
      response: Response.json(
        { error: `${param} must be a non-negative number` },
        { status: 400 },
      ),
    };
  }

  return { ok: true, value: n };
}
