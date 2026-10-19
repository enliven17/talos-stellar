import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "DEPENDENCY_FAILURE"
  | "INTERNAL_ERROR";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_FAILURE: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  error: string; // human-readable; kept for backward compatibility
  code: ApiErrorCode; // stable machine-readable code
  requestId: string; // for operators to correlate logs
  details?: Record<string, string>; // field -> message only, never raw input
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  opts: { details?: Record<string, string>; retryAfterSeconds?: number } = {},
) {
  const body: ApiErrorBody = {
    error: message,
    code,
    requestId: randomUUID(),
    ...(opts.details ? { details: opts.details } : {}),
  };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (opts.retryAfterSeconds) headers["Retry-After"] = String(opts.retryAfterSeconds);
  return NextResponse.json(body, { status: STATUS[code], headers });
}

// Unexpected failures: log only the error NAME + context (never message, stack,
// request body, keys or payment proofs); return a generic message.
export function internalError(err: unknown, context: string) {
  const res = apiError("INTERNAL_ERROR", "Internal server error");
  console.error(`[api] ${context}`, err instanceof Error ? err.name : "UnknownError");
  return res;
}

// Database / Horizon / facilitator failures: safe to retry, message is generic.
export function dependencyError(dependency: "db" | "stellar" | "facilitator", err: unknown) {
  console.error(`[api] dependency:${dependency}`, err instanceof Error ? err.name : "UnknownError");
  return apiError("DEPENDENCY_FAILURE", `Upstream dependency unavailable: ${dependency}`, {
    retryAfterSeconds: 5,
  });
}

// Malformed / missing JSON body.
export async function readJson(req: Request): Promise<
  { ok: true; data: unknown } | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, data: await req.json() };
  } catch {
    return { ok: false, response: apiError("BAD_REQUEST", "Request body must be valid JSON") };
  }
}