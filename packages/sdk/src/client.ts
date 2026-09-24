import type {
  Talos,
  TalosCreated,
  TalosDetail,
  CreateTalosParams,
  ReportActivityParams,
  Activity,
  ReportRevenueParams,
  Revenue,
  CreateApprovalParams,
  Approval,
  RegisterServiceParams,
  CommerceService,
  SignPaymentParams,
  SignedPayment,
  DiscoverServicesParams,
  PurchaseServiceParams,
  CommerceJob,
  Wallet,
  LeaderboardEntry,
  Playbook,
  CreatePlaybookParams,
  TransferParams,
  TransferResponse,
  CursorPage,
  CursorRequestOptions,
  ActivityPage,
  ActivityPageOptions,
} from "./types.js";
import {
  TalosAPIError,
  TalosPaymentError,
  classifyTransportError,
  errorFromResponse,
  parseX402Challenge,
  parseRetryAfter as parseRetryAfterHeader,
} from "./errors.js";
import {
  generateIdempotencyKey,
  validateIdempotencyKey,
  isPayloadConflict,
  IdempotencyConflictError,
} from "./idempotency.js";
import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";
import {
  SigningController,
  canonicalizeRequest,
  encodeSignature,
  type RequestSigner,
  type SigningControllerOptions,
} from "./signing.js";

// Legacy import path: `import { TalosAPIError } from "./client.js"`.
export { TalosAPIError };
export { generateIdempotencyKey, validateIdempotencyKey, IdempotencyConflictError };

/**
 * Status-code driven retry policy (Retry-After aware). Enabled by default
 * with 3 attempts for safe methods (GET/HEAD/PUT/DELETE/OPTIONS) on
 * 429/500/502/503/504. Write methods become eligible for a single call when
 * that call supplies an `idempotencyKey`.
 *
 * Pass through {@link TalosClientOptions.retryPolicy}; values are normalized
 * by {@link resolveRetryPolicy}. Malformed numbers / methods / status codes
 * throw `TypeError` / `RangeError` at construction time (privacy-safe; no
 * request payloads are included in the message).
 */
export interface RetryPolicyOptions {
  /** Total attempts including the first try. Clamped to 1..8. Default 3. */
  maxAttempts?: number;
  /** Exponential backoff base delay in ms. Default 100. */
  baseDelayMs?: number;
  /** Upper bound on computed / Retry-After delay in ms. Default 1000. */
  maxDelayMs?: number;
  /** HTTP methods eligible for status-code retries (case-insensitive). */
  retryMethods?: string[];
  /** HTTP status codes that trigger a retry. */
  retryStatusCodes?: number[];
  /** When true, delay is randomized in `[0, delay]`. Default true. */
  jitter?: boolean;
  /** Injectable RNG for deterministic tests. Defaults to `Math.random`. */
  random?: () => number;
}

/** Bounded retry configuration based on typed error retryability. See {@link TalosClientOptions.retry}. */
export interface RetryOptions {
  /** Total attempts including the first try. `1` disables. Clamped to 1..8. */
  maxAttempts?: number;
  /** When true (default), only idempotent calls are auto-retried. */
  idempotentOnly?: boolean;
  /** Cap on server-supplied Retry-After hints in ms. Default 60_000. */
  maxRetryAfterMs?: number;
  /** Exponential backoff base delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Upper bound on computed delay in ms. Default 8_000. */
  maxDelayMs?: number;
  /** Jitter factor in `[0, 1]`. Default 0.25. */
  jitter?: number;
  /** Observer invoked before each delayed retry. Must not throw. */
  onRetry?: (event: { attempt: number; error: TalosAPIError; delayMs: number }) => void;
}

/** Frozen snapshot of the effective status-code retry policy. */
export type ResolvedRetryPolicy = Readonly<Required<RetryPolicyOptions>>;

/** Frozen snapshot of the effective typed retry policy. */
export type ResolvedRetryOptions = Readonly<Required<RetryOptions>>;

/**
 * Client configuration. All fields are optional; defaults match the prior
 * behavior for backward compatibility.
 */
