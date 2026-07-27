import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  integer,
  boolean,
  numeric,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Benchmark Runs ───────────────────────────────────────────────

export const tlsBenchmarkRuns = pgTable(
  "tls_benchmark_runs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    suite: text("suite").notNull(),
    config: jsonb("config").notNull(),
    summary: jsonb("summary").notNull(),
    status: text("status").notNull().default("completed"),
    ciRun: boolean("ci_run").notNull().default(false),
    commitSha: text("commit_sha"),
    branch: text("branch"),
    startedAt: timestamp("started_at", { mode: "date", precision: 3 }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date", precision: 3 }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_benchmark_runs_suite_started_at_idx").on(t.suite, t.startedAt),
    index("tls_benchmark_runs_commit_sha_idx").on(t.commitSha),
  ],
);

export const tlsBenchmarkResults = pgTable(
  "tls_benchmark_results",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    runId: text("run_id").notNull().references(() => tlsBenchmarkRuns.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    passed: boolean("passed").notNull(),
    meanMs: numeric("mean_ms", { precision: 18, scale: 4 }).notNull(),
    medianMs: numeric("median_ms", { precision: 18, scale: 4 }).notNull(),
    stddevMs: numeric("stddev_ms", { precision: 18, scale: 4 }).notNull(),
    minMs: numeric("min_ms", { precision: 18, scale: 4 }).notNull(),
    maxMs: numeric("max_ms", { precision: 18, scale: 4 }).notNull(),
    variance: numeric("variance", { precision: 10, scale: 6 }).notNull(),
    percentiles: jsonb("percentiles").notNull(),
    meanMemoryMb: numeric("mean_memory_mb", { precision: 10, scale: 2 }).notNull(),
    peakMemoryMb: numeric("peak_memory_mb", { precision: 10, scale: 2 }).notNull(),
    meanCpuPercent: numeric("mean_cpu_percent", { precision: 6, scale: 2 }).notNull(),
    peakCpuPercent: numeric("peak_cpu_percent", { precision: 6, scale: 2 }).notNull(),
    thresholdViolations: jsonb("threshold_violations"),
    sampleCount: integer("sample_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_benchmark_results_run_id_idx").on(t.runId),
    index("tls_benchmark_results_label_passed_idx").on(t.label, t.passed),
  ],
);

// ─── TALOS (Agent Corporation) ────────────────────────────────────

export const tlsTalos = pgTable(
  "tls_talos",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    onChainId: integer("onChainId").unique(),        // Soroban registry TALOS ID
    agentName: text("agentName").unique(),            // Prime Agent identity (e.g. "marketbot" → marketbot.talos)
    name: text("name").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("Active"),

    // Pulse Token (Stellar Soroban asset)
    stellarAssetCode: text("stellarAssetCode"),       // Stellar asset code or Soroban contract ID for Pulse token
    tokenSymbol: text("tokenSymbol"),
    pulsePrice: numeric("pulsePrice", { precision: 18, scale: 6 }).notNull().default("0"),
    totalSupply: integer("totalSupply").notNull().default(1000000),

    // Patron Equity Structure
    creatorShare: integer("creatorShare").notNull().default(60),
    investorShare: integer("investorShare").notNull().default(25),
    treasuryShare: integer("treasuryShare").notNull().default(15),

    // Local Agent Auth
    apiKey: text("apiKey").unique(),

    // Prime Agent Config
    persona: text("persona"),
    targetAudience: text("targetAudience"),
    channels: text("channels").array().notNull().default([]),
    toneVoice: text("toneVoice"),

    // Kernel Policy
    approvalThreshold: numeric("approvalThreshold", { precision: 18, scale: 2 }).notNull().default("10"),
    gtmBudget: numeric("gtmBudget", { precision: 18, scale: 2 }).notNull().default("200"),
    minPatronPulse: integer("minPatronPulse"),

    // Agent Status
    agentOnline: boolean("agentOnline").notNull().default(false),
    agentLastSeen: timestamp("agentLastSeen", { mode: "date", precision: 3 }),

    // Stellar Public Keys (G... format)
    walletPublicKey: text("walletPublicKey"),
    creatorPublicKey: text("creatorPublicKey"),
    investorPublicKey: text("investorPublicKey"),
    treasuryPublicKey: text("treasuryPublicKey"),

    // Agent Stellar Wallet (keypair — secret stored server-side, never in DB)
    agentWalletId: text("agentWalletId"),             // Stellar public key (G...) — wallet identifier
    agentWalletAddress: text("agentWalletAddress"),   // Stellar public key (G...) — for display/payment routing

    // Retirement tracking - preserves historical identity while preventing reuse
    retiredAt: timestamp("retiredAt", { mode: "date", precision: 3 }),
    retiredReason: text("retiredReason"),
    supersededBy: text("supersededBy"),               // References tlsTalos.id of replacement agent

    // Soft deletion - separates identity retirement from privacy deletion
    deletedAt: timestamp("deletedAt", { mode: "date", precision: 3 }),
    deletedReason: text("deletedReason"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    // Partial unique index: agentName must be unique among non-retired agents
    // This prevents name reuse while allowing retired agents to keep their names
    uniqueIndex("tls_talos_agentName_active_key")
      .on(t.agentName)
      .where(sql`"retiredAt" IS NULL`),
  ],
);

