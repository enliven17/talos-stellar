/**
 * Shared API response helpers.
 *
 * Every error returned by the bounded route set is shaped as:
 *
 *   { code: string; message: string; requestId: string; issues?: string[] }
 *
 * `code`      — machine-readable, stable identifier (e.g. "NOT_FOUND").
 * `message`   — safe, human-readable description. Internal error details are
 *               never forwarded to the client.
 * `requestId` — echoed from the `x-request-id` request header, or a newly
 *               generated UUID when the header is absent. Also set on the
 *               response `x-request-id` header for log correlation.
 * `issues`    — only present on validation errors (HTTP 400).
 *
 * Success responses are left unmodified (callers use `ok()` only for
 * consistency; there is no mandatory success envelope so existing consumers
 * are not broken).
 */

import { randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  issues?: string[];
}

// ─── Request ID extraction ─────────────────────────────────────────────────

/**
 * Read the request ID from the incoming request header, or generate a fresh
 * UUID if absent. Always returns a non-empty string.
 */
export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id") ?? randomUUID();
}

// ─── Error response factory ────────────────────────────────────────────────

/**
 * Build a standardised JSON error response.
 *
 * @param request  The incoming Request (used to echo the request ID).
 * @param status   HTTP status code (e.g. 400, 404, 500).
 * @param code     Stable machine-readable error code (SCREAMING_SNAKE_CASE).
 * @param message  Safe human-readable message. Do NOT pass raw `err.message`
 *                 here — use the pre-defined constants below instead.
 * @param issues   Optional array of validation issue strings (400 only).
 */
export function errorResponse(
  request: Request,
  status: number,
  code: string,
  message: string,
  issues?: string[],
): Response {
  const requestId = getRequestId(request);
  const body: ApiErrorBody = { code, message, requestId };
  if (issues && issues.length > 0) body.issues = issues;

  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId },
  });
}

// ─── Convenience shorthands ────────────────────────────────────────────────

/** 400 Bad Request — generic client error */
export const badRequest = (req: Request, message = "Bad request") =>
  errorResponse(req, 400, "BAD_REQUEST", message);

/** 400 Bad Request — body is not valid JSON */
export const invalidJson = (req: Request) =>
  errorResponse(req, 400, "INVALID_JSON", "Invalid JSON body");

/** 400 Bad Request — Zod schema validation failed */
export const validationError = (req: Request, issues: string[]) =>
  errorResponse(req, 400, "VALIDATION_ERROR", "Validation failed", issues);

/** 401 Unauthorized — missing or malformed auth header */
export const unauthorized = (req: Request, message = "Unauthorized") =>
  errorResponse(req, 401, "UNAUTHORIZED", message);

/** 403 Forbidden — authenticated but not allowed */
export const forbidden = (req: Request, message = "Forbidden") =>
  errorResponse(req, 403, "FORBIDDEN", message);

/** 404 Not Found */
export const notFound = (req: Request, message = "Not found") =>
  errorResponse(req, 404, "NOT_FOUND", message);

/** 500 Internal Server Error — never exposes internal detail */
export const internalError = (req: Request) =>
  errorResponse(req, 500, "INTERNAL_ERROR", "An unexpected error occurred");