export interface TalosClientOptions {
  /** Base URL of the Talos API. Defaults to `https://talos-stellar.vercel.app`. */
  baseUrl?: string;
  /** Bearer token (TALOS API key). Adds `Authorization: Bearer <key>` header. */
  apiKey?: string;
  /**
   * Status-code retry policy (Retry-After aware). Active by default. When only
   * {@link TalosClientOptions.retry} is supplied, this policy is disabled so
   * the typed `retry` bounds govern exclusively.
   */
  retryPolicy?: RetryPolicyOptions;
  /**
   * Bounded auto-retry policy driven by typed error retryability. When
   * `maxAttempts > 1`, transient failures (429, 502/503/504, transport,
   * timeout) on idempotent methods (GET/HEAD, or any call carrying an
   * idempotency key) are retried with exponential backoff, honoring
   * `Retry-After`. Hard-capped at 8 attempts.
   */
  retry?: RetryOptions;
  /**
   * Per-request timeout in milliseconds, enforced via `AbortController`.
   * Timeouts surface as `TalosTimeoutError`.
   */
  timeoutMs?: number;
  /**
   * Optional observer invoked once per failed SDK call (after retries are
   * exhausted). Must not throw; invoked fire-and-forget.
   */
  onError?: (event: TalosErrorEvent) => void;
  /** Optional fetch implementation. Defaults to the global `fetch` (resolved lazily). */
  fetch?: typeof fetch;
  /** Optional fault injector for chaos testing. Faults fire before each fetch. */
  chaosInjector?: ChaosInjector;
  /** Opt-in request signer. Omitting it preserves the legacy wire format. */
  signer?: RequestSigner;
  signing?: SigningControllerOptions;
}

/**
 * Per-call options for write methods (POST / PATCH).
 *
 * Supplying an `idempotencyKey` sends an `Idempotency-Key` header on every
 * attempt and makes the call retry-eligible, since the server de-duplicates
 * a request whose first attempt already committed.
 */
export interface WriteOptions {
  /** Optional idempotency key (UUID v4 recommended). Max 128 bytes. */
  idempotencyKey?: string;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/** Structured event emitted to {@link TalosClientOptions.onError}. */
export interface TalosErrorEvent {
  error: TalosAPIError;
  path: string;
  method: string;
  attempt: number;
  durationMs: number;
}

type RequestParams = Record<string, string | number | boolean>;

type RequestOptions = RequestInit & {
  params?: RequestParams;
  idempotencyKey?: string;
};

/** Default typed-retry bounds. `maxAttempts: 1` = off. */
const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 1,
  idempotentOnly: true,
  maxRetryAfterMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitter: 0.25,
  onRetry: () => {
    /* default: no-op observer */
  },
};

/** Default status-code retry policy (active unless exclusively `retry` is set). */
const DEFAULT_RETRY_POLICY: Required<RetryPolicyOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  retryMethods: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"],
  retryStatusCodes: [429, 500, 502, 503, 504],
  jitter: true,
  random: Math.random,
};

/** Hard upper bound on attempts for both retry policies. */
const MAX_TYPED_RETRY_ATTEMPTS = 8;

/** Methods considered safe to retry without further confirmation from the caller. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function clampAttempts(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  // Values below 1 mean "disabled" (single attempt). Oversized values are
  // hard-capped so operators cannot accidentally open an unbounded retry loop.
  if (value < 1) return 1;
  return Math.min(value, MAX_TYPED_RETRY_ATTEMPTS);
}

function normalizeDelayPair(
  baseDelayMs: number,
  maxDelayMs: number,
  prefix: string,
): { baseDelayMs: number; maxDelayMs: number } {
  if (baseDelayMs < 0 || maxDelayMs < 0) {
    throw new RangeError(`${prefix} delays must be >= 0`);
  }
  if (baseDelayMs > maxDelayMs) {
    throw new RangeError(`${prefix}.baseDelayMs must be <= ${prefix}.maxDelayMs`);
  }
  return { baseDelayMs, maxDelayMs };
}

/**
 * Normalize and validate a status-code {@link RetryPolicyOptions} object.
 * Missing fields fall back to defaults. Malformed input fails fast.
 */
