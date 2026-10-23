import { StrKey } from "@stellar/stellar-sdk";

export type ParseStellarPublicKeyParamResult =
  | { ok: true; publicKey: string }
  | { ok: false; response: Response };

/**
 * Validate a query parameter as a valid Stellar Ed25519 public key (G..., 56 chars).
 *
 * Rules:
 * - If absent, null, or empty string: 400 Bad Request
 * - If not a valid Ed25519 public key (lowercase, truncated, secret seed S..., etc.): 400 Bad Request
 * - Returns `{ ok: true, publicKey }` on success or `{ ok: false, response }` with the standard envelope on failure.
 */
export function parseStellarPublicKeyParam(
  paramValue: string | null | undefined,
  paramName = "wallet",
): ParseStellarPublicKeyParamResult {
  if (!paramValue || typeof paramValue !== "string" || paramValue.trim() === "") {
    return {
      ok: false,
      response: Response.json(
        { error: `${paramName} parameter required` },
        { status: 400 },
      ),
    };
  }

  const trimmed = paramValue.trim();

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    return {
      ok: false,
      response: Response.json(
        { error: `Invalid ${paramName} parameter` },
        { status: 400 },
      ),
    };
  }

  return { ok: true, publicKey: trimmed };
}
