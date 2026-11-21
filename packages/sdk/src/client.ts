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
  TalosDeadlineExceededError,
  TalosPaymentError,
  classifyTransportError,
  errorFromResponse,
  parseX402Challenge,
} from "./errors.js";
import { ChaosInjectedError, ChaosInjector, FaultType } from "./chaos.js";
import {
  IdempotencyConflictError,
  isPayloadConflict,
  validateIdempotencyKey,
} from "./idempotency.js";

export { TalosAPIError };

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryMethods?: string[];
  retryStatusCodes?: number[];
  jitter?: boolean;
  random?: () => number;
}

export interface RetryOptions {
  maxAttempts?: number;
  idempotentOnly?: boolean;
  maxRetryAfterMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  onRetry?: (event: {
    attempt: number;
    error: TalosAPIError;
    delayMs: number;
  }) => void;
}

export interface WriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TalosClientOptions {
  /** Base URL of the Talos API. Defaults to `https://talos-stellar.vercel.app`. */
  baseUrl?: string;
  /** Bearer token (TALOS API key). Adds `Authorization: Bearer <key>` header. */
  apiKey?: string;
  retryPolicy?: RetryPolicyOptions;
  retry?: RetryOptions;
  timeoutMs?: number;
  onError?: (event: TalosErrorEvent) => void;
  fetch?: typeof fetch;
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

/** Default retry bounds. Conservative — well within RFC 7231 guidance. */
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

/** Methods considered safe to retry without further confirmation from the caller. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

/**
 * Sleep helper. Uses `setTimeout` so it works in both Node and the browser.
 * Returns a promise that resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Apply jitter to a delay: `delay * (1 - jitter + jitter*random)`.
 * Bounded below by 0 and above by `delay * (1 + jitter)`.
 */
function applyJitter(delay: number, jitter: number): number {
  const factor = 1 - jitter + jitter * Math.random();
  return Math.max(0, Math.round(delay * factor));
}

/**
 * Talos Protocol API client. Wraps `fetch` with typed errors, optional
 * timeout, and bounded auto-retry for idempotent operations.
 *
 * Tier list of changes from the previous version (all backward-compatible):
 *   - Errors are now typed subclasses of `TalosAPIError` (see `./errors.ts`).
 *   - `timeoutMs` enables a per-request `AbortController` timeout.
 *   - `retry.maxAttempts > 1` opt-in retries on transient failures only.
 *   - `onError` callback for centralized logging / metrics.
 *   - `fetch` injection for tests / middleware.
 */
export class TalosClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private signer?: SigningController;
  private readonly retryPolicy: Required<RetryPolicyOptions>;
  private readonly retryOptions: Required<RetryOptions>;
  private readonly timeoutMs?: number;
  private readonly fetchOverride?: typeof fetch;
  private readonly onError?: TalosClientOptions["onError"];
  private readonly chaosInjector?: ChaosInjector;
  private readonly typedRetryEnabled: boolean;

  constructor(options: TalosClientOptions = {}) {
    const normalizedRetryMethods = options.retryPolicy?.retryMethods?.map(
      (method) => method.toUpperCase(),
    );
    this.retryPolicy = {
      maxAttempts: options.retryPolicy?.maxAttempts ?? 3,
      baseDelayMs: options.retryPolicy?.baseDelayMs ?? 100,
      maxDelayMs: options.retryPolicy?.maxDelayMs ?? 1000,
      retryMethods: normalizedRetryMethods ?? [
        "GET",
        "HEAD",
        "PUT",
        "DELETE",
        "OPTIONS",
      ],
      retryStatusCodes: options.retryPolicy?.retryStatusCodes ?? [
        429, 500, 502, 503, 504,
      ],
      jitter: options.retryPolicy?.jitter ?? true,
      random: options.retryPolicy?.random ?? Math.random,
    };
    this.retryOptions = {
      ...DEFAULT_RETRY,
      ...options.retry,
      maxAttempts: Math.min(
        options.retry === undefined
          ? options.retryPolicy?.maxAttempts ?? 3
          : options.retry.maxAttempts ?? 1,
        8,
      ),
    };
    this.typedRetryEnabled = options.retry !== undefined;
    this.baseUrl = (
      options.baseUrl ?? "https://talos-stellar.vercel.app"
    ).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetchOverride = options.fetch;
    this.onError = options.onError;
    this.chaosInjector = options.chaosInjector;
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
    if (options.signer) this.signer = new SigningController(options.signer, options.signing);
  }

