/**
 * Shared price range parser for marketplace API endpoints.
 *
 * Rules:
 * - Absent or empty string → undefined (no constraint applied).
 * - Non-numeric, negative, NaN, Infinity, or > 7 decimal places (exceeding
 *   exact Stellar USDC stroop precision) → 400 with a field-level error.
 * - minPrice > maxPrice (compared in exact USDC base units / stroops) → 400
 *   with a field-level error explaining the reversed range.
 * - minPrice === maxPrice → valid (single-price filter).
 * - Zero is valid (free tier).
 * - Values are returned as numbers suitable for a numeric DB column comparison.
 *
 * Error response shape (HTTP 400):
 *   {
 *     error: string,
 *     field: "minPrice" | "maxPrice",
 *     fieldErrors: Partial<Record<"minPrice" | "maxPrice", string>>
 *   }
 *
 * Usage:
 *   const parsed = parsePriceRange(
 *     searchParams.get("minPrice"),
 *     searchParams.get("maxPrice"),
 *   );
 *   if (!parsed.ok) return parsed.response;
 *   const { minPrice, maxPrice } = parsed; // both may be undefined
 */

/** Stellar USDC uses 7 decimal places (1 USDC = 10_000_000 stroops). */
export const USDC_DECIMALS = 7;

const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
const STRICT_NON_NEGATIVE_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

export type PriceRangeField = "minPrice" | "maxPrice";

export type ParsePriceRangeResult =
  | { ok: true; minPrice: number | undefined; maxPrice: number | undefined }
  | { ok: false; response: Response };

/**
 * Parse a non-negative decimal string into exact USDC base units (stroops).
 *
 * Returns `null` if the string is not a plain non-negative decimal or has
 * more than `USDC_DECIMALS` (7) fractional digits.
 */
export function parseUsdcUnits(raw: string): bigint | null {
  if (!STRICT_NON_NEGATIVE_DECIMAL_RE.test(raw)) return null;

  const [intPart, fracPart = ""] = raw.split(".");
  if (fracPart.length > USDC_DECIMALS) return null;

  const paddedFrac = fracPart.padEnd(USDC_DECIMALS, "0");
  return BigInt(intPart) * USDC_SCALE + BigInt(paddedFrac);
}

/**
 * Parse and cross-validate `minPrice` and `maxPrice` query string values
 * in exact USDC units (7 decimal places / stroops).
 *
 * Individual values are validated first (each must be a non-negative decimal
 * with at most 7 decimal places), then the pair is compared in exact `bigint`
 * USDC units to reject contradictory ranges without floating-point rounding.
 * Both being absent is the normal unfiltered case and is always valid.
 */
export function parsePriceRange(
  rawMin: string | null,
  rawMax: string | null,
): ParsePriceRangeResult {
  const minResult = parseSinglePrice(rawMin, "minPrice");
  if (!minResult.ok) return minResult;

  const maxResult = parseSinglePrice(rawMax, "maxPrice");
  if (!maxResult.ok) return maxResult;

  if (
    minResult.units !== undefined &&
    maxResult.units !== undefined &&
    minResult.units > maxResult.units
  ) {
    const minLabel = minResult.raw!;
    const maxLabel = maxResult.raw!;
    const minMessage = `minPrice (${minLabel}) must be less than or equal to maxPrice (${maxLabel})`;
    const maxMessage = `maxPrice (${maxLabel}) must be greater than or equal to minPrice (${minLabel})`;
    return {
      ok: false,
      response: Response.json(
        {
          error: minMessage,
          field: "minPrice",
          fieldErrors: {
            minPrice: minMessage,
            maxPrice: maxMessage,
          },
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, minPrice: minResult.value, maxPrice: maxResult.value };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type SingleResult =
  | { ok: true; value: number | undefined; units: bigint | undefined; raw: string | undefined }
  | { ok: false; response: Response };

function parseSinglePrice(raw: string | null, param: PriceRangeField): SingleResult {
  if (raw === null || raw === "") {
    return { ok: true, value: undefined, units: undefined, raw: undefined };
  }

  if (!STRICT_NON_NEGATIVE_DECIMAL_RE.test(raw)) {
    const message = `${param} must be a non-negative number`;
    return {
      ok: false,
      response: Response.json(
        {
          error: message,
          field: param,
          fieldErrors: { [param]: message },
        },
        { status: 400 },
      ),
    };
  }

  const units = parseUsdcUnits(raw);
  if (units === null) {
    const message = `${param} must have at most ${USDC_DECIMALS} decimal places (exact USDC units)`;
    return {
      ok: false,
      response: Response.json(
        {
          error: message,
          field: param,
          fieldErrors: { [param]: message },
        },
        { status: 400 },
      ),
    };
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    const message = `${param} must be a non-negative number`;
    return {
      ok: false,
      response: Response.json(
        {
          error: message,
          field: param,
          fieldErrors: { [param]: message },
        },
        { status: 400 },
      ),
    };
  }

  return { ok: true, value: n, units, raw };
}
