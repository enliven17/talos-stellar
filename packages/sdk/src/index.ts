// ── Client ────────────────────────────────────────────────────────

export {
  TalosClient,
  resolveRetryPolicy,
  resolveRetryOptions,
} from "./client.js";
export type {
  TalosClientOptions,
  RetryOptions,
  RetryPolicyOptions,
  ResolvedRetryPolicy,
  ResolvedRetryOptions,
  TalosErrorEvent,
  WriteOptions,
  ReadOptions,
} from "./client.js";

// ── Idempotency ───────────────────────────────────────────────────
export {
  generateIdempotencyKey,
  validateIdempotencyKey,
  IdempotencyConflictError,
  isUuidV4,
  IDEMPOTENCY_KEY_MAX_BYTES,
} from "./idempotency.js";

// ── Errors (typed hierarchy) ──────────────────────────────────────
//
// Re-export the existing `TalosAPIError` alias so legacy imports keep
// working, then publish the full hierarchy for callers that want to catch
// specific failure modes.
export { TalosAPIError } from "./errors.js";
export type { TalosAPIErrorOptions, TalosErrorCode } from "./errors.js";
export {
  TalosValidationError,
  TalosAuthenticationError,
  TalosForbiddenError,
  TalosNotFoundError,
  TalosConflictError,
  TalosPaymentError,
  TalosRateLimitError,
  TalosServerError,
  TalosServerRetryableError,
  TalosTransportError,
  TalosTimeoutError,
  errorFromResponse,
  classifyTransportError,
  sanitizeBody,
  redactSecrets,
  snapshotHeaders,
  parseRetryAfter,
  parseX402Challenge,
  redactEventPath,
  diagnoseBuyerProof,
  MAX_BODY_BYTES,
} from "./errors.js";

// ── Domain types ──────────────────────────────────────────────────

export * from "./types.js";

// ── Stellar helpers ───────────────────────────────────────────────

export * from "./stellar.js";
export * from "./webhooks.js";
export * from "./a2a-intent.js";
export * from "./a2a-validation.js";
export * from "./a2a-operations.js";
export {
  DEFAULT_SELLER_QUOTE_TTL_SECONDS,
  SellerQuoteError,
  constructSellerQuote,
  constructSellerPaymentDetails,
  toCanonicalDecimalAmount,
} from "./seller-quote.js";
export type {
  ConstructSellerQuoteParams,
  ConstructSellerPaymentDetailsParams,
  SellerPaymentDetails,
  SellerQuoteErrorCode,
} from "./seller-quote.js";
export {
  TalosEventStream,
  TalosStreamError,
  InMemorySeenStore,
} from "./events.js";
export type {
  TalosEventType,
  TalosStreamEvent,
  TalosEventHandler,
  TalosStreamErrorHandler,
  TalosStreamCloseHandler,
  TalosEventStreamOptions,
  SeenStore,
} from "./events.js";
export {
  FaultType,
  ChaosInjector,
  ChaosInjectedError,
  globalChaosInjector,
} from "./chaos.js";

// ── Runtime compatibility matrix ──────────────────────────────────────────────

export {
  getRuntimeMatrix,
  getRuntimeEntry,
  detectRuntime,
  probeGlobal,
  checkRuntimeCompatibility,
  assertRuntimeCompatibility,
} from "./compat.js";
export type {
  SupportedRuntime,
  RequiredCapability,
  RuntimeMatrixEntry,
  CompatibilityReport,
} from "./compat.js";

// Request signing
export {
  REQUEST_SIGNATURE_VERSION,
  SigningController,
  SigningError,
  StellarKeypairSigner,
  canonicalizeRequest,
  detectSignerCapability,
  encodeSignature,
} from "./signing.js";
export type {
  CanonicalRequest,
  RequestSigner,
  SignatureResult,
  SignOptions,
  SigningCapability,
  SigningControllerOptions,
  SigningErrorCode,
  SigningEvent,
  SigningPayload,
  SignerCapabilities,
  StellarKeypairSignerOptions,
} from "./signing.js";