// ─── Patron (Shareholder) ─────────────────────────────────────────

export const tlsPatrons = pgTable(
  "tls_patrons",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    stellarPublicKey: text("stellarPublicKey").notNull(),
    role: text("role").notNull(),
    pulseAmount: integer("pulseAmount").notNull().default(0),
    share: numeric("share", { precision: 5, scale: 2 }).notNull(),
    status: text("status").notNull().default("active"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("tls_patrons_talosId_stellarPublicKey_key").on(t.talosId, t.stellarPublicKey),
  ],
);

// ─── Activity Log ─────────────────────────────────────────────────

export const tlsActivities = pgTable(
  "tls_activities",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    content: text("content").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("completed"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_activities_talosId_createdAt_idx").on(t.talosId, t.createdAt),
  ],
);

/*
export const tlsReputationInputs = pgTable(
  "tls_reputation_inputs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    jobId: text("jobId").notNull().unique(), // Unique to ensure idempotency per job
    requesterTalosId: text("requesterTalosId").notNull(),
    status: text("status").notNull(),
    
    // Explicit boundary signals
    jobCreatedAt: timestamp("jobCreatedAt", { mode: "date", precision: 3 }).notNull(),
    jobUpdatedAt: timestamp("jobUpdatedAt", { mode: "date", precision: 3 }),
    deadlineAt: timestamp("deadlineAt", { mode: "date", precision: 3 }),
    refundAmount: numeric("refundAmount", { precision: 18, scale: 6 }),
    hasResult: boolean("hasResult").notNull().default(false),
    txHash: text("txHash"), // Cryptographically linked outcome (if any)

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_reputation_inputs_talosId_jobCreatedAt_idx").on(t.talosId, t.jobCreatedAt),
    index("tls_reputation_inputs_talosId_requester_idx").on(t.talosId, t.requesterTalosId),
  ],
);
*/

// ─── Approval Request ─────────────────────────────────────────────

export const tlsApprovals = pgTable(
  "tls_approvals",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    amount: numeric("amount", { precision: 18, scale: 6 }),
    status: text("status").notNull().default("pending"),

    decidedAt: timestamp("decidedAt", { mode: "date", precision: 3 }),
    decidedBy: text("decidedBy"),
    txHash: text("txHash"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_approvals_talosId_status_idx").on(t.talosId, t.status),
  ],
);

// ─── Revenue ──────────────────────────────────────────────────────

export const tlsRevenues = pgTable(
  "tls_revenues",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
    currency: text("currency").notNull().default("USDC"),
    source: text("source").notNull(),
    txHash: text("txHash"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_revenues_talosId_createdAt_idx").on(t.talosId, t.createdAt),
  ],
);

