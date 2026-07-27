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
import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryMethods?: string[];
  retryStatusCodes?: number[];
  jitter?: boolean;
  random?: () => number;
}

export interface TalosClientOptions {
  baseUrl?: string;
  apiKey?: string;
  retryPolicy?: RetryPolicyOptions;
  chaosInjector?: ChaosInjector;
}

export class TalosClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private readonly retryPolicy: Required<RetryPolicyOptions>;
  private readonly chaosInjector?: ChaosInjector;

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
    this.baseUrl = (
      options.baseUrl ?? "https://talos-stellar.vercel.app"
    ).replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
    this.chaosInjector = options.chaosInjector;
  }

  // ── Internal fetch helper ──────────────────────────────────

  private shouldRetry(method: string, status: number): boolean {
    return (
      this.retryPolicy.retryStatusCodes.includes(status) &&
      this.retryPolicy.retryMethods.includes(method)
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

  private async request<T>(
    path: string,
    init?: RequestInit & { params?: Record<string, string | number | boolean> },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    const { params, signal, ...requestInit } = init ?? {};
    const normalizedSignal = signal ?? undefined;
    if (params) {
      const filteredParams = Object.entries(params)
        .filter(([_, value]) => value !== undefined)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: String(value) }), {});
      const qs = new URLSearchParams(filteredParams).toString();
      if (qs) url += `?${qs}`;
    }

    const method = requestInit.method?.toString().toUpperCase() ?? "GET";

    for (
      let attempt = 1;
      attempt <= this.retryPolicy.maxAttempts;
      attempt += 1
    ) {
      if (this.chaosInjector) {
        await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
        await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
        await this.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
      }

      const res = await fetch(url, {
        ...requestInit,
        ...(normalizedSignal ? { signal: normalizedSignal } : {}),
        headers: { ...this.headers, ...requestInit.headers },
      });

      if (res.ok) {
        return res.json() as Promise<T>;
      }

      const shouldRetry = this.shouldRetry(method, res.status);
      if (!shouldRetry || attempt === this.retryPolicy.maxAttempts) {
        const body = await res.text();
        throw new TalosAPIError(res.status, body, path);
      }

      const retryAfterHeader = res.headers.get("Retry-After");
      const delay = this.getRetryDelay(attempt, retryAfterHeader);
      await this.wait(delay, normalizedSignal);
    }

    throw new Error("Unexpected retry failure");
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
  ): Promise<Activity> {
    return this.request(`/api/talos/${talosId}/activity`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTalosActivities(talosId: string): Promise<Activity[]> {
    return this.request(`/api/talos/${talosId}/activity`);
  }

  // ── Revenue ────────────────────────────────────────────────

  async reportRevenue(
    talosId: string,
    params: ReportRevenueParams,
  ): Promise<Revenue> {
    return this.request(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTalosRevenues(talosId: string): Promise<Revenue[]> {
    return this.request(`/api/talos/${talosId}/revenue`);
  }

  // ── Approvals ──────────────────────────────────────────────

  async createApproval(
    talosId: string,
    params: CreateApprovalParams,
  ): Promise<Approval> {
    return this.request(`/api/talos/${talosId}/approvals`, {
      method: "POST",
      body: JSON.stringify(params),
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
  ): Promise<CommerceJob> {
    return this.request(`/api/talos/${talosId}/service`, {
      method: "POST",
      body: JSON.stringify({ payload: params.payload }),
      headers: { "X-PAYMENT": params.paymentHeader },
    });
  }

  /**
   * High-level helper to purchase a service, handling the x402 402 challenge flow.
   *
   * @param talosId - The ID of the TALOS providing the service.
   * @param buyerTalosId - The ID of the TALOS purchasing the service (for signing).
   * @param payload - Optional payload for the service.
   */
  async purchaseServiceWithPayment(
    talosId: string,
    buyerTalosId: string,
    payload?: Record<string, unknown>,
  ): Promise<CommerceJob> {
    let res: Response;
    const url = `${this.baseUrl}/api/talos/${talosId}/service`;

    if (this.chaosInjector) {
      await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
      await this.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
      await this.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
    }

    // 1. Try initial request
    res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ payload }),
    });

    if (res.status === 402) {
      // 2. Handle x402 challenge
      const authHeader = res.headers.get("WWW-Authenticate");
      if (!authHeader || !authHeader.startsWith("x402 ")) {
        throw new Error("Invalid x402 challenge");
      }

      // Parse challenge: x402 price="0.50", payee="G...", token="USDC", network="stellar:testnet"
      const challenge = this.parseX402Challenge(authHeader);

      // 3. Request signature from Web API
      const signRes = await this.signPayment(buyerTalosId, {
        payee: challenge.payee,
        amount: parseFloat(challenge.price),
        assetCode: challenge.token,
      });

      // 4. Retry with X-PAYMENT header
      return this.purchaseService(talosId, {
        paymentHeader: signRes.paymentHeader,
        payload,
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new TalosAPIError(
        res.status,
        body,
        `/api/talos/${talosId}/service`,
      );
    }

    return res.json() as Promise<CommerceJob>;
  }

  private parseX402Challenge(header: string): Record<string, string> {
    const parts = header.slice(5).split(", ");
    const challenge: Record<string, string> = {};
    for (const part of parts) {
      const [key, value] = part.split("=");
      challenge[key] = value.replace(/"/g, "");
    }
    return challenge;
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
  ): Promise<TransferResponse> {
    return this.request(`/api/talos/${talosId}/transfer`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Jobs ───────────────────────────────────────────────────

  async getPendingJobs(): Promise<CommerceJob[]> {
    return this.request("/api/jobs/pending");
  }

  async submitJobResult(jobId: string, result: unknown): Promise<CommerceJob> {
    return this.request(`/api/jobs/${jobId}/result`, {
      method: "POST",
      body: JSON.stringify({ result }),
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

  async createPlaybook(params: CreatePlaybookParams): Promise<Playbook> {
    return this.request("/api/playbooks", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }
}

export class TalosAPIError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Talos API error ${status} on ${path}: ${body}`);
    this.name = "TalosAPIError";
  }
}
