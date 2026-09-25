/**
 * Typed seller quote construction.
 *
 * Builds a canonical {@link Quote} for sellers / providers so storefront and
 * A2A flows share one source of truth with {@link validateQuote} /
 * {@link verifyQuoteNotExpired}. Errors are explicit and privacy-safe — never
 * echo signatures, seeds, or payment proofs.
 */

import type { AssetCode, Network, Quote } from "./a2a-intent.js";
import {
  isValidCanonicalDecimal,
  validateQuote,
} from "./a2a-validation.js";
import type { ValidationError } from "./a2a-intent.js";

/** Default quote lifetime when neither `expiresAt` nor `ttlSeconds` is set. */
export const DEFAULT_SELLER_QUOTE_TTL_SECONDS = 900;

const ASSET_CODES: readonly AssetCode[] = [
  "USDC",
  "XLM",
  "USDT",
  "ETH",
  "BTC",
];

const NETWORKS: readonly Network[] = [
  "stellar",
  "ethereum",
  "bitcoin",
  "polygon",
];

export type SellerQuoteErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_ASSET_CODE"
  | "INVALID_NETWORK"
  | "INVALID_PROVIDER_ID"
  | "INVALID_EXPIRY"
  | "INVALID_TTL"
  | "EXPIRED_QUOTE"
  | "INVALID_QUOTE"
  | "INVALID_SIGNATURE"
  | "MISSING_PROVIDER_ID";

/**
 * Seller-facing inputs for constructing a typed {@link Quote}.
 *
 * Prefer `ttlSeconds` for relative expiry; use absolute `expiresAt` when the
 * seller already computed a deadline. When both are omitted, TTL defaults to
 * {@link DEFAULT_SELLER_QUOTE_TTL_SECONDS}.
 */
export interface ConstructSellerQuoteParams {
  /** Seller / provider address (Stellar `G…`, EVM `0x…`, or Bitcoin address). */
  providerId: string;
  /**
   * Price as a number or decimal string. Normalized to canonical six-fraction
   * digits (e.g. `"1.500000"`). Zero and negative amounts are rejected.
   */
  amount: string | number;
  /** Defaults to `"USDC"`. */
  assetCode?: AssetCode;
  /** Defaults to `"stellar"`. */
  network?: Network;
  /** Absolute ISO-8601 expiry. Mutually overrides `ttlSeconds` when both set. */
  expiresAt?: string;
  /** Relative lifetime in seconds from `now` (must be a positive finite number). */
  ttlSeconds?: number;
  /** Optional opaque quote id (never logged by this helper). */
  quoteId?: string;
  /** Optional provider signature (64-char lowercase hex). Never logged. */
  signature?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * 402 / storefront payment-details payload with a nested typed quote.
 * Compatible with Prime Agent commerce quote expiry enforcement.
 */
export interface SellerPaymentDetails {
  price: number;
  currency: string;
  payee: string;
  network: string;
  assetCode: AssetCode;
  expiresAt: string;
  quote: Quote;
  serviceName?: string;
  description?: string;
  talosId?: string;
  chains?: string[];
}

export interface ConstructSellerPaymentDetailsParams
  extends ConstructSellerQuoteParams {
  /** Payee wallet; defaults to `providerId`. */
  payee?: string;
  serviceName?: string;
  description?: string;
  talosId?: string;
  chains?: string[];
  /** Display currency label; defaults to `assetCode`. */
  currency?: string;
}

/**
 * Privacy-safe construction error. Message and `issues` never include
 * signatures, seeds, payment proofs, or raw secret material.
 */
export class SellerQuoteError extends Error {
  readonly code: SellerQuoteErrorCode;
  readonly field?: string;
  readonly issues: ValidationError[];

  constructor(
    code: SellerQuoteErrorCode,
    message: string,
    options?: { field?: string; issues?: ValidationError[]; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SellerQuoteError";
    this.code = code;
    this.field = options?.field;
    this.issues = options?.issues ?? [];
  }
}

/**
 * Normalize a numeric or string amount to canonical six-fraction decimal form.
 * Returns `null` for missing, non-finite, zero, negative, or unparseable values.
 */
export function toCanonicalDecimalAmount(amount: string | number): string | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    // Avoid scientific notation; fixed-6 then strip is still six digits.
    const fixed = amount.toFixed(6);
    return isValidCanonicalDecimal(fixed) ? fixed : null;
  }
  if (typeof amount !== "string") return null;
  const text = amount.trim();
  if (!text) return null;
  if (isValidCanonicalDecimal(text)) return text;
  // Accept shorter fractional forms / integers and pad to six digits.
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(text)) return null;
  const num = Number(text);
  if (!Number.isFinite(num) || num <= 0) return null;
  const fixed = num.toFixed(6);
  return isValidCanonicalDecimal(fixed) ? fixed : null;
}

function toUtcIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function resolveExpiresAt(
  params: ConstructSellerQuoteParams,
  now: Date,
): string {
  if (params.expiresAt !== undefined && params.expiresAt !== null) {
    if (typeof params.expiresAt !== "string" || !params.expiresAt.trim()) {
      throw new SellerQuoteError(
        "INVALID_EXPIRY",
        "expiresAt must be a non-empty ISO-8601 timestamp",
        { field: "expiresAt" },
      );
    }
    return params.expiresAt.trim();
  }

  let ttl = DEFAULT_SELLER_QUOTE_TTL_SECONDS;
  if (params.ttlSeconds !== undefined && params.ttlSeconds !== null) {
    if (
      typeof params.ttlSeconds !== "number" ||
      !Number.isFinite(params.ttlSeconds) ||
      params.ttlSeconds <= 0
    ) {
      throw new SellerQuoteError(
        "INVALID_TTL",
        "ttlSeconds must be a positive finite number",
        { field: "ttlSeconds" },
      );
    }
    ttl = params.ttlSeconds;
  }

  return toUtcIso(new Date(now.getTime() + ttl * 1000));
}

