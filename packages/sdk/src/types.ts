// ── Request types ────────────────────────────────────────────────

export interface CreateTalosParams {
  name: string;
  category: string;
  description: string;
  totalSupply?: number;
  persona?: string;
  targetAudience?: string;
  channels?: string[];
  toneVoice?: string;
  approvalThreshold?: number;
  gtmBudget?: number;
  creatorPublicKey?: string;
  walletPublicKey?: string;
  onChainId?: number;
  agentName?: string;
  initialPrice?: number;
  minPatronPulse?: number;
  stellarAssetCode?: string;
  tokenSymbol?: string;
  serviceName?: string;
  serviceDescription?: string;
  servicePrice?: number;
}

export interface ReportActivityParams {
  type: "post" | "research" | "reply" | "commerce" | "approval";
  content: string;
  channel: string;
  status?: "completed" | "pending" | "failed";
}

export interface ReportRevenueParams {
  amount: number;
  currency?: "USDC" | "XLM" | "USDT";
  source: "commerce" | "direct" | "subscription";
  txHash?: string;
}

export interface CreateApprovalParams {
  type: "transaction" | "strategy" | "policy" | "channel";
  title: string;
  description?: string;
  amount?: number;
  proposerPublicKey?: string;
}

export interface RegisterServiceParams {
  serviceName: string;
  description: string;
  price: number;
  walletAddress?: string;
}

export interface SignPaymentParams {
  payee: string;
  amount: number;
  assetCode?: string;
  assetIssuer?: string;
}

export interface DiscoverServicesParams {
  category?: string;
  self?: string;
  cursor?: string;
  limit?: number;
  sort?: "createdAt" | "price";
  direction?: "asc" | "desc";
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds. Overrides the client-level
   * `timeoutMs` for this single call. `0` disables the timeout for this call
   * regardless of the client default. Surfaces as `TalosTimeoutError`.
   */
  timeoutMs?: number;
}

export interface PurchaseServiceParams {
  paymentHeader: string;
  payload?: Record<string, unknown>;
}

export interface CursorPageParams {
  cursor?: string;
  limit?: number;
}

export interface CursorRequestOptions extends CursorPageParams {
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds. Overrides the client-level
   * `timeoutMs` for this single call. `0` disables the timeout for this call
   * regardless of the client default. Surfaces as `TalosTimeoutError`.
   */
  timeoutMs?: number;
}

export interface ActivityPageOptions extends CursorRequestOptions {
  statsOnly?: boolean;
}

export interface ActivityStats {
  totalTransactions: number;
  totalVolume: number;
  activeAgents: number;
  totalAgents: number;
  registeredServices: number;
  playbooksTraded: number;
}

export interface ActivityTransaction {
  id: string;
  type: "service" | "playbook";
  sellerName: string;
  sellerAgent: string | null;
  buyerName: string;
  buyerAgent: string | null;
  itemName: string;
  amount: number;
  currency: string;
  status: string;
  timestamp: string;
  txHash: string | null;
}

export interface ActivityPage {
  stats: ActivityStats;
  transactions: ActivityTransaction[];
  nextCursor: string | null;
}

export interface CreatePlaybookParams {
  title: string;
  category: string;
  channel: string;
  description: string;
  price: number;
  tags?: string[];
  content?: Record<string, unknown>;
  impressions?: number;
  engagementRate?: number;
  conversions?: number;
  periodDays?: number;
}

export interface TransferParams {
  to: string;
  amount: number;
}

// ── Job lease types ──────────────────────────────────────────────

/** Params for claiming a job lease (POST /api/jobs/:id/claim). */
export interface ClaimJobParams {
  /** Lease time-to-live in seconds. Positive integer, max 3600. */
  ttlSeconds?: number;
}

/** Params for heartbeating / extending a job lease (POST /api/jobs/:id/heartbeat). */
export interface HeartbeatJobParams {
  /** The fencing token returned when the lease was claimed. */
  fencingToken: number;
}

/** Params for extending a job lease (alias for heartbeat). */
export interface ExtendJobLeaseParams {
  /** The fencing token returned when the lease was claimed. */
  fencingToken: number;
  /** Optional additional TTL in seconds to request. */
  ttlSeconds?: number;
}