export function resolveRetryPolicy(
  options: RetryPolicyOptions | undefined = undefined,
  enabled: boolean = true,
): ResolvedRetryPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new TypeError("retryPolicy must be an object when provided");
  }
  const src = options ?? {};
  const maxAttempts = enabled
    ? clampAttempts(
        src.maxAttempts === undefined
          ? DEFAULT_RETRY_POLICY.maxAttempts
          : assertFiniteNumber(src.maxAttempts, "retryPolicy.maxAttempts"),
        "retryPolicy.maxAttempts",
      )
    : 1;

  const baseDelayMs = assertFiniteNumber(
    src.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    "retryPolicy.baseDelayMs",
  );
  const maxDelayMs = assertFiniteNumber(
    src.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    "retryPolicy.maxDelayMs",
  );
  const delays = normalizeDelayPair(baseDelayMs, maxDelayMs, "retryPolicy");

  let retryMethods: string[];
  if (src.retryMethods === undefined) {
    retryMethods = [...DEFAULT_RETRY_POLICY.retryMethods];
  } else {
    if (!Array.isArray(src.retryMethods) || src.retryMethods.length === 0) {
      throw new TypeError("retryPolicy.retryMethods must be a non-empty string array");
    }
    retryMethods = src.retryMethods.map((method, index) => {
      if (typeof method !== "string" || method.trim() === "") {
        throw new TypeError(`retryPolicy.retryMethods[${index}] must be a non-empty string`);
      }
      return method.trim().toUpperCase();
    });
  }

  let retryStatusCodes: number[];
  if (src.retryStatusCodes === undefined) {
    retryStatusCodes = [...DEFAULT_RETRY_POLICY.retryStatusCodes];
  } else {
    if (!Array.isArray(src.retryStatusCodes) || src.retryStatusCodes.length === 0) {
      throw new TypeError("retryPolicy.retryStatusCodes must be a non-empty number array");
    }
    retryStatusCodes = src.retryStatusCodes.map((code, index) => {
      const n = assertFiniteNumber(code, `retryPolicy.retryStatusCodes[${index}]`);
      if (!Number.isInteger(n) || n < 100 || n > 599) {
        throw new RangeError(`retryPolicy.retryStatusCodes[${index}] must be an HTTP status 100-599`);
      }
      return n;
    });
  }

  const jitter =
    src.jitter === undefined
      ? DEFAULT_RETRY_POLICY.jitter
      : assertBoolean(src.jitter, "retryPolicy.jitter");
  const random = src.random ?? DEFAULT_RETRY_POLICY.random;
  if (typeof random !== "function") {
    throw new TypeError("retryPolicy.random must be a function");
  }

  return Object.freeze({
    maxAttempts,
    baseDelayMs: delays.baseDelayMs,
    maxDelayMs: delays.maxDelayMs,
    retryMethods: Object.freeze([...retryMethods]) as string[],
    retryStatusCodes: Object.freeze([...retryStatusCodes]) as number[],
    jitter,
    random,
  });
}

/**
 * Normalize and validate a typed {@link RetryOptions} object.
 * Missing fields fall back to defaults. Malformed input fails fast.
 */
export function resolveRetryOptions(
  options: RetryOptions | undefined = undefined,
): ResolvedRetryOptions {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
    throw new TypeError("retry must be an object when provided");
  }
  const src = options ?? {};
  const maxAttempts = clampAttempts(
    src.maxAttempts === undefined
      ? DEFAULT_RETRY.maxAttempts
      : assertFiniteNumber(src.maxAttempts, "retry.maxAttempts"),
    "retry.maxAttempts",
  );
  const baseDelayMs = assertFiniteNumber(
    src.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    "retry.baseDelayMs",
  );
  const maxDelayMs = assertFiniteNumber(
    src.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    "retry.maxDelayMs",
  );
  const delays = normalizeDelayPair(baseDelayMs, maxDelayMs, "retry");
  const maxRetryAfterMs = assertFiniteNumber(
    src.maxRetryAfterMs ?? DEFAULT_RETRY.maxRetryAfterMs,
    "retry.maxRetryAfterMs",
  );
  if (maxRetryAfterMs < 0) {
    throw new RangeError("retry.maxRetryAfterMs must be >= 0");
  }
  const jitter = assertFiniteNumber(src.jitter ?? DEFAULT_RETRY.jitter, "retry.jitter");
  if (jitter < 0 || jitter > 1) {
    throw new RangeError("retry.jitter must be between 0 and 1");
  }
  const idempotentOnly =
    src.idempotentOnly === undefined
      ? DEFAULT_RETRY.idempotentOnly
      : assertBoolean(src.idempotentOnly, "retry.idempotentOnly");
  const onRetry = src.onRetry ?? DEFAULT_RETRY.onRetry;
  if (typeof onRetry !== "function") {
    throw new TypeError("retry.onRetry must be a function");
  }

  return Object.freeze({
    maxAttempts,
    idempotentOnly,
    maxRetryAfterMs,
    baseDelayMs: delays.baseDelayMs,
    maxDelayMs: delays.maxDelayMs,
    jitter,
    onRetry,
  });
}

