import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "MALFORMED_JSON"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYMENT_REQUIRED"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  MALFORMED_JSON: 400,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
};

export interface ApiErrorBody {
  /** Human-readable message. Kept as a string so existing callers reading `body.error` keep working. */
  error: string;
  code: ApiErrorCode;
  requestId: string;
  /** Safe, structured detail only (e.g. field paths). Never input values, secrets or payment proofs. */
  details?: unknown;
  retryAfterSeconds?: number;
}

export interface ApiErrorOptions {
  details?: unknown;
  retryAfterSeconds?: number;
  requestId?: string;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly options: ApiErrorOptions;

  constructor(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.options = options;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Reuse a well-formed inbound x-request-id, otherwise mint one. */
export function getRequestId(req?: Request): string {
  const inbound = req?.headers.get("x-request-id");
  return inbound && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  options: ApiErrorOptions = {},
): NextResponse<ApiErrorBody> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const body: ApiErrorBody = { error: message, code, requestId };
  if (options.details !== undefined) body.details = options.details;
  if (options.retryAfterSeconds !== undefined) body.retryAfterSeconds = options.retryAfterSeconds;

  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    ...options.headers,
  };
  if (options.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(Math.max(0, Math.ceil(options.retryAfterSeconds)));
  }
  return NextResponse.json(body, { status: STATUS_BY_CODE[code], headers });
}

const DEPENDENCY_NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

function isDependencyFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return false;
  // Postgres: class 08 (connection), 53 (resources), 57P (shutdown), 40001/40P01 (serialization/deadlock)
  return (
    DEPENDENCY_NET_CODES.has(code) ||
    /^(08|53|57P)/.test(code) ||
    code === "40001" ||
    code === "40P01" ||
    code === "55P03"
  );
}

function isZodLike(err: unknown): err is { issues: { path: (string | number)[]; message: string }[] } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Convert any thrown value into the standard envelope.
 * Privacy: never returns or logs err.message for unknown errors (it can carry
 * connection strings, payloads or keys). Only the error name/code is logged.
 */
export function toErrorResponse(err: unknown, req?: Request): NextResponse<ApiErrorBody> {
  const requestId = getRequestId(req);

  if (err instanceof ApiError) {
    return apiError(err.code, err.message, { ...err.options, requestId });
  }
  if (err instanceof SyntaxError) {
    return apiError("MALFORMED_JSON", "Request body is not valid JSON", { requestId });
  }
  if (isZodLike(err)) {
    // Field paths and messages only; never the submitted values.
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return apiError("VALIDATION_ERROR", "Request validation failed", { requestId, details });
  }

  const meta = {
    requestId,
    errorName: err instanceof Error ? err.name : typeof err,
    errorCode: (err as { code?: unknown } | null)?.code,
  };
  // If the repo has a shared pino logger (see db-retry.ts), swap console.error for it.
  console.error("api_error_unhandled", meta);

  if (isDependencyFailure(err)) {
    return apiError("DEPENDENCY_UNAVAILABLE", "A dependency is temporarily unavailable. Please retry.", {
      requestId,
      retryAfterSeconds: 5,
    });
  }
  return apiError("INTERNAL_ERROR", "Internal server error", { requestId });
}

/** Wrap a route handler so any thrown error becomes the standard envelope. */
export function withApiErrors<A extends [Request, ...unknown[]]>(
  handler: (...args: A) => Promise<Response> | Response,
) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return toErrorResponse(err, args[0]);
    }
  };
}

/** Parse a JSON body, throwing a MALFORMED_JSON ApiError on bad input. */
export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError("MALFORMED_JSON", "Request body is not valid JSON");
  }
}