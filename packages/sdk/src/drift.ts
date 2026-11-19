/**
 * SDK-side drift detector for @talos-protocol/sdk.
 *
 * Allows SDK consumers to validate their request payloads against the server's
 * published JSON schemas BEFORE the request is sent, giving early feedback
 * without a network round-trip.
 *
 * This module is opt-in and adds zero overhead when not configured.
 *
 * Usage:
 *
 *   import { DriftDetector } from "@talos-protocol/sdk";
 *
 *   const detector = new DriftDetector({ mode: "warn" });
 *   detector.registerSchema("POST /api/talos/:id/activity", activitySchema);
 *
 *   const client = new TalosClient({
 *     baseUrl: "https://talos-stellar.vercel.app",
 *     apiKey: "tak_...",
 *     driftDetector: detector,
 *   });
 */

// ── Types (duplicated here to avoid web-layer imports in SDK) ─────────────────

export type DriftMode = "off" | "warn" | "strict";
export type UnknownFieldPolicy = "allow" | "strip" | "reject";

export interface DriftViolation {
  path: string;
  message: string;
  kind: string;
  expectedType?: string;
  receivedType?: string;
}

export interface DriftDetectorOptions {
  mode?: DriftMode;
  sampleRate?: number;
  unknownFieldPolicy?: UnknownFieldPolicy;
  /** Custom RNG for sampling — defaults to Math.random */
  random?: () => number;
  /** Called when violations are detected (warn/strict). Default: console.warn */
  onViolation?: (routeKey: string, violations: DriftViolation[]) => void;
}

// ── Minimal JSON Schema types (subset used by the validator) ──────────────────

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

// ── Minimal validator (mirrored from web/src/lib/drift/validator.ts) ──────────

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref?.startsWith("#/")) return schema;
  const parts = schema.$ref.slice(2).split("/");
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return schema;
    node = (node as Record<string, unknown>)[part];
  }
  return (typeof node === "object" && node !== null) ? node as JsonSchema : schema;
}

function walk(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  pointer: string,
  violations: DriftViolation[],
): void {
  const s = deref(schema, root);

  if (s.anyOf || s.oneOf) {
    const branches = s.anyOf ?? s.oneOf ?? [];
    const passed = branches.some((b) => {
      const tmp: DriftViolation[] = [];
      walk(value, b, root, pointer, tmp);
      return tmp.length === 0;
    });
    if (!passed) {
      violations.push({ path: pointer || "/", message: "value does not match any permitted variant", kind: "type_mismatch", receivedType: jsType(value) });
    }
    return;
  }

  if (s.allOf) {
    for (const b of s.allOf) walk(value, b, root, pointer, violations);
    return;
  }

  if (s.enum !== undefined) {
    if (!s.enum.includes(value)) {
      violations.push({ path: pointer || "/", message: `not one of the ${s.enum.length} allowed values`, kind: "invalid_value", expectedType: `enum(${s.enum.map(String).join("|")})`, receivedType: jsType(value) });
    }
    return;
  }

  const types = Array.isArray(s.type) ? s.type : (s.type ? [s.type] : []);
  const received = jsType(value);

  if (types.length > 0) {
    const matches = types.includes(received) ||
      (types.includes("integer") && received === "number" && Number.isInteger(value));
    if (!matches) {
      violations.push({ path: pointer || "/", message: `expected ${types.join("|")} but received ${received}`, kind: "type_mismatch", expectedType: types.join("|"), receivedType: received });
      return;
    }
  }

  if (received === "string" && typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) {
      violations.push({ path: pointer || "/", message: `string too short (min ${s.minLength})`, kind: "invalid_value" });
    }
    if (s.maxLength !== undefined && value.length > s.maxLength) {
      violations.push({ path: pointer || "/", message: `string too long (max ${s.maxLength})`, kind: "invalid_value" });
    }
    if (s.pattern) {
      try { if (!new RegExp(s.pattern).test(value)) violations.push({ path: pointer || "/", message: "string does not match required pattern", kind: "invalid_value" }); } catch { /* ignore */ }
    }
  }

  if (received === "number" && typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) violations.push({ path: pointer || "/", message: `value below minimum ${s.minimum}`, kind: "invalid_value" });
    if (s.maximum !== undefined && value > s.maximum) violations.push({ path: pointer || "/", message: `value above maximum ${s.maximum}`, kind: "invalid_value" });
  }

  if (received === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = s.properties ?? {};
    for (const key of s.required ?? []) {
      if (!(key in obj)) {
        violations.push({ path: `${pointer}/${key}`, message: "required field is missing", kind: "missing_required" });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key in props) walk(child, props[key], root, `${pointer}/${key}`, violations);
    }
  }

  if (received === "array" && Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) walk(value[i], s.items, root, `${pointer}/${i}`, violations);
  }
}

// ── DriftDetector class ───────────────────────────────────────────────────────

export class DriftDetector {
  private readonly mode: DriftMode;
  private readonly sampleRate: number;
  private readonly unknownFieldPolicy: UnknownFieldPolicy;
  private readonly random: () => number;
  private readonly onViolation: (routeKey: string, violations: DriftViolation[]) => void;
  private readonly schemas = new Map<string, JsonSchema>();

  constructor(opts: DriftDetectorOptions = {}) {
    this.mode = opts.mode ?? "off";
    this.sampleRate = Math.max(0, Math.min(1, opts.sampleRate ?? 1.0));
    this.unknownFieldPolicy = opts.unknownFieldPolicy ?? "allow";
    this.random = opts.random ?? Math.random.bind(Math);
    this.onViolation = opts.onViolation ?? ((routeKey, violations) => {
      console.warn(
        `[talos-sdk drift] ${violations.length} violation(s) on ${routeKey}:`,
        violations.map((v) => `${v.path}: ${v.message}`).join("; "),
      );
    });
  }

  /** Register a JSON Schema for a route key, e.g. "POST /api/talos/:id/activity". */
  registerSchema(routeKey: string, schema: JsonSchema): void {
    this.schemas.set(routeKey, schema);
  }

  /**
   * Validate a request payload before sending.
   * Returns true if valid (or if validation is skipped).
   * In strict mode, throws a DriftError if violations are found.
   */
  validate(routeKey: string, body: unknown): boolean {
    if (this.mode === "off") return true;
    if (this.sampleRate < 1.0 && this.random() >= this.sampleRate) return true;

    const schema = this.schemas.get(routeKey);
    if (!schema) return true;

    const violations: DriftViolation[] = [];
    walk(body, schema, schema, "", violations);

    if (violations.length === 0) return true;

    this.onViolation(routeKey, violations);

    if (this.mode === "strict") {
      throw new DriftError(routeKey, violations);
    }

    return false; // warn mode: return false but do not throw
  }

  /** True if a schema is registered for the given route key. */
  hasSchema(routeKey: string): boolean {
    return this.schemas.has(routeKey);
  }

  /** List all registered route keys. */
  registeredRoutes(): string[] {
    return Array.from(this.schemas.keys());
  }
}

// ── DriftError ────────────────────────────────────────────────────────────────

export class DriftError extends Error {
  constructor(
    public readonly routeKey: string,
    public readonly violations: DriftViolation[],
  ) {
    const summary = violations
      .slice(0, 3)
      .map((v) => `${v.path}: ${v.message}`)
      .join("; ");
    super(`SDK drift on ${routeKey}: ${summary}${violations.length > 3 ? ` (and ${violations.length - 3} more)` : ""}`);
    this.name = "DriftError";
  }
}