// ─── Dividend Distribution (Patron Revenue Share History) ─────────
//
// Records each dividend distribution event so Patrons can track the
// history of revenue shared out to Mitos/Pulse token holders. One row
// per distribution event (a single POST /revenue/distribute run or a
// manually recorded distribution).

export const tlsDividends = pgTable(
  "tls_dividends",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),

    // Total USDC (or other currency) distributed to patrons in this event
    amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
    currency: text("currency").notNull().default("USDC"),

    // Number of patrons that received a payout in this event
    patronCount: integer("patronCount").notNull().default(0),

    // Total Mitos/Pulse outstanding among recipients at distribution time —
    // lets the UI reconstruct per-share payout without re-querying balances.
    totalPulse: integer("totalPulse").notNull().default(0),

    // Where the distribution came from: "revenue-share" (auto from treasury),
    // "manual" (recorded by creator/operator), etc.
    source: text("source").notNull().default("revenue-share"),

    // Optional reference to the on-chain settlement (or first tx of a batch)
    txHash: text("txHash"),

    // Optional structured per-patron breakdown of the distribution
    // (e.g. [{ stellarPublicKey, pulseAmount, amount, txHash }])
    breakdown: jsonb("breakdown"),

    status: text("status").notNull().default("completed"),

    // Idempotency key to prevent duplicate distributions
    distributionId: text("distributionId").unique(),

    // Retry metadata for failed distributions
    retryCount: integer("retryCount").notNull().default(0),
    lastError: text("lastError"),
    retryable: boolean("retryable").notNull().default(true),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_dividends_talosId_createdAt_idx").on(t.talosId, t.createdAt),
    uniqueIndex("tls_dividends_talosId_distributionId_key").on(t.talosId, t.distributionId),
  ],
);

// ─── Commerce Service (Storefront) ────────────────────────────────

export const tlsCommerceServices = pgTable(
  "tls_commerce_services",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().unique().references(() => tlsTalos.id, { onDelete: "cascade" }),
    serviceName: text("serviceName").notNull(),
    description: text("description"),
    price: numeric("price", { precision: 18, scale: 6 }).notNull(),
    currency: text("currency").notNull().default("USDC"),
    stellarPublicKey: text("stellarPublicKey").notNull(),   // Payment recipient (Stellar G... key)
    chains: text("chains").array().notNull().default(["stellar"]),

    // "instant" = server fulfills immediately via external API, "async" = agent polls & fulfills
    fulfillmentMode: text("fulfillmentMode").notNull().default("async"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
);

// ─── Commerce Job (x402 Job Queue — Stellar) ──────────────────────

export const tlsCommerceJobs = pgTable(
  "tls_commerce_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    requesterTalosId: text("requesterTalosId").notNull(),
    serviceName: text("serviceName").notNull(),
    payload: jsonb("payload"),
    result: jsonb("result"),
    status: text("status").notNull().default("pending"),
    paymentSig: text("paymentSig").unique(),   // Stellar x402 payment token hash (replay prevention)
    txHash: text("txHash"),                    // Stellar transaction hash after settlement
    amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
    bidPrice: numeric("bidPrice", { precision: 18, scale: 6 }), // Negotiated bid price (nullable)

    // Client-supplied idempotency key (Idempotency-Key request header).
    // Scoped per talosId: the same key value may be reused across different agents.
    // A partial unique index (WHERE idempotencyKey IS NOT NULL) enforces that a
    // given key is only ever processed once per agent, blocking concurrent dupes.
    idempotencyKey: text("idempotencyKey"),

    // Cached 201 response body so an identical retry returns the original result.
    idempotencyResponse: jsonb("idempotencyResponse"),

    // Leased-job ownership — prevents duplicate execution by concurrent agents
    leasedBy: text("leasedBy"),                              // talosId of lease holder (NULL = available)
    leasedAt: timestamp("leasedAt", { mode: "date", precision: 3 }), // when lease was acquired
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date", precision: 3 }), // lease TTL
    fencingToken: integer("fencingToken").notNull().default(0), // monotonic counter for stale-worker fencing

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_commerce_jobs_talosId_status_idx").on(t.talosId, t.status),
    uniqueIndex("tls_commerce_jobs_talosId_idempotencyKey_unique")
      .on(t.talosId, t.idempotencyKey)
      .where(sql`"idempotencyKey" IS NOT NULL`),
  ],
);

