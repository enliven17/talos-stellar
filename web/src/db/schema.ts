import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
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

// ─── A2A Budget Reservation & Usage Accounting ────────────────────
//
// Three tables in concert provide durable, atomic financial state for
// autonomous commerce:
//
//   tls_budgets                — config / limits (per scope, per agent)
//   tls_budget_reservations    — durable state ledger of every reservation
//                                and its lifecycle transitions
//   tls_budget_usage_events    — immutable event journal driving
//                                reconciliation; amount is a signed minor-
//                                unit delta
//
// Amounts are tracked strictly in **minor units** (PostgreSQL `bigint`,
// mapped to JS `BigInt`) to avoid floating-point drift across cumulative
// accounting.  Reserved/committed/settled/refunded/expired/released states
// follow the contract documented in BUDGETS.md.
//
// Migration: web/drizzle/0014_add_budget_reservations.sql
// Service module: web/src/lib/budgets/budget-services.ts
// Pure reconciler: web/src/lib/budgets/reconciliation.ts

export const tlsBudgets = pgTable(
  "tls_budgets",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    // 'global' | 'rolling' | 'category' | 'asset' | 'transaction' | 'counterparty'
    scopeKind: text("scopeKind").notNull(),
    // Disambiguator: NULL for the global budget of an agent, 'daily'|'hourly'
    // for rolling buckets, category/asset/counterparty label otherwise.
    scopeValue: text("scopeValue"),
    // NULL unless scopeKind === 'rolling' (covers daily/hourly trade windows)
    windowSeconds: integer("windowSeconds"),
    // Budget cap in minor units. For non-rolling scopes, also the highest
    // amount `availableAmount` may ever reach.
    limitAmount: bigint("limitAmount", { mode: "bigint" }).notNull(),
    // Mirror of the computed available amount for non-rolling scopes so
    // reads can be served without re-aggregating events+reservations.
    // For rolling scopes the field may be stale; trust computeBudgetAvailability.
    availableAmount: bigint("availableAmount", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull().default("USDC"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("tls_budgets_talosId_scopeKind_scopeValue_unique")
      .on(t.talosId, t.scopeKind, t.scopeValue),
    index("tls_budgets_talosId_enabled_idx").on(t.talosId, t.enabled),
  ],
);

export const tlsBudgetReservations = pgTable(
  "tls_budget_reservations",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    budgetId: text("budgetId").notNull().references(() => tlsBudgets.id, { onDelete: "cascade" }),
    // Positive minor units.
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    // reserved | committed | settled | released | expired | refunded
    status: text("status").notNull().default("reserved"),
    // Scoped per talosId; enforced via partial unique index below.
    idempotencyKey: text("idempotencyKey"),
    // Optional scope refs for category / asset / counterparty accounting.
    counterpartyId: text("counterpartyId"),
    category: text("category"),
    assetCode: text("assetCode"),
    // Optional link to a Stellar tx or commerce job.
    txHash: text("txHash"),
    jobId: text("jobId"),
    // Lazy expiry — past this timestamp, the reservation is treated as expired.
    expiresAt: timestamp("expiresAt", { mode: "date", precision: 3 }),
    // Monotonic counter incremented at every transition. The transition
    // caller must supply the matching current token to defend against
    // stale-worker writes.
    fencingToken: integer("fencingToken").notNull().default(0),
    // For refunds that are issued against a previously-settled reservation.
    parentReservationId: text("parentReservationId"),
    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_budget_reservations_talosId_status_idx").on(t.talosId, t.status),
    index("tls_budget_reservations_budgetId_status_idx").on(t.budgetId, t.status),
    index("tls_budget_reservations_expiresAt_idx")
      .on(t.expiresAt)
      .where(sql`"status" = 'reserved'`),
    uniqueIndex("tls_budget_reservations_talosId_idempotencyKey_unique")
      .on(t.talosId, t.idempotencyKey)
      .where(sql`"idempotencyKey" IS NOT NULL`),
  ],
);

export const tlsBudgetUsageEvents = pgTable(
  "tls_budget_usage_events",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    talosId: text("talosId").notNull().references(() => tlsTalos.id, { onDelete: "cascade" }),
    budgetId: text("budgetId").notNull().references(() => tlsBudgets.id, { onDelete: "cascade" }),
    // ON DELETE SET NULL: keeping historical events even if a reservation
    // row is removed preserves the audit trail.
    reservationId: text("reservationId"),
    // reserve | commit | settle | refund | expire | release | reject
    kind: text("kind").notNull(),
    // Signed delta in minor units: positive for in-flows, negative for
    // releases / refunds. Always non-zero.
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("tls_budget_usage_events_budgetId_createdAt_idx").on(t.budgetId, t.createdAt),
    index("tls_budget_usage_events_reservationId_idx")
      .on(t.reservationId)
      .where(sql`"reservationId" IS NOT NULL`),
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
