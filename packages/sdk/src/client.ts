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
    init?: RequestInit & { params?: Record<string, string> },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (init?.params) {
      const qs = new URLSearchParams(init.params).toString();
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

  async listTaloses(): Promise<Talos[]> {
    return this.request("/api/talos");
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

  async reportActivity(talosId: string, params: ReportActivityParams): Promise<Activity> {
    return this.request(`/api/talos/${talosId}/activity`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ── Revenue ────────────────────────────────────────────────

  async reportRevenue(talosId: string, params: ReportRevenueParams): Promise<Revenue> {
    return this.request(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      body: JSON.stringify(params),
    });
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

  async discoverServices(params?: DiscoverServicesParams): Promise<CommerceService[]> {
    const p: Record<string, string> = {};
    if (params?.category) p.category = params.category;
    if (params?.target) p.target = params.target;
    return this.request("/api/services", { params: p });
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