// ─── Playbook (Agent Knowledge Package) ───────────────────────────

export const tlsPlaybooks = pgTable(
  "tls_playbooks",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    category: text("category").notNull(),
    channel: text("channel").notNull(),
    description: text("description").notNull(),
    price: numeric("price", { precision: 18, scale: 6 }).notNull(),
    currency: text("currency").notNull().default("USDC"),
    version: integer("version").notNull().default(1),
    tags: text("tags").array().notNull().default([]),
    status: text("status").notNull().default("active"),

    // Playbook content — PRD structure: schedule, templates, hashtags, tactics
    content: jsonb("content"),

    // Verified metrics
    impressions: integer("impressions").notNull().default(0),
    engagementRate: numeric("engagementRate", { precision: 5, scale: 2 }).notNull().default("0"),
    conversions: integer("conversions").notNull().default(0),
    periodDays: integer("periodDays").notNull().default(30),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_playbooks_talosId_idx").on(t.talosId),
  ],
);

// ─── Playbook Purchase ────────────────────────────────────────────

export const tlsPlaybookPurchases = pgTable(
  "tls_playbook_purchases",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    playbookId: text("playbookId").notNull().references(() => tlsPlaybooks.id, { onDelete: "cascade" }),
    buyerPublicKey: text("buyerPublicKey").notNull(),   // Stellar G... public key
    appliedAt: timestamp("appliedAt", { mode: "date", precision: 3 }),
    txHash: text("txHash"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tls_playbook_purchases_playbookId_buyerPublicKey_key").on(t.playbookId, t.buyerPublicKey),
  ],
);

// ─── Token Purchase (Idempotency Ledger) ─────────────────────────
//
// One row per unique Stellar txHash. Inserted with status="pending" before
// side effects begin; flipped to "completed" (with a cached responseBody)
// inside the same DB transaction that commits patron + revenue writes.
//
// This makes retries safe (return cached response) and prevents concurrent
// duplicate submissions (unique PK conflict → 409 "in-progress").

export const tlsTokenPurchases = pgTable(
  "tls_token_purchases",
  {
    txHash: text("txHash").primaryKey(),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    buyerPublicKey: text("buyerPublicKey").notNull(),
    amount: integer("amount").notNull(),
    totalCost: numeric("totalCost", { precision: 18, scale: 6 }).notNull(),

    // pending | completed | failed
    status: text("status").notNull().default("pending"),

    // Stored as the JSON-serialisable object that the 200 response returns.
    // Null while status = "pending" or "failed".
    responseBody: jsonb("responseBody"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_token_purchases_talosId_createdAt_idx").on(t.talosId, t.createdAt),
  ],
);

// ─── Stellar Transaction Finality Record ─────────────────────────
//
// Tracks the settlement lifecycle of every Stellar transaction Talos submits
// or monitors.  The reconciler polls Horizon and drives each row through the
// finality state machine until it reaches a terminal state.
//
// States: PENDING → CONFIRMING → CONFIRMED | FAILED | EXPIRED | NOT_FOUND

export const tlsStellarTxRecords = pgTable(
  "tls_stellar_tx_records",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),

    // The Stellar transaction hash being tracked (unique per record)
    txHash: text("tx_hash").notNull(),

    // Which subsystem originated the tx: "commerce_job" | "token_purchase" | "other"
    sourceType: text("source_type").notNull().default("other"),

    // Opaque reference back to the originating row (job id, txHash of token purchase, etc.)
    sourceId: text("source_id"),

    // Current state-machine position
    finalityStatus: text("finality_status").notNull().default("PENDING"),

    // Ledger sequence number when the tx was submitted (if known at submission time)
    ledgerSubmitted: integer("ledger_submitted"),

    // Most recent ledger number polled; the reconciler uses this to bound re-scan
    lastLedgerChecked: integer("last_ledger_checked"),

    // Ledger in which the tx was permanently included (set when CONFIRMED)
    confirmedLedger: integer("confirmed_ledger"),

    // Running count of poll attempts (for back-off and alerting)
    pollCount: integer("poll_count").notNull().default(0),

    // Last error message from Horizon — never contains secrets or user payloads
    lastError: text("last_error"),

    // True once the reconciler has applied the downstream repair for this tx
    repairApplied: boolean("repair_applied").notNull().default(false),

    // PENDING/CONFIRMING rows older than this become EXPIRED
    expiresAt: timestamp("expires_at", { mode: "date", precision: 3 }),

    createdAt: timestamp("created_at", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", precision: 3 }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("tls_stellar_tx_records_tx_hash_unique").on(t.txHash),
    index("tls_stellar_tx_records_status_updated_idx").on(t.finalityStatus, t.updatedAt),
    index("tls_stellar_tx_records_source_idx").on(t.sourceType, t.sourceId),
  ],
);

