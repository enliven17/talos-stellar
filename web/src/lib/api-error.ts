import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "MALFORMED_JSON"
  | "VALIDATION_ERROR"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "PAYMENT_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "DEPENDENCY_FAILURE"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  MALFORMED_JSON: 400,
  VALIDATION_ERROR: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_FAILURE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  error: string; // human-readable; kept for backward compatibility
  code: ApiErrorCode; // stable machine-readable code
  requestId: string; // for operators to correlate logs
  details?: Record<string, string>; // field -> message only, never raw input
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, string>;
  readonly retryAfterSeconds?: number;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts?: { details?: Record<string, string>; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = opts?.details;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
  }
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  opts: { details?: Record<string, string>; retryAfterSeconds?: number; requestId?: string } = {},
) {
  const reqId = opts.requestId ?? randomUUID();
  const body: ApiErrorBody = {
    error: message,
    code,
    requestId: reqId,
    ...(opts.details ? { details: opts.details } : {}),
  };
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "x-request-id": reqId,
  };
  if (opts.retryAfterSeconds !== undefined) {
    const sec = Math.max(0, Math.ceil(opts.retryAfterSeconds));
    headers["Retry-After"] = String(sec);
  }
  return NextResponse.json(body, { status: STATUS[code], headers });
}

export function getRequestId(request?: Request | null): string {
  const incoming = request?.headers?.get?.("x-request-id") ?? null;
  if (!incoming || incoming.length > 64 || !/^[A-Za-z0-9._~:-]+$/.test(incoming)) {
    return randomUUID();
  }
  return incoming;
}

export function toErrorResponse(err: unknown, requestId?: string): NextResponse {
  const reqId = requestId || randomUUID();
  if (err instanceof ApiError) {
    return apiError(err.code, err.message, {
      details: err.details,
      retryAfterSeconds: err.retryAfterSeconds,
      requestId: reqId,
    });
  }
  if (err instanceof SyntaxError) {
    return apiError("MALFORMED_JSON", "Unexpected token", { requestId: reqId });
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") {
    const issues = (err as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues || [];
    const details: Record<string, string> = {};
    for (const issue of issues) {
      const key = issue.path.join(".");
      if (key) details[key] = issue.message;
    }
    return apiError("VALIDATION_ERROR", "Validation failed", { details, requestId: reqId });
  }
  const code = (err as { code?: string })?.code;
  if (code && ["ECONNREFUSED", "ETIMEDOUT", "08006", "57P01", "40001"].includes(code)) {
    return apiError("DEPENDENCY_UNAVAILABLE", "Upstream dependency unavailable", {
      retryAfterSeconds: 5,
      requestId: reqId,
    });
  }
  return apiError("INTERNAL_ERROR", "Internal server error", { requestId: reqId });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withApiErrors<T extends (...args: any[]) => any>(handler: T): (...args: any[]) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      const req = args[0] as Request | undefined;
      const reqId = getRequestId(req);
      return toErrorResponse(err, reqId);
    }
  };
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