/** Params for releasing a job lease (POST /api/jobs/:id/release). */
export interface ReleaseJobParams {
  /** The fencing token returned when the lease was claimed. */
  fencingToken: number;
}

/** Params for reporting job progress (POST /api/jobs/:id/progress). */
export interface ReportJobProgressParams {
  /** Progress percentage 0-100. */
  percent?: number;
  /** Current stage label (1-64 chars). */
  stage?: string;
  /** Human-readable progress message (1-280 chars). */
  message?: string;
  /** The fencing token returned when the lease was claimed. */
  fencingToken?: number;
}

/** Response from a successful job claim. */
export interface ClaimedJob {
  id: string;
  leasedBy: string;
  leasedAt: string;
  leaseExpiresAt: string;
  fencingToken: number;
  status: string;
}

/** Response from a successful heartbeat / lease extension. */
export interface HeartbeatResponse {
  renewed: boolean;
  leaseExpiresAt: string;
}

/** Response from a successful lease release. */
export interface ReleaseJobResponse {
  released: boolean;
  jobId: string;
}

/** Response from a successful progress report. */
export interface JobProgressResponse {
  id: string;
  status: string;
  progress: unknown;
  fencingToken: number;
  updatedAt: string;
}

// ── Response types ───────────────────────────────────────────────

export interface Talos {
  id: string;
  onChainId?: number;
  agentName?: string;
  name: string;
  category: string;
  description: string;
  status: string;
  stellarAssetCode?: string;
  tokenSymbol?: string;
  pulsePrice: string;
  totalSupply: number;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
  persona?: string;
  targetAudience?: string;
  channels: string[];
  toneVoice?: string;
  approvalThreshold: string;
  gtmBudget: string;
  minPatronPulse?: number;
  agentOnline: boolean;
  agentLastSeen?: string;
  walletPublicKey?: string;
  creatorPublicKey?: string;
  investorPublicKey?: string;
  treasuryPublicKey?: string;
  agentWalletId?: string;
  agentWalletAddress?: string;
  createdAt: string;
  updatedAt: string;
  patrons?: number;
}

export interface TalosDetail extends Talos {
  apiKeyMasked?: string;
  activities?: Activity[];
  approvals?: Approval[];
  revenues?: Revenue[];
  commerceServices?: CommerceService[];
  patronsList?: Patron[];
}

export interface TalosCreated extends Talos {
  apiKeyOnce: string;
}

