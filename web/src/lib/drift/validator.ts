/**
 * Schema validator for the SDK boundary drift detection system.
 *
 * Validates a parsed request body against a registered JSON Schema and
 * returns a list of DriftViolation objects with JSON Pointer paths.
 *
 * Design constraints:
 *   - No external runtime dependencies beyond the JSON Schema object itself.
 *   - Never surfaces field values in violation messages (privacy).
 *   - Handles recursive $defs/$ref resolution within a single schema document.
 *   - Unknown-field policy is enforced by the caller after validation.
 */

import type {
  DriftViolation,
  DriftValidationResult,
  DriftViolationKind,
  JsonSchemaObject,
  UnknownFieldPolicy,
} from "./types.js";

// ── $ref resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a $ref like "#/$defs/Foo" against the root schema's $defs.
 * Only intra-document refs are supported (no external URIs).
 */
function resolveRef(ref: string, root: JsonSchemaObject): JsonSchemaObject | null {
  if (!ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let node: unknown = root;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "object" && node !== null ? (node as JsonSchemaObject) : null;
}

function deref(schema: JsonSchemaObject, root: JsonSchemaObject): JsonSchemaObject {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    return resolved ?? schema;
  }
  return schema;
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function schemaTypes(schema: JsonSchemaObject): string[] {
  if (!schema.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

// ── Core recursive walker ─────────────────────────────────────────────────────

function walkValue(
  value: unknown,
  schema: JsonSchemaObject,
  root: JsonSchemaObject,
  pointer: string,
  policy: UnknownFieldPolicy,
  violations: DriftViolation[],
): void {
  const resolved = deref(schema, root);

  // Handle combiners: anyOf / oneOf — try each branch; pass if any matches
  if (resolved.anyOf || resolved.oneOf) {
    const branches = resolved.anyOf ?? resolved.oneOf ?? [];
    const branchPassed = branches.some((branch) => {
      const tmp: DriftViolation[] = [];
      walkValue(value, branch, root, pointer, policy, tmp);
      return tmp.length === 0;
    });
    if (!branchPassed) {
      // Report at the pointer level; do not enumerate sub-branch failures
      violations.push({
        path: pointer || "/",
        message: "value does not match any permitted schema variant",
        kind: "type_mismatch",
        expectedType: "one of the declared variants",
        receivedType: jsType(value),
      });
    }
    return;
  }

  // allOf — every branch must pass
  if (resolved.allOf) {
    for (const branch of resolved.allOf) {
      walkValue(value, branch, root, pointer, policy, violations);
    }
    return;
  }

  // enum check
  if (resolved.enum !== undefined) {
    if (!resolved.enum.includes(value)) {
      violations.push({
        path: pointer || "/",
        message: `value is not one of the ${resolved.enum.length} permitted enum members`,
        kind: "invalid_value",
        expectedType: `enum(${resolved.enum.map(String).join("|")})`,
        receivedType: jsType(value),
      });
    }
    return;
  }

  const types = schemaTypes(resolved);
  const received = jsType(value);

  if (types.length > 0 && !types.includes(received) && !(types.includes("integer") && received === "number")) {
    // Allow "integer" to match JS "number" since JSON has no integer type
    if (!(types.includes("integer") && Number.isInteger(value))) {
      violations.push({
        path: pointer || "/",
        message: `expected ${types.join("|")} but received ${received}`,
        kind: "type_mismatch",
        expectedType: types.join("|"),
        receivedType: received,
      });
      return; // Cannot inspect children if type is wrong
    }
  }

  // String constraints
  if (received === "string" && typeof value === "string") {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      violations.push({
        path: pointer || "/",
        message: `string length ${value.length} is below minimum ${resolved.minLength}`,
        kind: "invalid_value",
        expectedType: `minLength:${resolved.minLength}`,
        receivedType: "string",
      });
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      violations.push({
        path: pointer || "/",
        message: `string length ${value.length} exceeds maximum ${resolved.maxLength}`,
        kind: "invalid_value",
        expectedType: `maxLength:${resolved.maxLength}`,
        receivedType: "string",
      });
    }
    if (resolved.pattern !== undefined) {
      try {
        if (!new RegExp(resolved.pattern).test(value)) {
          violations.push({
            path: pointer || "/",
            message: `string does not match required pattern`,
            kind: "invalid_value",
            expectedType: `pattern:${resolved.pattern}`,
            receivedType: "string",
          });
        }
      } catch {
        // Malformed pattern in schema — skip silently
      }
    }
  }

  // Number / integer constraints
  if ((received === "number") && typeof value === "number") {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      violations.push({
        path: pointer || "/",
        message: `value is below minimum ${resolved.minimum}`,
        kind: "invalid_value",
        expectedType: `minimum:${resolved.minimum}`,
        receivedType: "number",
      });
    }
    if (resolved.maximum !== undefined && value > resolved.maximum) {
      violations.push({
        path: pointer || "/",
        message: `value exceeds maximum ${resolved.maximum}`,
        kind: "invalid_value",
        expectedType: `maximum:${resolved.maximum}`,
        receivedType: "number",
      });
    }
  }

  // Object validation
  if (received === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = resolved.properties ?? {};

    // Required fields
    for (const key of resolved.required ?? []) {
      if (!(key in obj)) {
        violations.push({
          path: `${pointer}/${key}`,
          message: `required field is missing`,
          kind: "missing_required",
          expectedType: props[key] ? schemaTypes(deref(props[key], root)).join("|") || "any" : "any",
        });
      }
    }

    // Validate each present property
    for (const [key, childValue] of Object.entries(obj)) {
      const childPointer = `${pointer}/${key}`;
      if (key in props) {
        walkValue(childValue, props[key], root, childPointer, policy, violations);
      } else if (resolved.additionalProperties === false || policy === "reject") {
        violations.push({
          path: childPointer,
          message: `unknown field not permitted by schema`,
          kind: "unknown_field",
        });
      }
      // policy "allow" or "strip": unknown fields are handled outside validator
    }
  }

  // Array validation
  if (received === "array" && Array.isArray(value) && resolved.items) {
    for (let i = 0; i < value.length; i++) {
      walkValue(value[i], resolved.items, root, `${pointer}/${i}`, policy, violations);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate `body` against `schema` and return a result with path-aware violations.
 *
 * @param body           - Parsed JSON value (object, array, primitive, null)
 * @param schema         - Root JSON Schema object (may contain $defs)
 * @param unknownPolicy  - How to handle fields not in the schema
 */
export function validateAgainstSchema(
  body: unknown,
  schema: JsonSchemaObject,
  unknownPolicy: UnknownFieldPolicy,
): DriftValidationResult {
  const violations: DriftViolation[] = [];
  walkValue(body, schema, schema, "", unknownPolicy, violations);
  if (violations.length === 0) {
    return { ok: true, violations: [] };
  }
  return { ok: false, violations };
}

/**
 * Strip unknown keys from a plain object in-place, recursively.
 * Only objects whose schema has an explicit `properties` map are modified.
 * Arrays and primitive values are returned as-is.
 *
 * Returns a new value (does not mutate the input).
 */
export function stripUnknownFields(
  value: unknown,
  schema: JsonSchemaObject,
  root: JsonSchemaObject,
): unknown {
  const resolved = deref(schema, root);

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const props = resolved.properties ?? {};
  const result: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(obj)) {
    if (key in props) {
      result[key] = stripUnknownFields(childValue, props[key], root);
    }
    // Keys not in props are dropped when policy is "strip"
  }

  return result;
}

/**
 * Classify an unknown JSON-parsing error as a DriftViolation.
 */
export function makeInvalidJsonViolation(pointer = "/"): DriftViolation {
  return {
    path: pointer,
    message: "request body is not valid JSON",
    kind: "invalid_json" as DriftViolationKind,
  };
}