// ─── API Key Audit Log ────────────────────────────────────────────

export const tlsApiAuditLogs = pgTable(
  "tls_api_audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "restrict" }),

    // Which endpoint was called
    method: text("method").notNull(),   // GET | POST | PATCH | PUT | DELETE
    path: text("path").notNull(),       // e.g. /api/talos/:id/sign

    // Result
    statusCode: integer("statusCode").notNull(),

    // Caller info
    ipAddress: text("ipAddress"),

    // ── Hash chain columns (tamper-evidence) ──
    sequenceNumber: integer("sequenceNumber"),          // Monotonic per-agent (0, 1, 2, ...)
    previousHash: text("previousHash"),                 // SHA-256 hex of prior entry ("GENESIS" for first)
    entryHash: text("entryHash"),                       // SHA-256 hex of this entry (canonical encoding)
    chainVersion: text("chainVersion"),                 // Schema version ("1" for current)

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_api_audit_logs_talosId_createdAt_idx").on(t.talosId, t.createdAt),
  ],
);


// ─── Lifecycle Event Log ──────────────────────────────────────────
//
// Append-only, canonical record of every governed lifecycle transition.
// `sequence` is monotonic per talosId and forms the replay cursor: an indexer
// or UI resumes from the last sequence it committed. Rows are never updated.

export const tlsLifecycleEvents = pgTable(
  "tls_lifecycle_events",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),

    sequence: integer("sequence").notNull(),      // monotonic per talosId, starts at 1
    eventType: text("eventType").notNull(),       // canonical name, see lib/governance/events.ts
    fromState: text("fromState"),                 // null for the initial "proposed" event
    toState: text("toState").notNull(),

    // Who caused it. `actorId` is a Stellar G-address or the literal "system".
    actorId: text("actorId").notNull(),
    actorRole: text("actorRole").notNull(),       // creator | operator | governance | system

    jobId: text("jobId"),                         // durable job that produced this event
    stepName: text("stepName"),                   // provisioning step, when applicable

    // Redacted diagnostic payload — never stores secrets or raw request bodies.
    detail: jsonb("detail").notNull().default({}),

    // Dedupe key for at-least-once producers (worker retries, duplicate delivery).
    idempotencyKey: text("idempotencyKey"),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tls_lifecycle_events_talosId_sequence_key").on(t.talosId, t.sequence),
    index("tls_lifecycle_events_talosId_createdAt_idx").on(t.talosId, t.createdAt),
    uniqueIndex("tls_lifecycle_events_talosId_idempotencyKey_unique")
      .on(t.talosId, t.idempotencyKey)
      .where(sql`"idempotencyKey" IS NOT NULL`),
  ],
);

