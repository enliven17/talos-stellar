import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
);

// ─── Patron (Shareholder) ─────────────────────────────────────────

export const tlsPatrons = pgTable(
  "tls_patrons",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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

// ─── Approval Request ─────────────────────────────────────────────

export const tlsApprovals = pgTable(
  "tls_approvals",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),

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
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
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

// ─── API Key Audit Log ────────────────────────────────────────────

export const tlsApiAuditLogs = pgTable(
  "tls_api_audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),

    // Which endpoint was called
    method: text("method").notNull(),   // GET | POST | PATCH | PUT | DELETE
    path: text("path").notNull(),       // e.g. /api/talos/:id/sign

    // Result
    statusCode: integer("statusCode").notNull(),

    // Caller info
    ipAddress: text("ipAddress"),

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
