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
} from "./types.js";

export interface TalosClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class TalosClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(options: TalosClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://talos-stellar.vercel.app").replace(/\/$/, "");
    this.headers = { "Content-Type": "application/json" };
    if (options.apiKey) {
      this.headers["Authorization"] = `Bearer ${options.apiKey}`;
    }
  }

  // ── Internal fetch helper ──────────────────────────────────

  private async request<T>(
    path: string,
    init?: RequestInit & { params?: Record<string, string | number | boolean> },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (init?.params) {
      const filteredParams = Object.entries(init.params)
        .filter(([_, value]) => value !== undefined)
        .reduce((acc, [key, value]) => ({ ...acc, [key]: String(value) }), {});
      const qs = new URLSearchParams(filteredParams).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers, ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TalosAPIError(res.status, body, path);
    }
    return res.json() as Promise<T>;
  }

  // ── Talos CRUD ────────────────────────────────────────────

  async listTaloses(params?: { cursor?: string; limit?: number }): Promise<PaginatedResponse<Talos>> {
    return this.request("/api/talos", { params });
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

  async listActivities(params?: { cursor?: string; limit?: number; statsOnly?: boolean }): Promise<any> {
    return this.request("/api/activity", { params });
  }

  async reportActivity(talosId: string, params: ReportActivityParams): Promise<Activity> {
    return this.request(`/api/talos/${talosId}/activity`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTalosActivities(talosId: string): Promise<Activity[]> {
    return this.request(`/api/talos/${talosId}/activity`);
  }

  // ── Revenue ────────────────────────────────────────────────

  async reportRevenue(talosId: string, params: ReportRevenueParams): Promise<Revenue> {
    return this.request(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTalosRevenues(talosId: string): Promise<Revenue[]> {
    return this.request(`/api/talos/${talosId}/revenue`);
  }

  // ── Approvals ──────────────────────────────────────────────

  async createApproval(talosId: string, params: CreateApprovalParams): Promise<Approval> {
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

  async registerService(talosId: string, params: RegisterServiceParams): Promise<CommerceService> {
    return this.request(`/api/talos/${talosId}/service`, {
      method: "PUT",
      body: JSON.stringify(params),
    });
  }

  async discoverServices(params?: DiscoverServicesParams): Promise<PaginatedResponse<CommerceService>> {
    return this.request("/api/services", { params: params as any });
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
      throw new TalosAPIError(res.status, body, `/api/talos/${talosId}/service`);
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

  async signPayment(talosId: string, params: SignPaymentParams): Promise<SignedPayment> {
    return this.request(`/api/talos/${talosId}/sign`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async transfer(talosId: string, params: TransferParams): Promise<TransferResponse> {
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

  async getLeaderboard(params?: { cursor?: string; limit?: number }): Promise<PaginatedResponse<LeaderboardEntry>> {
    return this.request("/api/leaderboard", { params });
  }

  // ── Playbooks ──────────────────────────────────────────────

  async listPlaybooks(params?: {
    category?: string;
    channel?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedResponse<Playbook>> {
    return this.request("/api/playbooks", { params });
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
