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

// ── Agent lifecycle & governance status ──────────────────────────

/**
 * The three lifecycle statuses exposed via `PATCH /api/talos/:id/status`.
 *
 * These map onto the legacy `tls_talos.status` column and are the only values
 * the server accepts for `lifecycleStatus`. Defining a closed union lets the
 * compiler reject typos and unknown states at compile time (acceptance
 * criterion: "Invalid statuses are compile-time errors").
 *
 * The richer state machine in `docs/AGENT_LIFECYCLE.md` (proposed,
 * provisioning, retiring, …) is driven through `POST /api/talos/:id/lifecycle`
 * which is out of scope for this SDK surface; retirement signature flows are
 * explicitly out of scope per issue #1010.
 */
export type LifecycleStatus = "Active" | "Paused" | "Retired";

/**
 * Options for {@link TalosClient.setLifecycleStatus}.
 *
 * `governanceApproved` is forwarded to the server so that `Retired` can satisfy
 * the 403 retirement guard in `PATCH /api/talos/:id/status`. It is a compile-time
 * boolean rather than a free-form flag so callers cannot forget to set it.
 */
export interface SetLifecycleStatusOptions {
  /**
   * Required (and must be `true`) when `status === "Retired"`. The server
   * returns `403` with "Retirement requires explicit governance confirmation"
   * when this is omitted or `false` on a retire request.
   */
  governanceApproved?: boolean;
}

/**
 * Response shape for `PATCH /api/talos/:id/status` when `lifecycleStatus` is
 * supplied. Mirrors the JSON returned by `web/src/app/api/talos/[id]/status/route.ts`.
 */
export interface LifecycleStatusResponse {
  id: string;
  status: string;
  agentOnline: boolean;
  agentLastSeen: string;
}

/**
 * One row from the keyset-paginated `events` array returned by
 * `GET /api/talos/:id/lifecycle`. The fields mirror the `LifecycleEventRow`
 * shape produced by `web/src/lib/governance/events.ts` (serialized to JSON).
 */
export interface LifecycleEvent {
  id: string;
  sequence: number;
  eventType: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  actorRole: string;
  jobId: string | null;
  stepName: string | null;
  detail: unknown;
  createdAt: string;
}

/**
 * Query options for {@link TalosClient.listLifecycleEvents}.
 *
 * The endpoint uses keyset pagination keyed on `sequence` (newest first). We
 * expose `cursor` (the numeric `before` value as a string) plus `limit` so the
 * method composes with the existing {@link CursorRequestOptions} / async
 * iterator infrastructure.
 */
export interface LifecycleEventsOptions extends CursorRequestOptions {
  /** Stellar G-address of the viewer; surfaces `allowedActions` server-side. */
  viewer?: string;
}

/**
 * Normalized cursor-paginated page of lifecycle events.
 *
 * The server response nests `events` under an `events` key and returns a
 * numeric `nextCursor`; this type aligns the shape with {@link CursorPage} so
 * {@link createPaginationIterator} works out of the box.
 */
export interface LifecycleEventsPage {
  data: LifecycleEvent[];
  nextCursor: string | null;
}