// ─── Consumed Nonces (replay protection) ────────────────────────────
//
// Every signed transfer nonce is persisted here with a UNIQUE constraint on
// (talosId, nonce) so the database enforces single-use semantics across
// process restarts and concurrent requests.  Rows are retained for a short
// window after the nonce expires so delayed replays are still caught, then
// pruned by a periodic vacuum.
//
// expiry — the original transfer-authorization expiry (Unix seconds).
//          Used by the vacuum to safely remove expired rows without
//          consulting external state.
// consumedAt — wall-clock time when the nonce was first consumed.
//              Present for audit and to bound the vacuum window.

export const tlsConsumedNonces = pgTable(
  "tls_consumed_nonces",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull(),
    nonce: text("nonce").notNull(),
    expiry: integer("expiry").notNull(),             // original auth expiry (Unix seconds)
    consumedAt: timestamp("consumedAt", { mode: "date", precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tls_consumed_nonces_talosId_nonce_key").on(t.talosId, t.nonce),
    index("tls_consumed_nonces_expiry_idx").on(t.expiry),
  ],
);

// ─── Provisioning Job (durable, compensated workflow) ─────────────
//
// One row per durable lifecycle run (activate / retire / recover). Step state
// lives in `steps` so a run is fully resumable after a process restart: the
// worker leases a row, replays completed steps from the record rather than
// re-executing them, and unwinds via each step's compensation on failure.

export const tlsProvisioningJobs = pgTable(
  "tls_provisioning_jobs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),

    action: text("action").notNull(),             // activate | retire | recover
    // pending | running | completed | compensating | compensated | failed
    status: text("status").notNull().default("pending"),

    // [{ name, status, attempts, startedAt, completedAt, idempotencyKey, output, error }]
    steps: jsonb("steps").notNull().default([]),
    cursor: integer("cursor").notNull().default(0), // index of the next step to run

    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    lastError: text("lastError"),                 // redacted, operator-facing

    // Same lease/fencing contract as tls_commerce_jobs — see 0012_add_job_leases.
    leasedBy: text("leasedBy"),
    leaseExpiresAt: timestamp("leaseExpiresAt", { mode: "date", precision: 3 }),
    fencingToken: integer("fencingToken").notNull().default(0),

    requestedBy: text("requestedBy").notNull(),   // Stellar G-address of the requester
    // Scoped per talosId; a duplicate submission returns the original run.
    idempotencyKey: text("idempotencyKey").notNull(),

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
    completedAt: timestamp("completedAt", { mode: "date", precision: 3 }),
  },
  (t) => [
    uniqueIndex("tls_provisioning_jobs_talosId_idempotencyKey_unique").on(t.talosId, t.idempotencyKey),
    index("tls_provisioning_jobs_status_idx").on(t.status, t.leaseExpiresAt),
    index("tls_provisioning_jobs_talosId_createdAt_idx").on(t.talosId, t.createdAt),
  ],
);

// ─── Reputation Input Ledger ──────────────────────────────────────

export const tlsReputationInputs = pgTable(
  "tls_reputation_inputs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    jobId: text("jobId").notNull().unique(), // Unique to ensure idempotency per job
    requesterTalosId: text("requesterTalosId").notNull(),
    status: text("status").notNull(),
    
    // Explicit boundary signals
    jobCreatedAt: timestamp("jobCreatedAt", { mode: "date", precision: 3 }).notNull(),
    jobUpdatedAt: timestamp("jobUpdatedAt", { mode: "date", precision: 3 }),
    deadlineAt: timestamp("deadlineAt", { mode: "date", precision: 3 }),
    refundAmount: numeric("refundAmount", { precision: 18, scale: 6 }),
    hasResult: boolean("hasResult").notNull().default(false),
    txHash: text("txHash"), // Cryptographically linked outcome (if any)

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_reputation_inputs_talosId_jobCreatedAt_idx").on(t.talosId, t.jobCreatedAt),
    index("tls_reputation_inputs_talosId_requester_idx").on(t.talosId, t.requesterTalosId),
  ],
);
