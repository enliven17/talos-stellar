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
  PaginatedResponse,
  CursorPage,
  CursorRequestOptions,
  ActivityPage,
  ActivityPageOptions,
} from "./types.js";
import {
  SigningController,
  canonicalizeRequest,
  encodeSignature,
  type RequestSigner,
  type SigningControllerOptions,
} from "./signing.js";
import {
  TalosAPIError,
  errorFromResponse,
  classifyTransportError,
  parseX402Challenge,
} from "./errors.js";
import {
  isPayloadConflict,
  validateIdempotencyKey,
  IdempotencyConflictError,
} from "./idempotency.js";
import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

// Re-export so legacy `import { TalosAPIError } from "@talos-protocol/sdk/client"`
// call sites keep working.
export { TalosAPIError } from "./errors.js";

/** Optional per-write request controls (idempotency + cancellation). */
export interface WriteOptions {
  /** Idempotency key sent as the `Idempotency-Key` header for safe retries. */
  idempotencyKey?: string;
  /** Abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/**
 * Retry policy for idempotent operations. Only methods listed in
 * `retryMethods` and status codes listed in `retryStatusCodes` are retried.
 */
export interface RetryOptions {
  /** Maximum total attempts (initial + retries). Capped at 8. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry (exponential backoff). */
  baseDelayMs?: number;
  /** Upper bound on the delay in ms. */
  maxDelayMs?: number;
  /** Jitter factor (0 = none, 1 = full). A boolean is accepted for brevity. */
  jitter?: number | boolean;
  /** Methods that may be retried. Defaults to non-POST methods. */
  retryMethods?: string[];
  /** Status codes that are retried. Defaults to [429, 500, 502, 503, 504]. */
  retryStatusCodes?: number[];
  /** Observer invoked before each retry. */
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
  /** Random source for jitter (test seam). */
  random?: () => number;
  /** Cap on the `Retry-After` delay honored from the server. Default 60s. */
  maxRetryAfterMs?: number;
  /** Reserved: only retry idempotent methods. */
  idempotentOnly?: boolean;
}

export interface TalosClientOptions {
  /** Base URL of the Talos API. Defaults to `https://talos-stellar.vercel.app`. */
  baseUrl?: string;
  /** Bearer token (TALOS API key). Adds `Authorization: Bearer <key>` header. */
  apiKey?: string;
  /** Per-request timeout in ms. On expiry the request aborts with a `TalosTimeoutError`. */
  timeoutMs?: number;
  /** Retry policy (preferred name). */
  retry?: RetryOptions;
  /** Retry policy (legacy alias for {@link TalosClientOptions.retry}). */
  retryPolicy?: RetryOptions;
  /** Observer invoked once with the final error of a failed request. */
  onError?: (event: TalosErrorEvent) => void;
  /** Inject a custom `fetch` implementation (tests / middleware). */
  fetchOverride?: typeof fetch;
  /** Chaos injector for controlled fault injection. */
  chaosInjector?: ChaosInjector;
  /** Opt-in request signer. Omitting it preserves the legacy wire format. */
  signer?: RequestSigner;
  signing?: SigningControllerOptions;
}

/** Structured event emitted to {@link TalosClientOptions.onError}. */
export interface TalosErrorEvent {
  error: TalosAPIError;
  path: string;
  method: string;
  attempt: number;
  durationMs: number;
}

/** Methods considered safe to retry by default. */
const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"];

/** Status codes considered transient by default. */
const DEFAULT_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

/** Hard ceiling on total attempts (1 initial + 7 retries). */
const MAX_ATTEMPTS_CAP = 8;

/**
 * Sleep helper. Uses `setTimeout` so it works in both Node and the browser.
 * Returns a promise that resolves after `ms` milliseconds, or rejects early
 * when the abort signal fires.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Request aborted"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Talos Protocol API client. Wraps `fetch` with typed errors (see
 * `./errors.ts`), optional per-request timeout, bounded auto-retry for
 * idempotent operations, and an optional request signer.
 *
 * Every failure is surfaced as a stable subclass of {@link TalosAPIError}:
 *   - 4xx/5xx responses are parsed by {@link errorFromResponse} into the
 *     matching typed error (validation, auth, forbidden, not-found, conflict,
 *     payment, rate-limit, server, server-retryable).
 *   - Transport failures (DNS, refused, reset) become {@link TalosTransportError}.
 *   - Timeouts / aborts become {@link TalosTimeoutError}.
 * The legacy `Talos API error <status> on <path>: <body>` message is preserved
 * so existing catch blocks and `rejects.toThrow(...)` assertions keep working.
 */
export class TalosClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private signer?: SigningController;
  private timeoutMs?: number;
  private onError?: (event: TalosErrorEvent) => void;
  private fetchOverride?: typeof fetch;
  private chaosInjector?: ChaosInjector;
  private explicitMaxAttempts?: number;
  private retry: Required<
    Pick<
      RetryOptions,
      | "maxAttempts"
      | "baseDelayMs"
      | "maxDelayMs"
      | "retryMethods"
      | "retryStatusCodes"
      | "random"
      | "maxRetryAfterMs"
    >
  > & {
    jitter: number;
    onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
  };