  /** Resolve the fetch implementation per request. Prefer override; fall back to global. */
  private resolveFetch(): typeof fetch {
    return this.fetchOverride ?? globalThis.fetch;
  }

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
        if (this.typedRetryEnabled) {
          return Math.min(
            headerDelay,
            this.retryOptions.maxRetryAfterMs,
            this.retryOptions.maxDelayMs,
          );
        }
        return Math.min(headerDelay, this.retryPolicy.maxDelayMs);
      }
    }

    if (this.typedRetryEnabled) {
      const delay = Math.min(
        this.retryOptions.baseDelayMs * Math.pow(2, attempt - 1),
        this.retryOptions.maxDelayMs,
      );
      const jitter = this.retryOptions.jitter;
      return Math.max(
        0,
        Math.round(delay * (1 - jitter + 2 * jitter * Math.random())),
      );
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

  private async request<T>(
    path: string,
    init?: RequestInit & {
      params?: Record<string, string | number | boolean>;
      idempotencyKey?: string;
      timeoutMs?: number;
    },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    const {
      params,
      signal,
      idempotencyKey,
      timeoutMs,
      ...requestInit
    } = init ?? {};
    if (params) {
      const filteredParams = Object.entries(params)
        .filter(([_, value]) => value !== undefined)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: String(value) }), {} as Record<string, string>);
      const qs = new URLSearchParams(filteredParams).toString();
      if (qs) url += `?${qs}`;
    }
    const method = (requestInit.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...this.headers };
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        headers[key] = value;
      }
    } else if (requestInit.headers) {
      Object.assign(headers, requestInit.headers);
    }
    if (idempotencyKey) {
      validateIdempotencyKey(idempotencyKey);
      headers["Idempotency-Key"] = idempotencyKey;
    }
    if (this.signer) {
      const timestamp = new Date().toISOString();
      const nonce = globalThis.crypto.randomUUID();
      const bytes = await canonicalizeRequest({
        method,
        url,
        headers,
        body: requestInit.body,
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

    const requestTimeoutMs = timeoutMs ?? this.timeoutMs;
    const hasDeadline = requestTimeoutMs !== undefined && requestTimeoutMs > 0;
    const deadline = hasDeadline ? Date.now() + requestTimeoutMs : undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const requestSignal = hasDeadline ? controller.signal : signal ?? undefined;
    const deadlineTimer = hasDeadline
      ? setTimeout(
          () => controller.abort(new Error("Request deadline exceeded")),
          requestTimeoutMs,
        )
      : undefined;
    let lastError: TalosAPIError | undefined;

    const finishWithError = (error: TalosAPIError, attempt: number, startedAt: number): never => {
      this.onError?.({
        error,
        path,
        method,
        attempt,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    };

    try {
      if (signal?.aborted) {
        throw classifyTransportError(new Error("Request aborted"), path);
      }
      for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt += 1) {
        const attemptStartedAt = Date.now();
        if (deadline !== undefined && Date.now() >= deadline && lastError) {
          throw new TalosDeadlineExceededError(lastError, 0, 0);
        }

        let response: Response;
        try {
          await this.chaosInjector?.maybeInjectFault(FaultType.NETWORK_DELAY);
          await this.chaosInjector?.maybeInjectFault(FaultType.NETWORK_DROP);
          await this.chaosInjector?.maybeInjectFault(FaultType.API_TIMEOUT);
          if (signal?.aborted) {
            throw classifyTransportError(new Error("Request aborted"), path);
          }
          response = await this.resolveFetch()(url, {
            ...requestInit,
            method,
            headers,
            signal: requestSignal,
          });
        } catch (error) {
          if (error instanceof ChaosInjectedError) throw error;
          const transportError = classifyTransportError(error, path);
          const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
          const canRetry =
            this.typedRetryEnabled &&
            attempt < this.retryOptions.maxAttempts &&
            transportError.isRetryable &&
            !signal?.aborted &&
            (!this.retryOptions.idempotentOnly ||
              IDEMPOTENT_METHODS.has(method) ||
              Boolean(idempotencyKey));
          if (!canRetry) {
            return finishWithError(transportError, attempt, attemptStartedAt);
          }
          const delayMs = this.getRetryDelay(attempt, transportError.retryAfterMs?.toString() ?? null);
          if (delayMs >= remainingMs) {
            throw new TalosDeadlineExceededError(
              transportError,
              delayMs,
              remainingMs,
            );
          }
          this.retryOptions.onRetry({ attempt, error: transportError, delayMs });
          await this.wait(delayMs, requestSignal);
          continue;
        }

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        const responseHeaders = response.headers ?? new Headers();
        const responseBody = await response.text();
        lastError = errorFromResponse(
          response.status,
          path,
          responseBody,
          responseHeaders,
        );
        if (
          response.status === 409 &&
          idempotencyKey &&
          isPayloadConflict(responseBody)
        ) {
          throw new IdempotencyConflictError(
            idempotencyKey,
            path,
            responseBody,
          );
        }
        if (signal?.aborted) {
          throw classifyTransportError(new Error("Request aborted"), path);
        }
        const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
        const policyRetry =
          !this.typedRetryEnabled &&
          this.shouldRetry(
            method,
            response.status,
            idempotencyKey
              ? [...this.retryPolicy.retryMethods, method]
              : undefined,
          );
        const typedRetry =
          this.typedRetryEnabled &&
          lastError.isRetryable &&
          (!this.retryOptions.idempotentOnly ||
            IDEMPOTENT_METHODS.has(method) ||
            Boolean(idempotencyKey));
        const canRetry =
          attempt < this.retryOptions.maxAttempts &&
          !signal?.aborted &&
          (policyRetry || typedRetry);
        if (!canRetry) {
          return finishWithError(lastError, attempt, attemptStartedAt);
        }

        const delayMs = this.getRetryDelay(
          attempt,
          responseHeaders.get("Retry-After"),
        );
        if (delayMs >= remainingMs) {
          throw new TalosDeadlineExceededError(lastError, delayMs, remainingMs);
        }
        this.retryOptions.onRetry({ attempt, error: lastError, delayMs });
        await this.wait(delayMs, requestSignal);
      }

      throw new Error("Retry loop exited unexpectedly");
    } catch (error) {
      if (
        error instanceof TalosAPIError ||
        error instanceof ChaosInjectedError ||
        error instanceof IdempotencyConflictError ||
        error instanceof SyntaxError
      ) {
        throw error;
      }
      const requestError = classifyTransportError(error, path);
      return finishWithError(requestError, this.retryOptions.maxAttempts, Date.now());
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async requestPage<T>(
    path: string,
    options?: CursorRequestOptions,
  ): Promise<CursorPage<T>> {
    const { signal, timeoutMs, ...params } = options ?? {};
    return this.request(path, { params, signal, timeoutMs });
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

  async createTalos(
    params: CreateTalosParams,
    options?: WriteOptions,
  ): Promise<TalosCreated> {
    return this.request("/api/talos", {
      method: "POST",
      body: JSON.stringify(params),
      idempotencyKey: options?.idempotencyKey,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  // ── Activity ───────────────────────────────────────────────

  async listActivities(params?: ActivityPageOptions): Promise<ActivityPage> {
    const { signal, timeoutMs, ...query } = params ?? {};
    return this.request<ActivityPage>("/api/activity", {
      params: query,
      signal,
      timeoutMs,
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
      timeoutMs: options?.timeoutMs,
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
      timeoutMs: options?.timeoutMs,
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
      timeoutMs: options?.timeoutMs,
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
      timeoutMs: options?.timeoutMs,
    });
  }

  /**
   * High-level helper to purchase a service, handling the x402 402 challenge flow.
   *
   * Errors raised here are typed:
   *   - {@link TalosPaymentError} when the 402 challenge is malformed/missing.
   *   - {@link TalosAuthenticationError} for missing credentials on the signed retry.
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

    if (this.chaosInjector) {
      await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
      await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
      await this.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
    }

    // 1. Try initial request
    const initialHeaders = await this.signedHeaders(url, {
      method: "POST",
      body: JSON.stringify({ payload }),
    });
    const res = await this.resolveFetch()(url, {
      method: "POST",
      headers: initialHeaders,
      body: JSON.stringify({ payload }),
      signal: options?.signal,
    });

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

      // 3. Request signature from the Web API.
      //    `parseFloat(undefined)` would yield NaN; we already required both
      //    keys above (parseX402Challenge rejects partial challenges), but
      //    `price` could still be the literal "abc" — guard explicitly so
      //    a malformed header never feeds NaN to the downstream /sign call.
      const amount = parseFloat(challenge.price ?? "");
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

      // 4. Retry with the X-PAYMENT header — delegated to the regular
      //    request helper, so all typed errors / retry / timeout apply.
      return this.purchaseService(talosId, {
        paymentHeader: signRes.paymentHeader,
        payload,
      }, options);
    }

    // Non-402 responses — wrap them through the typed dispatch.
    if (!res.ok) {
      throw errorFromResponse(
        res.status,
        `/api/talos/${talosId}/service`,
        await res.text(),
        res.headers,
      );
    }

    return res.json() as Promise<CommerceJob>;
  }

  private async signedHeaders(url: string, init: RequestInit): Promise<Record<string, string>> {
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
      timeoutMs: options?.timeoutMs,
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
      timeoutMs: options?.timeoutMs,
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
      timeoutMs: options?.timeoutMs,
    });
  }
}