function mapValidationCode(code: string): SellerQuoteErrorCode {
  switch (code) {
    case "INVALID_PROVIDER_ID":
      return "INVALID_PROVIDER_ID";
    case "INVALID_ASSET_CODE":
      return "INVALID_ASSET_CODE";
    case "INVALID_NETWORK":
      return "INVALID_NETWORK";
    case "INVALID_AMOUNT":
      return "INVALID_AMOUNT";
    case "INVALID_TIMESTAMP":
      return "INVALID_EXPIRY";
    case "INVALID_SIGNATURE":
      return "INVALID_SIGNATURE";
    default:
      return "INVALID_QUOTE";
  }
}

/**
 * Construct a typed, validated seller {@link Quote}.
 *
 * @throws {SellerQuoteError} on missing / malformed / boundary / expired inputs.
 *   Messages are privacy-safe (no signatures or payment proofs).
 */
export function constructSellerQuote(
  params: ConstructSellerQuoteParams,
): Quote {
  if (params == null || typeof params !== "object") {
    throw new SellerQuoteError(
      "INVALID_QUOTE",
      "Seller quote params are required",
    );
  }

  const providerId =
    typeof params.providerId === "string" ? params.providerId.trim() : "";
  if (!providerId) {
    throw new SellerQuoteError(
      "MISSING_PROVIDER_ID",
      "providerId is required to construct a seller quote",
      { field: "providerId" },
    );
  }

  const amount = toCanonicalDecimalAmount(params.amount);
  if (amount === null) {
    throw new SellerQuoteError(
      "INVALID_AMOUNT",
      "amount must be a positive decimal normalizable to six fractional digits",
      { field: "amount" },
    );
  }

  const assetCode = (params.assetCode ?? "USDC") as AssetCode;
  if (!ASSET_CODES.includes(assetCode)) {
    throw new SellerQuoteError(
      "INVALID_ASSET_CODE",
      "assetCode must be one of: USDC, XLM, USDT, ETH, BTC",
      { field: "assetCode" },
    );
  }

  const network = (params.network ?? "stellar") as Network;
  if (!NETWORKS.includes(network)) {
    throw new SellerQuoteError(
      "INVALID_NETWORK",
      "network must be one of: stellar, ethereum, bitcoin, polygon",
      { field: "network" },
    );
  }

  const now = params.now instanceof Date ? params.now : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new SellerQuoteError("INVALID_EXPIRY", "now must be a valid Date", {
      field: "now",
    });
  }

  const expiresAt = resolveExpiresAt(params, now);

  const quote: Quote = {
    providerId,
    assetCode,
    network,
    amount,
    expiresAt,
  };

  if (params.quoteId !== undefined && params.quoteId !== null) {
    if (typeof params.quoteId !== "string" || !params.quoteId.trim()) {
      throw new SellerQuoteError(
        "INVALID_QUOTE",
        "quoteId must be a non-empty string when provided",
        { field: "quoteId" },
      );
    }
    quote.quoteId = params.quoteId.trim();
  }

  if (params.signature !== undefined && params.signature !== null) {
    if (typeof params.signature !== "string") {
      throw new SellerQuoteError(
        "INVALID_SIGNATURE",
        "signature must be a 64-character lowercase hex string when provided",
        { field: "signature" },
      );
    }
    // Assign for validateQuote; never include in thrown messages.
    quote.signature = params.signature;
  }

  const issues = validateQuote(quote);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new SellerQuoteError(
      mapValidationCode(first.code),
      first.message,
      { field: first.field, issues },
    );
  }

  // Boundary: expiresAt == now is expired (aligned with verifyQuoteNotExpired:
  // valid only while now < expiresAt). Use injectable `now` for determinism.
  const expiresMs = Date.parse(quote.expiresAt);
  if (Number.isNaN(expiresMs) || !(now.getTime() < expiresMs)) {
    throw new SellerQuoteError(
      "EXPIRED_QUOTE",
      "Seller quote expiresAt must be strictly in the future",
      { field: "expiresAt" },
    );
  }

  return quote;
}

/**
 * Construct a 402-style payment-details object with a nested typed quote.
 * Reuses {@link constructSellerQuote}; payee defaults to providerId.
 */
export function constructSellerPaymentDetails(
  params: ConstructSellerPaymentDetailsParams,
): SellerPaymentDetails {
  const quote = constructSellerQuote(params);
  const payee =
    typeof params.payee === "string" && params.payee.trim()
      ? params.payee.trim()
      : quote.providerId;

  const details: SellerPaymentDetails = {
    price: Number(quote.amount),
    currency: params.currency?.trim() || quote.assetCode,
    payee,
    network: quote.network === "stellar" ? "stellar:testnet" : quote.network,
    assetCode: quote.assetCode,
    expiresAt: quote.expiresAt,
    quote,
  };

  if (params.serviceName) details.serviceName = params.serviceName;
  if (params.description) details.description = params.description;
  if (params.talosId) details.talosId = params.talosId;
  if (params.chains) details.chains = params.chains;

  return details;
}
