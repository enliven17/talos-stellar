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

    createdAt: timestamp("createdAt", { mode: "date", precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 }).notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("tls_commerce_jobs_talosId_status_idx").on(t.talosId, t.status),
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