/**
 * Apply jitter to a delay: `delay * (1 - jitter + jitter*random)`.
 */
function applyJitter(delay: number, jitter: number): number {
  const factor = 1 - jitter + jitter * Math.random();
  return Math.max(0, Math.round(delay * factor));
}

/**
 * Talos Protocol API client. Wraps `fetch` with typed errors, optional
 * timeout, idempotency keys, request signing, chaos injection and bounded
 * auto-retry.
 */
export class TalosClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private readonly retryPolicy: Required<RetryPolicyOptions>;
  private readonly retry: Required<RetryOptions>;
  private readonly timeoutMs?: number;
  private readonly onError?: (event: TalosErrorEvent) => void;
  /**
   * Optional fetch override. `undefined` means `globalThis.fetch` is read
   * lazily on every call so `vi.stubGlobal("fetch", …)` keeps working.
   */
  private readonly fetchOverride?: typeof fetch;
  private readonly chaosInjector?: ChaosInjector;
  private signer?: SigningController;

  constructor(options: TalosClientOptions = {}) {
    // An explicit `retry` config without `retryPolicy` opts out of the
    // default status-code policy so the two never compound.
    const policyEnabled = options.retryPolicy !== undefined || options.retry === undefined;
    this.retryPolicy = resolveRetryPolicy(options.retryPolicy, policyEnabled);
    this.retry = resolveRetryOptions(options.retry);
    this.timeoutMs = options.timeoutMs;
    this.onError = options.onError;
    this.fetchOverride = options.fetch;
    this.chaosInjector = options.chaosInjector;
    this.baseUrl = (
      options.baseUrl ?? "https://talos-stellar.vercel.app"
    ).replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
    if (options.signer) this.signer = new SigningController(options.signer, options.signing);
  }

  /**
   * Effective status-code retry policy after validation/normalization.
   * Returned object is frozen; `random` is the live RNG reference.
   */
  getRetryPolicy(): ResolvedRetryPolicy {
    return this.retryPolicy;
  }

  /**
   * Effective typed retry policy after validation/normalization.
   * Returned object is frozen; `onRetry` is the live observer reference.
   */
  getRetryOptions(): ResolvedRetryOptions {
    return this.retry;
  }

  /** Resolve the fetch implementation per request. Prefer override; fall back to global. */
  private resolveFetch(): typeof fetch {
    return this.fetchOverride ?? globalThis.fetch;
  }

  // ── Internal helpers ───────────────────────────────────────

  /** Build the full URL for a path + params. Pure. */
  private buildUrl(path: string, params?: RequestParams): string {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const filteredParams = Object.entries(params)
        .filter(([_, value]) => value !== undefined)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: String(value) }), {} as Record<string, string>);
      const qs = new URLSearchParams(filteredParams).toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  /**
   * Merge default headers with per-call overrides into a plain `Record`
   * (not a `Headers` instance) so mocked fetch calls expose them as
   * enumerable own properties.
   */
  private mergeHeaders(init?: HeadersInit, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers };
    if (init) {
      const provided = init instanceof Headers
        ? Object.fromEntries(init.entries())
        : Array.isArray(init)
          ? Object.fromEntries(init)
          : init;
      Object.assign(headers, provided as Record<string, string>);
    }
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  /** Fire configured chaos faults. Callers must guard with `if (this.chaosInjector)`. */
  private async injectChaos(): Promise<void> {
    if (!this.chaosInjector) return;
    await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
    await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
    await this.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
  }

  /** Add the talos-request-v1 signature headers. Requires a configured signer. */
  private async applySignature(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: BodyInit | null | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (!this.signer) return headers;
    const timestamp = new Date().toISOString();
    const nonce = globalThis.crypto.randomUUID();
    const bytes = await canonicalizeRequest({
      method,
      url,
      headers,
      body,
      timestamp,
      nonce,
    });
    const signed = await this.signer.sign(
      { kind: "http-request-v1", bytes },
      { signal, requestId: nonce },
    );
    return {
      ...headers,
      "X-Talos-Signature-Version": "talos-request-v1",
      "X-Talos-Key-Id": signed.keyId,
      "X-Talos-Algorithm": signed.algorithm,
      "X-Talos-Timestamp": timestamp,
      "X-Talos-Nonce": nonce,
      "X-Talos-Signature": encodeSignature(signed.signature),
    };
  }

  /**
   * Build a `{ signal, dispose }` pair for the per-request timeout, linked to
   * the caller's signal when present. Returns `null` when no timeout is set.
   * `dispose()` MUST be called once the attempt settles.
   */
  private acquireTimeoutController(
    callerSignal?: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } | null {
    if (!this.timeoutMs) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      },
    };
  }

  // ── Status-code retry policy (retryPolicy) ─────────────────

  private shouldRetry(method: string, status: number, retryMethodsOverride?: string[]): boolean {
    const methods = retryMethodsOverride ?? this.retryPolicy.retryMethods;
    return (
      this.retryPolicy.retryStatusCodes.includes(status) &&
      methods.includes(method)
    );
  }

  private getRetryDelay(
    attempt: number,
    retryAfterHeader: string | null,
  ): number {
    if (retryAfterHeader) {
      const headerDelay = this.parseRetryAfter(retryAfterHeader);
      if (headerDelay !== null) {
        return Math.min(headerDelay, this.retryPolicy.maxDelayMs);
      }
    }

    const exponent = Math.pow(2, attempt - 1);
    const delay = Math.min(
      this.retryPolicy.baseDelayMs * exponent,
      this.retryPolicy.maxDelayMs,
    );
    if (!this.retryPolicy.jitter) {
      return delay;
    }

    return Math.floor(this.retryPolicy.random() * delay);
  }

  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    const seconds = Number(trimmed);
    if (!Number.isNaN(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const parsedDate = Date.parse(trimmed);
    if (!Number.isNaN(parsedDate)) {
      const delta = parsedDate - Date.now();
      return delta > 0 ? delta : 0;
    }

    return null;
  }

  private wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Request aborted"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Request aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── Typed retry policy (retry) ─────────────────────────────

  /** Effective max-attempt count for the typed retry policy. */
  private computeMaxAttempts(idempotent: boolean): number {
    const configured = this.retry.maxAttempts;
    if (!configured || configured <= 1) return 1;
    if (this.retry.idempotentOnly && !idempotent) return 1;
    return Math.max(1, Math.min(configured, MAX_TYPED_RETRY_ATTEMPTS));
  }

  /**
   * Delay before the next typed-policy attempt: honor `Retry-After` (capped
   * at `maxRetryAfterMs`), otherwise exponential backoff capped at
   * `maxDelayMs`, with jitter.
   */
  private computeBackoffDelay(err: TalosAPIError, attempt: number): number {
    const retryAfterMs = err.retryAfterMs ?? parseRetryAfterHeader(err.headers["retry-after"]);
    if (retryAfterMs != null) {
      const capped = Math.min(retryAfterMs, this.retry.maxRetryAfterMs);
      const jittered = applyJitter(capped, this.retry.jitter);
      return Math.min(jittered, this.retry.maxDelayMs);
    }
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * Math.pow(2, attempt - 1));
    return applyJitter(exp, this.retry.jitter);
  }

  /**
   * Decide whether to retry after a typed failure. Returns the delay in ms,
   * or `null` to stop. The status-code policy is consulted first so its
   * Retry-After semantics are preserved; the typed policy covers transport
   * and timeout failures as well.
   */
  private nextRetryDelay(
    err: TalosAPIError,
    ctx: {
      method: string;
      attempt: number;
      idempotent: boolean;
      retryMethodsForCall?: string[];
      typedMaxAttempts: number;
    },
  ): number | null {
    if (
      ctx.attempt < this.retryPolicy.maxAttempts &&
      err.status > 0 &&
      this.shouldRetry(ctx.method, err.status, ctx.retryMethodsForCall)
    ) {
      return this.getRetryDelay(ctx.attempt, err.headers["retry-after"] ?? null);
    }
    if (
      ctx.attempt < ctx.typedMaxAttempts &&
      err.isRetryable &&
      (ctx.idempotent || !this.retry.idempotentOnly)
    ) {
      return this.computeBackoffDelay(err, ctx.attempt);
    }
    return null;
  }

  private notifyError(event: TalosErrorEvent): void {
    if (!this.onError) return;
    try {
      this.onError(event);
    } catch {
      // Fire-and-forget.
    }
  }

  // ── Core request ───────────────────────────────────────────

  /**
   * Retry-wrapped request. Returns the parsed JSON body or throws a typed
   * {@link TalosAPIError} subclass (or {@link IdempotencyConflictError} for
   * a payload conflict on a keyed write).
   *
   * NOTE: nothing may be awaited before the first `fetch` unless a signer or
   * chaos injector is configured — callers rely on fetch being invoked
   * synchronously so abort listeners attach before `abort()`.
   */
  private async request<T>(path: string, init?: RequestOptions): Promise<T> {
    const { params, signal, idempotencyKey, ...requestInit } = init ?? {};
    const callerSignal = signal ?? undefined;
    const method = (requestInit.method ?? "GET").toUpperCase();
    const url = this.buildUrl(path, params);

    const extraHeaders: Record<string, string> = {};
    if (idempotencyKey !== undefined) {
      extraHeaders["Idempotency-Key"] = validateIdempotencyKey(idempotencyKey);
    }

    // A keyed write is de-duplicated server-side, so it becomes retry-eligible.
    const idempotent = IDEMPOTENT_METHODS.has(method) || idempotencyKey !== undefined;
    const retryMethodsForCall =
      idempotencyKey !== undefined && !this.retryPolicy.retryMethods.includes(method)
        ? [...this.retryPolicy.retryMethods, method]
        : undefined;
    const typedMaxAttempts = this.computeMaxAttempts(idempotent);
    const maxAttempts = Math.max(this.retryPolicy.maxAttempts, typedMaxAttempts);
    const startedAt = Date.now();

    let lastError: TalosAPIError | undefined;
    let attempt = 1;
    for (; attempt <= maxAttempts; attempt += 1) {
      if (this.chaosInjector) await this.injectChaos();

      const baseHeaders = this.mergeHeaders(requestInit.headers, extraHeaders);
      const headers = this.signer
        ? await this.applySignature(url, method, baseHeaders, requestInit.body, callerSignal)
        : baseHeaders;

      const timeout = this.acquireTimeoutController(callerSignal);
      const effectiveSignal = timeout?.signal ?? callerSignal;
      let delayMs: number | null = null;
      try {
        let res: Response;
        try {
          res = await this.resolveFetch()(url, {
            ...requestInit,
            method,
            headers,
            ...(effectiveSignal ? { signal: effectiveSignal } : {}),
          });
        } catch (cause) {
          throw classifyTransportError(cause, path);
        }

        if (res.ok) {
          // Malformed JSON on a 2xx intentionally propagates the raw parse error.
          return (await res.json()) as T;
        }

        const rawBody = await res.text().catch(() => "");
        if (res.status === 409 && idempotencyKey !== undefined && isPayloadConflict(rawBody)) {
          throw new IdempotencyConflictError(idempotencyKey, path, rawBody);
        }
        throw errorFromResponse(res.status, path, rawBody, res.headers);
      } catch (err) {
        if (!(err instanceof TalosAPIError)) throw err;
        lastError = err;
        delayMs = this.nextRetryDelay(err, {
          method,
          attempt,
          idempotent,
          retryMethodsForCall,
          typedMaxAttempts,
        });
        if (delayMs === null) break;
        try {
          this.retry.onRetry({ attempt, error: err, delayMs });
        } catch {
          // A misbehaving observer must not break the bounded retry loop.
        }
      } finally {
        timeout?.dispose();
      }

      await this.wait(delayMs ?? 0, callerSignal);
    }

    const finalError = lastError ?? new TalosAPIError(0, "Retry attempts exhausted", path);
    this.notifyError({
      error: finalError,
      path,
      method,
      attempt: Math.min(attempt, maxAttempts),
      durationMs: Date.now() - startedAt,
    });
    throw finalError;
  }

  private async requestPage<T>(
    path: string,
    options?: CursorRequestOptions,
  ): Promise<CursorPage<T>> {
    const { signal, ...params } = options ?? {};
    return this.request(path, { params, signal });
  }

  // ── Talos CRUD ────────────────────────────────────────────

  async listTaloses(params?: CursorRequestOptions): Promise<CursorPage<Talos>> {
    return this.requestPage("/api/talos", params);
  }

  async getTalos(id: string): Promise<TalosDetail> {
    return this.request(`/api/talos/${id}`);
  }

  async getTalosMe(): Promise<TalosDetail> {
    return this.request("/api/talos/me");
  }

  async createTalos(params: CreateTalosParams): Promise<TalosCreated> {
    return this.request("/api/talos", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Activity ───────────────────────────────────────────────

  async listActivities(params?: ActivityPageOptions): Promise<ActivityPage> {
    const { signal, ...query } = params ?? {};
    return this.request<ActivityPage>("/api/activity", {
      params: query,
      signal,
    });
  }

  async reportActivity(
    talosId: string,
    params: ReportActivityParams,
    options?: WriteOptions,
  ): Promise<Activity> {
    return this.request(`/api/talos/${talosId}/activity`, {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  async getTalosActivities(talosId: string): Promise<Activity[]> {
    return this.request(`/api/talos/${talosId}/activity`);
  }

  // ── Revenue ────────────────────────────────────────────────

  async reportRevenue(
    talosId: string,
    params: ReportRevenueParams,
    options?: WriteOptions,
  ): Promise<Revenue> {
    return this.request(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  async getTalosRevenues(talosId: string): Promise<Revenue[]> {
    return this.request(`/api/talos/${talosId}/revenue`);
  }

  // ── Approvals ──────────────────────────────────────────────

  async createApproval(
    talosId: string,
    params: CreateApprovalParams,
    options?: WriteOptions,
  ): Promise<Approval> {
    return this.request(`/api/talos/${talosId}/approvals`, {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  async getApprovals(talosId: string, status?: string): Promise<Approval[]> {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    return this.request(`/api/talos/${talosId}/approvals`, { params });
  }

  async getApproval(talosId: string, approvalId: string): Promise<Approval> {
    return this.request(`/api/talos/${talosId}/approvals/${approvalId}`);
  }

  // ── Status ─────────────────────────────────────────────────

  async updateStatus(talosId: string, online: boolean): Promise<void> {
    await this.request(`/api/talos/${talosId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ agentOnline: online }),
    });
  }

  // ── Commerce / x402 ────────────────────────────────────────

  async registerService(
    talosId: string,
    params: RegisterServiceParams,
  ): Promise<CommerceService> {
    return this.request(`/api/talos/${talosId}/service`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async discoverServices(
    params?: DiscoverServicesParams,
  ): Promise<CursorPage<CommerceService>> {
    const { signal, ...query } = params ?? {};
    return this.requestPage("/api/services", { ...query, signal });
  }

  async purchaseService(
    talosId: string,
    params: PurchaseServiceParams,
    options?: WriteOptions,
  ): Promise<CommerceJob> {
    return this.request(`/api/talos/${talosId}/service`, {
      method: "POST",
      body: JSON.stringify({ payload: params.payload }),
      headers: { "X-PAYMENT": params.paymentHeader },
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  /**
   * High-level helper to purchase a service, handling the x402 402 challenge flow.
   *
   * Pass `options.idempotencyKey` to enable safe retry across the entire
   * 402-challenge-and-retry cycle (the key is sent only on the final POST).
   *
   * Errors raised here are typed:
   *   - {@link TalosPaymentError} when the 402 challenge is malformed/missing.
   *   - Any other TalosAPIError subclass for downstream failures.
   *
   * @param talosId - The ID of the TALOS providing the service.
   * @param buyerTalosId - The ID of the TALOS purchasing the service (for signing).
   * @param payload - Optional payload for the service.
   */
  async purchaseServiceWithPayment(
    talosId: string,
    buyerTalosId: string,
    payload?: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<CommerceJob> {
    const path = `/api/talos/${talosId}/service`;
    const url = `${this.baseUrl}${path}`;
    const body = JSON.stringify({ payload });
    const signal = options?.signal;

    if (this.chaosInjector) await this.injectChaos();

    // 1. Initial request — possibly hits a 402 challenge.
    const baseHeaders = this.mergeHeaders();
    const initialHeaders = this.signer
      ? await this.applySignature(url, "POST", baseHeaders, body, signal)
      : baseHeaders;
    const timeout = this.acquireTimeoutController(signal);
    const effectiveSignal = timeout?.signal ?? signal;
    let res: Response;
    try {
      res = await this.resolveFetch()(url, {
        method: "POST",
        headers: initialHeaders,
        body,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      });
    } catch (cause) {
      throw classifyTransportError(cause, path);
    } finally {
      timeout?.dispose();
    }

    if (res.status === 402) {
      // 2. Validate the x402 challenge.
      const authHeader = res.headers.get("WWW-Authenticate");
      if (!authHeader || !authHeader.startsWith("x402")) {
        // Preserve the legacy text so existing
        // `rejects.toThrow("Invalid x402 challenge")` assertions keep passing.
        throw new TalosPaymentError(402, "Invalid x402 challenge", path, {
          message: "Invalid x402 challenge",
          headers: { "www-authenticate": authHeader ?? "" },
        });
      }
      const challenge = parseX402Challenge(authHeader);
      if (!challenge) {
        throw new TalosPaymentError(402, "Invalid x402 challenge", path, {
          message: "Invalid x402 challenge",
          headers: { "www-authenticate": authHeader },
        });
      }

      // 3. Request signature from the Web API. Guard against a non-numeric
      //    price so NaN never reaches the downstream /sign call.
      const amount = parseFloat(challenge.price);
      if (!Number.isFinite(amount)) {
        throw new TalosPaymentError(402, "Invalid x402 challenge", path, {
          message: "Invalid x402 challenge",
          headers: { "www-authenticate": authHeader },
        });
      }
      const signRes = await this.signPayment(buyerTalosId, {
        payee: challenge.payee,
        amount,
        assetCode: challenge.token,
      });

      // 4. Retry with the X-PAYMENT header (and idempotency key if supplied)
      //    through the regular request helper, so typed errors / retry /
      //    timeout all apply.
      return this.purchaseService(talosId, {
        paymentHeader: signRes.paymentHeader,
        payload,
      }, options);
    }

    // Non-402 responses — wrap them through the typed dispatch.
    if (!res.ok) {
      const rawBody = await res.text().catch(() => "");
      throw errorFromResponse(res.status, path, rawBody, res.headers);
    }

    return (await res.json()) as CommerceJob;
  }

  // ── Wallet & Payments ──────────────────────────────────────

  async getWallet(talosId: string): Promise<Wallet> {
    return this.request(`/api/talos/${talosId}/wallet`);
  }

  async signPayment(
    talosId: string,
    params: SignPaymentParams,
  ): Promise<SignedPayment> {
    return this.request(`/api/talos/${talosId}/sign`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async transfer(
    talosId: string,
    params: TransferParams,
    options?: WriteOptions,
  ): Promise<TransferResponse> {
    return this.request(`/api/talos/${talosId}/transfer`, {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  // ── Jobs ───────────────────────────────────────────────────

  async getPendingJobs(): Promise<CommerceJob[]> {
    return this.request("/api/jobs/pending");
  }

  /**
   * Submit the result of a fulfilled job.
   *
   * Pass `options.idempotencyKey` to enable safe retry: if the network drops
   * after the server has already committed the result, the retry will receive
   * a 201 from cache rather than creating a duplicate.
   */
  async submitJobResult(
    jobId: string,
    result: unknown,
    options?: WriteOptions,
  ): Promise<CommerceJob> {
    return this.request(`/api/jobs/${jobId}/result`, {
      method: "POST",
      body: JSON.stringify({ result }),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }

  async getJobResult(jobId: string): Promise<CommerceJob> {
    return this.request(`/api/jobs/${jobId}/result`);
  }

  // ── Leaderboard ────────────────────────────────────────────

  async getLeaderboard(
    params?: CursorRequestOptions,
  ): Promise<CursorPage<LeaderboardEntry>> {
    return this.requestPage("/api/leaderboard", params);
  }

  // ── Playbooks ──────────────────────────────────────────────

  async listPlaybooks(
    params?: {
      category?: string;
      channel?: string;
      search?: string;
      sort?: "createdAt" | "price" | "title";
      direction?: "asc" | "desc";
    } & CursorRequestOptions,
  ): Promise<CursorPage<Playbook>> {
    return this.requestPage("/api/playbooks", params);
  }

  async createPlaybook(
    params: CreatePlaybookParams,
    options?: WriteOptions,
  ): Promise<Playbook> {
    return this.request("/api/playbooks", {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
    });
  }
}
