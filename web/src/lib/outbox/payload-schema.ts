import type { ZodType } from "zod";
import type { PayloadValidationIssue, PayloadValidationSummary } from "./types";

/**
 * Declared payload schemas, keyed by eventType. An event type with no
 * declared schema is dispatched exactly as before (backward compatible).
 */
export interface PayloadSchemaDeclaration {
  /** Positive integer, bumped whenever the payload contract changes. */
  version: number;
  schema: ZodType;
}

export const MAX_VALIDATION_ISSUES = 10;
const MAX_PATH_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 200;

const schemas = new Map<string, PayloadSchemaDeclaration>();

export function registerPayloadSchema(eventType: string, declaration: PayloadSchemaDeclaration): void {
  if (!Number.isInteger(declaration.version) || declaration.version < 1) {
    throw new Error(`Payload schema version for "${eventType}" must be a positive integer`);
  }
  schemas.set(eventType, declaration);
}

export function getPayloadSchema(eventType: string): PayloadSchemaDeclaration | undefined {
  return schemas.get(eventType);
}

/** Test-only: clears declared schemas. */
export function __resetPayloadSchemasForTests(): void {
  schemas.clear();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export type PayloadValidationResult =
  | { ok: true; schemaVersion: number | null }
  | { ok: false; summary: PayloadValidationSummary };

/**
 * Validates a payload against the declared schema for its event type.
 * The summary is bounded (≤ MAX_VALIDATION_ISSUES issues, clipped paths and
 * messages) and contains only paths/codes/messages — never payload values.
 */
export function validatePayload(eventType: string, payload: unknown): PayloadValidationResult {
  const declared = schemas.get(eventType);
  if (!declared) return { ok: true, schemaVersion: null };

  const result = declared.schema.safeParse(payload);
  if (result.success) return { ok: true, schemaVersion: declared.version };

  const all = result.error.issues;
  const issues: PayloadValidationIssue[] = all.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
    path: clip(issue.path.map(String).join("."), MAX_PATH_LENGTH),
    code: String(issue.code),
    message: clip(issue.message, MAX_MESSAGE_LENGTH),
  }));

  return {
    ok: false,
    summary: {
      schemaVersion: declared.version,
      issueCount: all.length,
      issues,
      truncated: all.length > issues.length,
    },
  };
}