  constructor(options: TalosClientOptions = {}) {
    const retryOpts = options.retry ?? options.retryPolicy ?? {};
    const rawJitter = retryOpts.jitter ?? true;
    this.explicitMaxAttempts =
      retryOpts.maxAttempts !== undefined
        ? Math.max(1, retryOpts.maxAttempts)
        : undefined;
    this.retry = {
      maxAttempts: Math.max(1, retryOpts.maxAttempts ?? 1),
      baseDelayMs: retryOpts.baseDelayMs ?? 100,
      maxDelayMs: retryOpts.maxDelayMs ?? 1000,
      jitter: typeof rawJitter === "boolean" ? (rawJitter ? 1 : 0) : rawJitter,
      retryMethods: retryOpts.retryMethods ?? DEFAULT_RETRY_METHODS,
      retryStatusCodes: retryOpts.retryStatusCodes ?? DEFAULT_RETRY_STATUS_CODES,
      random: retryOpts.random ?? Math.random,
      maxRetryAfterMs: retryOpts.maxRetryAfterMs ?? 60_000,
      onRetry: retryOpts.onRetry,
    };
    this.baseUrl = (
      options.baseUrl ?? "https://talos-stellar.vercel.app"
    ).replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
    this.timeoutMs = options.timeoutMs;
    this.onError = options.onError;
    this.fetchOverride = options.fetchOverride;
    this.chaosInjector = options.chaosInjector;
    if (options.signer) this.signer = new SigningController(options.signer, options.signing);
  }

  /** Resolve the fetch implementation per request. Prefer override; fall back to global. */
  private resolveFetch(): typeof fetch {
    return this.fetchOverride ?? globalThis.fetch;
  }

  /** Inject configured chaos faults before a network boundary. */
  private async maybeInjectChaos(): Promise<void> {
    if (!this.chaosInjector) return;
    await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
    await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
    await this.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
  }

  private canRetry(
    method: string,
    status: number,
    hasIdempotencyKey: boolean,
  ): boolean {
    // A caller-supplied idempotency key makes a non-idempotent method safe to
    // retry, because the server deduplicates on the key.
    return (
      this.retry.retryStatusCodes.includes(status) &&
      (this.retry.retryMethods.includes(method) || hasIdempotencyKey)
    );
  }

