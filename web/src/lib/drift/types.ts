/**
 * Core types for the SDK boundary drift detection system.
 *
 * Drift = divergence between what the SDK sends and what the web API schema
 * expects.  Detection runs at the API boundary on each incoming request.
 *
 * Privacy rule: DriftViolation must NEVER contain field values — only paths,
 * expected types, and received types.  Logging helpers enforce this contract.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Controls what happens when a drift violation is detected.
 *
 *   off    — validation is skipped entirely (zero cost)
 *   warn   — violation is logged and the request continues normally
 *   strict — violation causes a 422 response; request is rejected
 */
export type DriftMode = "off" | "warn" | "strict";

/**
 * Controls how extra fields (present in the request but absent from the schema)
 * are handled.
 *
 *   allow  — pass through as-is (default; maximises SDK forward-compat)
 *   strip  — silently drop unknown keys before the handler sees the body
 *   reject — treat unknown keys as a drift violation (strictest)
 */
export type UnknownFieldPolicy = "allow" | "strip" | "reject";

/** Global drift detection configuration.  All fields have safe defaults. */
export interface DriftConfig {
  /**
   * Validation mode.  Read from DRIFT_MODE env var at startup; defaults to
   * "off" so that unconfgured deployments are never impacted.
   */
  mode: DriftMode;

  /**
   * Fraction of requests that are validated (0.0 – 1.0).
   * 1.0 = every request; 0.0 = none; 0.1 = ~10%.
   * Ignored when mode is "off".
   */
  sampleRate: number;

  /** Policy for unknown fields in the request body. */
  unknownFieldPolicy: UnknownFieldPolicy;

  /**
   * Custom RNG for sampling.  Defaults to Math.random.
   * Injectable so tests can force or suppress sampling deterministically.
   */
  random?: () => number;
}

/** Resolved config with required fields filled in. */
export type ResolvedDriftConfig = Required<DriftConfig>;

// ── Violations ────────────────────────────────────────────────────────────────

/** Categories of drift that can be detected. */
export type DriftViolationKind =
  | "missing_required"   // a required field is absent
  | "type_mismatch"      // field is present but has the wrong type
  | "invalid_value"      // field value fails an enum / regex / range constraint
  | "unknown_field"      // field is not in the schema (only when policy != "allow")
  | "invalid_json"       // body could not be parsed as JSON
  | "schema_not_found";  // no schema registered for this route

/**
 * Describes a single constraint violation.
 *
 * PRIVACY: `path` and `expectedType`/`receivedType` are safe to log.
 * The `message` must never contain field values — only structural descriptions.
 */
export interface DriftViolation {
  /** JSON Pointer (RFC 6901) path to the offending field, e.g. "/amount" or "/address/city" */
  path: string;
  /** Short human-readable description of the problem (no values). */
  message: string;
  /** Classification of the drift event. */
  kind: DriftViolationKind;
  /** Expected JSON schema type or constraint label, if applicable. */
  expectedType?: string;
  /** Received JavaScript typeof, if applicable. */
  receivedType?: string;
}

// ── Validation results ────────────────────────────────────────────────────────

export type DriftValidationResult =
  | { ok: true; violations: [] }
  | { ok: false; violations: DriftViolation[] };

// ── Per-route schema registration ─────────────────────────────────────────────

/**
 * Minimal JSON Schema subset supported by the validator.
 * We only need Draft-07 features that zod-to-json-schema emits.
 */
export interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchemaObject;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  $ref?: string;
  $defs?: Record<string, JsonSchemaObject>;
  [key: string]: unknown;
}

/** Maps HTTP method + route pattern to a request-body JSON schema. */
export type SchemaRegistry = Map<string, JsonSchemaObject>;

// ── Route keys ────────────────────────────────────────────────────────────────

/**
 * Canonical key used to look up a schema in the registry.
 * Example: "POST /api/talos/:id/activity"
 */
export function routeKey(method: string, pattern: string): string {
  return `${method.toUpperCase()} ${pattern}`;
}
