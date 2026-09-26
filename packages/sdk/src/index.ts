// ── Client ────────────────────────────────────────────────────────

export { TalosClient } from "./client.js";
export type {
  TalosClientOptions,
  RetryOptions,
  RetryPolicyOptions,
  TalosErrorEvent,
  WriteOptions,
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
  MAX_BODY_BYTES,
} from "./errors.js";

// ── Feature Detection ─────────────────────────────────────────────
//
// Provides backwards-compatible feature detection for SDK capabilities.
// This allows consumers to safely check for the presence of specific
// features without breaking on older versions or environments.
export {
  detectFeature,
  FeatureFlags,
  FeatureStatus,
} from "./features.js";

// ── Domain types ──────────────────────────────────────────────────

export * from "./types.js";

// ── Stellar helpers ───────────────────────────────────────────────

export * from "./stellar.js";
export * from "./webhooks.js";
export * from "./a2a-intent.js";
export * from "./a2a-validation.js";
export * from "./a2a-operations.js";
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