  private getRetryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs >= 0) {
      return Math.min(retryAfterMs, this.retry.maxRetryAfterMs);
    }
    const exponent = Math.pow(2, attempt - 1);
    const delay = Math.min(
      this.retry.baseDelayMs * exponent,
      this.retry.maxDelayMs,
    );
    if (this.retry.jitter <= 0) {
      return Math.round(delay);
    }
    return Math.round(this.retry.random() * delay);
  }

  /**
   * Low-level request helper. Public so advanced callers can hit endpoints the
   * typed methods do not expose yet, with all typed-error, retry and timeout
   * behavior applied.
   */
  async request<T>(
    path: string,
    init?: RequestInit & {
      params?: Record<string, string | number | boolean>;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    const { params, signal, idempotencyKey, ...requestInit } = init ?? {};
    if (params) {
      const filteredParams = Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .reduce(
          (acc, [key, value]) => ({ ...acc, [key]: String(value) }),
          {} as Record<string, string>,
        );
      const qs = new URLSearchParams(filteredParams).toString();
      if (qs) url += `?${qs}`;
    }
    const method = (requestInit.method ?? "GET").toUpperCase();

    let lastError: TalosAPIError | undefined;

    const hasIdempotencyKey = idempotencyKey !== undefined;
    if (idempotencyKey !== undefined) {
      validateIdempotencyKey(idempotencyKey);
    }
    const effectiveMaxAttempts =
      this.explicitMaxAttempts ??
      (hasIdempotencyKey ? 3 : 1);
    const maxAttempts = Math.min(effectiveMaxAttempts, MAX_ATTEMPTS_CAP);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      try {
        await this.maybeInjectChaos();
        return await this.executeRequest<T>(
          url,
          method,
          requestInit,
          signal,
          idempotencyKey,
          path,
        );
      } catch (err) {
        const apiErr = err instanceof TalosAPIError ? err : undefined;
        const status = apiErr?.status ?? 0;
        const retryable = this.canRetry(method, status, hasIdempotencyKey);
        if (!retryable || attempt >= maxAttempts) {
          if (apiErr) lastError = apiErr;
          this.onError?.({
            error: lastError ?? (err instanceof Error ? err : new Error(String(err))) as TalosAPIError,
            path,
            method,
            attempt,
            durationMs: Date.now() - started,
          });
          throw err;
        }
        lastError = apiErr;
        const delayMs = this.getRetryDelay(attempt, apiErr?.retryAfterMs);
        this.retry.onRetry?.({ error: err, attempt, delayMs });
        await wait(delayMs, signal ?? undefined);
      }
    }
    throw lastError ?? new TalosAPIError(0, "", path);
  }

  /** Perform a single fetch attempt (no retry). */
  private async executeRequest<T>(
    url: string,
    method: string,
    init: Omit<RequestInit, "method">,
    signal: AbortSignal | null | undefined,
    idempotencyKey: string | undefined,
    path: string,
  ): Promise<T> {
    const headers: Record<string, string> = { ...this.headers };
    const initHeaders = (init as RequestInit).headers;
    if (initHeaders) {
      if (typeof Headers !== "undefined" && initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(initHeaders)) {
        for (const [k, v] of initHeaders) headers[k] = v;
      } else {
        // Preserve key casing for plain-object headers.
        Object.assign(headers, initHeaders);
      }
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }
    if (this.signer) {
      const timestamp = new Date().toISOString();
      const nonce = globalThis.crypto.randomUUID();
      const bytes = await canonicalizeRequest({
        method,
        url,
        headers,
        body: (init as RequestInit).body,
        timestamp,
        nonce,
      });
      const signed = await this.signer.sign(
        { kind: "http-request-v1", bytes },
        { signal: signal ?? undefined, requestId: nonce },
      );
      Object.assign(headers, {
        "X-Talos-Signature-Version": "talos-request-v1",
        "X-Talos-Key-Id": signed.keyId,
        "X-Talos-Algorithm": signed.algorithm,
        "X-Talos-Timestamp": timestamp,
        "X-Talos-Nonce": nonce,
        "X-Talos-Signature": encodeSignature(signed.signature),
      });
    }

    let controller: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (this.timeoutMs) {
      controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller?.abort(), { once: true });
      }
      timeoutId = setTimeout(() => controller?.abort(), this.timeoutMs);
    }

    if (signal?.aborted) {
      throw classifyTransportError(new Error("Request aborted"), path);
    }

    const fetchImpl = this.resolveFetch();
    // Only transport-level failures (fetch rejection, timeout/abort) are
    // classified here. Response-processing errors (typed API errors, JSON
    // parse failures, idempotency conflicts) propagate unchanged.
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...(init as RequestInit),
        method,
        headers,
        signal: controller?.signal ?? signal ?? undefined,
      });
    } catch (err) {
      throw classifyTransportError(err, path);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const body = await res.text();
      if (
        res.status === 409 &&
        idempotencyKey !== undefined &&
        isPayloadConflict(body)
      ) {
        throw new IdempotencyConflictError(idempotencyKey, path, body);
      }
      throw errorFromResponse(res.status, path, body, res.headers);
    }
    if (res.status === 204 || res.status === 205) {
      return undefined as T;
    }
    // Let JSON parsing errors on successful responses propagate unchanged.
    return (await res.json()) as T;
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
   * Errors raised here are typed:
   *   - {@link TalosPaymentError} when the 402 challenge is malformed/missing.
   *   - {@link TalosAuthenticationError} for missing credentials on the signed retry.
   *   - Any other TalosAPIError subclass for downstream failures.
   */
  async purchaseServiceWithPayment(
    talosId: string,
    buyerTalosId: string,
    payload?: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<CommerceJob> {
    const path = `/api/talos/${talosId}/service`;
    const url = `${this.baseUrl}${path}`;

    await this.maybeInjectChaos();

    // 1. Initial request that may return an x402 challenge.
    const initialHeaders = await this.signedHeaders(url, {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
    const res = await this.resolveFetch()(url, {
      method: "POST",
      headers: initialHeaders,
      body: JSON.stringify({ payload }),
    });

    if (res.status === 402) {
      // 2. Validate the x402 challenge.
      const authHeader = res.headers.get("WWW-Authenticate");
      if (!authHeader || !authHeader.startsWith("x402")) {
        throw errorFromResponse(402, path, "Invalid x402 challenge", new Headers({
          "www-authenticate": authHeader ?? "",
        }));
      }
      const challenge = parseX402Challenge(authHeader);
      if (!challenge) {
        throw errorFromResponse(402, path, "Invalid x402 challenge", new Headers({
          "www-authenticate": authHeader,
        }));
      }
      const amount = parseFloat(challenge.price);
      if (!Number.isFinite(amount)) {
        throw errorFromResponse(402, path, "Invalid x402 challenge", new Headers({
          "www-authenticate": authHeader,
        }));
      }

      // 3. Request a payment signature from the buyer's TALOS.
      const signRes = await this.signPayment(buyerTalosId, {
        payee: challenge.payee,
        amount,
        assetCode: challenge.token,
      });

      // 4. Retry the purchase with the signed X-PAYMENT header.
      return this.purchaseService(talosId, {
        paymentHeader: signRes.paymentHeader,
        payload,
      }, options);
    }

    // Non-402 responses — wrap them through the typed dispatch.
    if (!res.ok) {
      const body = await res.text();
      throw errorFromResponse(res.status, path, body, res.headers);
    }

    return (await res.json()) as CommerceJob;
  }

  private async signedHeaders(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, string>> {
    if (!this.signer && !init.headers) return { ...this.headers };
    const merged = new Headers(this.headers);
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
    const headers = Object.fromEntries(merged.entries());
    if (!this.signer) return headers;
    const timestamp = new Date().toISOString();
    const nonce = globalThis.crypto.randomUUID();
    const bytes = await canonicalizeRequest({
      method: init.method ?? "GET",
      url,
      headers,
      body: init.body,
      timestamp,
      nonce,
    });
    const signed = await this.signer.sign(
      { kind: "http-request-v1", bytes },
      { signal: init.signal ?? undefined, requestId: nonce },
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

  // ── Wallet & Payments ──────────────────────────────────────

  async getWallet(talosId: string): Promise<Wallet> {
    return this.request(`/api/talos/${talosId}/wallet`);
  }

  async signPayment(
    talosId: string,
    params: SignPaymentParams,
    options?: WriteOptions,
  ): Promise<SignedPayment> {
    return this.request(`/api/talos/${talosId}/sign`, {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
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