export interface Activity {
  id: string;
  talosId: string;
  type: string;
  content: string;
  channel: string;
  status: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  talosId: string;
  type: string;
  title: string;
  description?: string;
  amount?: string;
  status: string;
  decidedAt?: string;
  decidedBy?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Revenue {
  id: string;
  talosId: string;
  amount: string;
  currency: string;
  source: string;
  txHash?: string;
  createdAt: string;
}

export interface CommerceService {
  id: string;
  talosId: string;
  serviceName: string;
  category?: string;
  description?: string;
  price: string;
  currency: string;
  stellarPublicKey: string;
  chains: string[];
  fulfillmentMode: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceJob {
  id: string;
  talosId: string;
  requesterTalosId: string;
  serviceName: string;
  payload?: unknown;
  result?: unknown;
  status: string;
  amount: string;
  paymentSig?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type PaymentFinalityStatus =
  | "PENDING"
  | "CONFIRMING"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED"
  | "NOT_FOUND";

export interface RegisteredJobPaymentStatus {
  jobId: string;
  txHash: string;
  finalityStatus: PaymentFinalityStatus;
  confirmedLedger: number | null;
  lastLedgerChecked: number | null;
  pollCount: number;
  lastError: string | null;
  repairApplied: boolean;
  updatedAt: string;
}

export interface UnregisteredJobPaymentStatus {
  jobId: string;
  txHash: string | null;
  finalityStatus: null;
  registered: false;
}

export type JobPaymentStatus = RegisteredJobPaymentStatus | UnregisteredJobPaymentStatus;

/** Returns whether payment finality has reached a terminal state. */
export function isTerminalPaymentFinality(status: PaymentFinalityStatus): boolean {
  return status === "CONFIRMED" || status === "FAILED" || status === "EXPIRED" || status === "NOT_FOUND";
}

export interface Patron {
  id: string;
  talosId: string;
  stellarPublicKey: string;
  role: string;
  pulseAmount: number;
  share: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Playbook {
  id: string;
  talosId: string;
  talosName?: string;
  title: string;
  category: string;
  channel: string;
  description: string;
  price: string;
  currency: string;
  version: number;
  tags: string[];
  status: string;
  content?: unknown;
  impressions: number;
  engagementRate: string;
  conversions: number;
  periodDays: number;
  purchases?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  category: string;
  status: string;
  pulsePrice: string;
  totalSupply: number;
  patronCount: number;
  activityCount: number;
  totalRevenue: number;
  marketCap: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
}

export type CursorPage<T> = PaginatedResponse<T>;

export interface Wallet {
  agentWalletId: string;
  agentWalletAddress: string;
}

export interface SignedPayment {
  paymentHeader: string;
  from: string;
  to: string;
  amount: string;
}

export interface TransferResponse {
  status: string;
  currency: string;
  to: string;
  amount: number;
  txHash: string;
}

// ── x402 Buyer Proof Diagnostics ─────────────────────────────────

/**
 * Stage reached in the x402 buyer proof exchange.
 *
 * - `"no_challenge"`: The 402 response did not carry a valid x402 challenge.
 * - `"challenge_parsed"`: Challenge was present and parsed successfully.
 * - `"signing_requested"`: A sign-payment call was dispatched.
 * - `"proof_submitted"`: The X-PAYMENT header was attached and the retry sent.
 * - `"proof_accepted"`: The service accepted the proof (200-range response).
 * - `"proof_rejected"`: The service rejected the proof (4xx/5xx response).
 */
export type X402ProofStage =
  | "no_challenge"
  | "challenge_parsed"
  | "signing_requested"
  | "proof_submitted"
  | "proof_accepted"
  | "proof_rejected";

/**
 * Privacy-safe diagnostic snapshot of one x402 buyer proof exchange.
 *
 * All sensitive material is excluded:
 *   - `paymentHeader` (X-PAYMENT) is never included.
 *   - `payee` Stellar address is included as-is (public key, not a secret).
 *   - Amounts are surfaced as finite numbers only; parse failures surface
 *     as `NaN`.
 *
 * This type is returned by {@link diagnoseBuyerProof} and optionally
 * delivered to the {@link BuyerProofDiagnosticCallback} during
 * `purchaseServiceWithPayment`.
 */
export interface BuyerProofDiagnostics {
  /** Stage reached in the proof exchange lifecycle. */
  stage: X402ProofStage;
  /** ISO 8601 timestamp when the diagnostic was captured. */
  capturedAt: string;
  /** Path being requested (query-string credential params redacted). */
  path: string;
  /**
   * Parsed challenge fields — present when `stage >= "challenge_parsed"`.
   * The `payee` field is a Stellar public key (safe to surface).
   * `price` is the raw string from the challenge.
   * `token` and `network` are optional auxiliary fields.
   */
  challenge?: {
    payee: string;
    price: string;
    token?: string;
    network?: string;
  };
  /**
   * Numeric amount parsed from `challenge.price`.
   * `NaN` if the challenge price was not a valid finite number.
   * Present only when `stage >= "challenge_parsed"`.
   */
  parsedAmount?: number;
  /** Whether the payment header was successfully obtained from the signer. */
  signingSucceeded?: boolean;
  /**
   * Reason string if signing failed — truncated to 200 characters to
   * prevent large raw error messages from leaking through diagnostics.
   */
  signingFailureReason?: string;
  /** HTTP status code returned after submitting the proof (if submitted). */
  proofResponseStatus?: number;
  /** Whether the overall exchange was successful. */
  succeeded: boolean;
  /** Human-readable summary suitable for debug logs (no sensitive values). */
  summary: string;
}

/**
 * Callback invoked by `purchaseServiceWithPayment` when proof diagnostics
 * are available. Must not throw; exceptions are silently swallowed.
 */
export type BuyerProofDiagnosticCallback = (diag: BuyerProofDiagnostics) => void;

// ── Governance Proposals ─────────────────────────────────────────

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export function isValidProposalStatus(status: unknown): status is ProposalStatus {
  return typeof status === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(status);
}

export interface ListProposalsParams {
  status?: ProposalStatus | (string & {});
  limit?: number;
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds. Overrides the client-level
   * `timeoutMs` for this single call. `0` disables the timeout for this call
   * regardless of the client default. Surfaces as `TalosTimeoutError`.
   */
  timeoutMs?: number;
}

export interface Proposal {
  id: string;
  talosId: string;
  talosName: string;
  type: string;
  title: string;
  description: string | null;
  amount: string | null;
  status: ProposalStatus | string;
  decidedBy: string | null;
  decidedAt: string | null;
  txHash: string | null;
  createdAt: string;
}

// ── Marketplace Search ───────────────────────────────────────────

export interface CapabilityFilter {
  id: string;
  name: string;
  description: string;
  category: string;
  isActive: boolean;
}

export interface MarketplaceSearchResult {
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  price: number;
  currency: string;
  provider: string;
  rating: number;
  createdAt: string;
}

export interface MarketplaceSearchResponse {
  results: MarketplaceSearchResult[];
  total: number;
  page: number;
  limit: number;
  filters: {
    capabilities: CapabilityFilter[];
  };
}

export interface MarketplaceSearchParams {
  q?: string;
  capabilities?: string[] | string;
  limit?: number;
  page?: number;
  signal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds. Overrides the client-level
   * `timeoutMs` for this single call. `0` disables the timeout for this call
   * regardless of the client default. Surfaces as `TalosTimeoutError`.
   */
  timeoutMs?: number;
}

// ── Webhook subscriptions ───────────────────────────────────────────────────
//
// Management of outbound webhook subscriptions (create/list/delete/rotate).
// Distinct from `webhooks.ts`, which verifies *inbound* webhook deliveries.
// The plaintext signing secret is never returned except as the one-time
// `secret` field on {@link RotateWebhookSecretResult} when the server
// generates it (`generate: true`).

export interface WebhookSubscription {
  id: string;
  /** Present on the create response; omitted from list/detail responses. */
  talosId?: string;
  url: string;
  eventTypes: string[];
  description?: string | null;
  active: boolean;
  signatureVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Subscription detail shape returned by GET/PATCH (adds rotation metadata). */
export interface WebhookSubscriptionDetail extends WebhookSubscription {
  secretRotatedAt?: string | null;
  previousSecretExpiresAt?: string | null;
  rotationActive: boolean;
}

export interface CreateWebhookSubscriptionParams {
  url: string;
  /** Signing secret (16–256 chars). Never echoed back by the API. */
  secret: string;
  eventTypes: string[];
  description?: string;
}

export interface ListWebhookSubscriptionsParams extends CursorRequestOptions {
  active?: boolean;
}

export type WebhookSubscriptionPage = CursorPage<WebhookSubscription>;

export interface DeleteWebhookSubscriptionResult {
  deleted: true;
  id: string;
}

/**
 * Rotate the signing secret with a grace window (dual-sign, no downtime),
 * or finalize an in-progress rotation early by passing `finalize: true`.
 * Exactly one of `secret`, `generate`, or `finalize` must be provided.
 */
export interface RotateWebhookSecretParams {
  /** Caller-supplied new secret (16–256 chars). Mutually exclusive with `generate`/`finalize`. */
  secret?: string;
  /** Have the server generate a random secret, returned once in the result. */
  generate?: boolean;
  /** Grace window (seconds) during which the previous secret remains valid. */
  graceSeconds?: number;
  /** Clear the previous secret early instead of rotating. */
  finalize?: boolean;
}

export interface RotateWebhookSecretResult {
  id: string;
  secretRotatedAt: string;
  previousSecretExpiresAt: string;
  graceSeconds: number;
  /** Present only when `generate: true` was passed — shown once, never logged. */
  secret?: string;
  rotationActive: true;
}

export interface FinalizeWebhookSecretRotationResult {
  id: string;
  previousSecretCleared: boolean;
  rotationActive: false;
}

