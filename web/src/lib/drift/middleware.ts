/**
 * withDriftDetection — higher-order function that wraps a Next.js route handler
 * with SDK boundary drift validation.
 *
 * Usage:
 *
 *   export const POST = withDriftDetection(
 *     "POST /api/talos/:id/activity",
 *     async (req, ctx) => { ... },
 *   );
 *
 * Behaviour matrix:
 *
 *   mode=off    → handler called unchanged, zero validation cost
 *   mode=warn   → validate (maybe sampled), log violations, always call handler
 *   mode=strict → validate (maybe sampled), reject with 422 if violations found
 *
 * The body is read once, buffered, and re-injected so the real handler can
 * still call req.json() normally.
 *
 * Failure safety: any unexpected error in the validator is caught, logged, and
 * the request is allowed through — drift detection must never break real traffic.
 */

import { NextRequest } from "next/server";
import { shouldSample } from "./sampler.js";
import { validateAgainstSchema, stripUnknownFields, makeInvalidJsonViolation } from "./validator.js";
import {
  recordSkip,
  recordClean,
  recordWarn,
  recordReject,
  recordValidatorError,
  recordNoSchema,
} from "./metrics.js";
import type {
  ResolvedDriftConfig,
  SchemaRegistry,
  DriftViolation,
} from "./types.js";

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

// ── Global registry and config ────────────────────────────────────────────────

import type { JsonSchemaObject } from "./types.js";

/** Singleton schema registry populated at startup. */
const registry: SchemaRegistry = new Map();

/** Register a schema for a route key. Idempotent (last write wins). */
export function registerSchema(routeKey: string, schema: JsonSchemaObject): void {
  registry.set(routeKey, schema);
}

/** Remove a schema (for test teardown). */
export function deregisterSchema(routeKey: string): void {
  registry.delete(routeKey);
}

/** Read-only view of all registered route keys. */
export function registeredRoutes(): string[] {
  return Array.from(registry.keys());
}

// ── Config resolution ─────────────────────────────────────────────────────────

import type { DriftConfig, ResolvedDriftConfig as RDC } from "./types.js";

function resolveConfig(partial?: Partial<DriftConfig>): RDC {
  const mode = (partial?.mode ?? process.env.DRIFT_MODE ?? "off") as RDC["mode"];
  const sampleRate = partial?.sampleRate ?? parseFloat(process.env.DRIFT_SAMPLE_RATE ?? "1.0");
  const unknownFieldPolicy = (
    partial?.unknownFieldPolicy ??
    process.env.DRIFT_UNKNOWN_FIELDS ??
    "allow"
  ) as RDC["unknownFieldPolicy"];

  return {
    mode,
    sampleRate: Math.max(0, Math.min(1, sampleRate)),
    unknownFieldPolicy,
    random: partial?.random ?? Math.random,
  };
}

// Module-level resolved config — read once at import time.
// In tests, use withDriftDetectionConfig() override instead.
let _moduleConfig: RDC | null = null;

/** Override the module-level config (for tests / per-request overrides). */
export function setDriftConfig(config: Partial<DriftConfig>): void {
  _moduleConfig = resolveConfig(config);
}

/** Reset to env-based defaults (for test teardown). */
export function resetDriftConfig(): void {
  _moduleConfig = null;
}

function getConfig(): RDC {
  return _moduleConfig ?? resolveConfig();
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Wrap a route handler with drift detection.
 *
 * @param routeKey  Canonical key, e.g. "POST /api/talos/:id/activity"
 * @param handler   The original Next.js route handler
 * @param override  Per-route config override (optional)
 */
export function withDriftDetection(
  routeKey: string,
  handler: RouteHandler,
  override?: Partial<DriftConfig>,
): RouteHandler {
  return async (req, ctx) => {
    const config = override ? resolveConfig(override) : getConfig();
    const requestId = req.headers.get("x-request-id") ?? "unknown";

    // Fast exit: mode=off
    if (config.mode === "off") {
      recordSkip();
      return handler(req, ctx);
    }

    // Sampling: maybe skip validation even in warn/strict mode
    if (!shouldSample(config)) {
      recordSkip();
      return handler(req, ctx);
    }

    // Only validate request bodies for methods that carry a body
    const method = req.method?.toUpperCase();
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    if (!hasBody) {
      return handler(req, ctx);
    }

    // Look up schema
    const schema = registry.get(routeKey);
    if (!schema) {
      recordNoSchema(requestId, routeKey);
      return handler(req, ctx);
    }

    // Buffer the body so both validator and handler can read it
    let rawBody: string;
    let parsedBody: unknown;
    try {
      rawBody = await req.text();
      parsedBody = JSON.parse(rawBody);
    } catch {
      const violations: DriftViolation[] = [makeInvalidJsonViolation()];
      if (config.mode === "strict") {
        recordReject(requestId, routeKey, violations);
        return Response.json(
          {
            error: "Schema drift: invalid JSON body",
            violations: violations.map(({ path, kind, message }) => ({ path, kind, message })),
          },
          { status: 422 },
        );
      }
      recordWarn(requestId, routeKey, violations);
      // Re-build request with empty body so handler gets consistent behaviour
      return handler(rebuildRequest(req, rawBody ?? ""), ctx);
    }

    // Run validation inside a try/catch — validator must never break traffic
    let violations: DriftViolation[] = [];
    let strippedBody = parsedBody;

    try {
      const result = validateAgainstSchema(parsedBody, schema, config.unknownFieldPolicy);
      if (!result.ok) {
        violations = result.violations;
      }

      // Apply strip policy before forwarding to handler
      if (config.unknownFieldPolicy === "strip" && violations.length === 0) {
        strippedBody = stripUnknownFields(parsedBody, schema, schema);
      }
    } catch (err) {
      recordValidatorError(requestId, routeKey, config.mode, err);
      return handler(rebuildRequest(req, rawBody), ctx);
    }

    if (violations.length === 0) {
      recordClean(requestId, routeKey);
      const bodyToForward = config.unknownFieldPolicy === "strip"
        ? JSON.stringify(strippedBody)
        : rawBody;
      return handler(rebuildRequest(req, bodyToForward), ctx);
    }

    if (config.mode === "strict") {
      recordReject(requestId, routeKey, violations);
      return Response.json(
        {
          error: "Schema drift: request body violates expected contract",
          violations: violations.map(({ path, kind, message, expectedType, receivedType }) => ({
            path,
            kind,
            message,
            expectedType,
            receivedType,
          })),
        },
        { status: 422 },
      );
    }

    // mode === "warn"
    recordWarn(requestId, routeKey, violations);
    return handler(rebuildRequest(req, rawBody), ctx);
  };
}

// ── Body re-injection ─────────────────────────────────────────────────────────

/**
 * Reconstruct a NextRequest with a pre-read body string.
 * This is necessary because Request.body is a one-time-readable stream.
 */
function rebuildRequest(original: NextRequest, body: string): NextRequest {
  return new NextRequest(original.url, {
    method: original.method,
    headers: original.headers,
    body,
    // @ts-expect-error duplex is required for Node 18+ streaming but not in types
    duplex: "half",
  });
}
