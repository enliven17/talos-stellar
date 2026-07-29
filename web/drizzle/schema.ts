import { pgTable, uniqueIndex, text, integer, numeric, boolean, timestamp, foreignKey, index, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const tlsTalos = pgTable("tls_talos", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	category: text().notNull(),
	description: text().notNull(),
	status: text().default('Active').notNull(),
	stellarAssetCode: text(),
	totalSupply: integer().default(1000000).notNull(),
	creatorShare: integer().default(60).notNull(),
	investorShare: integer().default(25).notNull(),
	treasuryShare: integer().default(15).notNull(),
	apiEndpoint: text(),
	apiKey: text(),
	persona: text(),
	targetAudience: text(),
	channels: text().array().default(["stellar"]),
	toneVoice: text(),
	approvalThreshold: numeric({ precision: 18, scale:  2 }).default('10').notNull(),
	gtmBudget: numeric({ precision: 18, scale:  2 }).default('200').notNull(),
	agentOnline: boolean().default(false).notNull(),
	agentLastSeen: timestamp({ precision: 3, mode: 'string' }),
	walletPublicKey: text(),
	creatorPublicKey: text(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
	pulsePrice: numeric({ precision: 18, scale:  6 }).default('0').notNull(),
	minPatronPulse: integer(),
	onChainId: integer().unique(),
	agentName: text().unique(),
	investorPublicKey: text(),
	treasuryPublicKey: text(),
	agentWalletId: text(),
	agentWalletAddress: text(),
	// Retirement tracking - preserves historical identity while preventing reuse
	retiredAt: timestamp({ precision: 3, mode: 'string' }),
	retiredReason: text(),
	supersededBy: text(),
	// Soft deletion - separates identity retirement from privacy deletion
	deletedAt: timestamp({ precision: 3, mode: 'string' }),
	deletedReason: text(),
}, (table) => [
	uniqueIndex("tls_talos_apiKey_key").using("btree", table.apiKey.asc().nullsLast().op("text_ops")),
	// Partial unique index: agentName must be unique among non-retired agents
	uniqueIndex("tls_talos_agentName_active_key").using("btree", table.agentName.asc().nullsLast().op("text_ops")).where(sql`"retiredAt" IS NULL`),
]);

export const tlsPatrons = pgTable("tls_patrons", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
stellarPublicKey: text().notNull(),
role: text().notNull(),
share: numeric({ precision: 5, scale:  2 }).notNull(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
pulseAmount: integer().default(0).notNull(),
status: text().default('active').notNull(),
}, (table) => [
	uniqueIndex("tls_patrons_talosId_stellarPublicKey_key").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.stellarPublicKey.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_patrons_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsActivities = pgTable("tls_activities", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
type: text().notNull(),
content: text().notNull(),
channel: text().notNull(),
status: text().default('completed').notNull(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("tls_activities_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_activities_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

// 0012: lease columns added
export const tlsCommerceJobs = pgTable("tls_commerce_jobs", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
requesterTalosId: text().notNull(),
serviceName: text().notNull(),
payload: jsonb(),
result: jsonb(),
status: text().default('pending').notNull(),
paymentSig: text(),
amount: numeric({ precision: 18, scale:  6 }).notNull(),
bidPrice: numeric({ precision: 18, scale:  6 }),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
txHash: text(),
idempotencyKey: text(),
idempotencyResponse: jsonb(),
leasedBy: text(),
leasedAt: timestamp({ precision: 3, mode: 'string' }),
leaseExpiresAt: timestamp({ precision: 3, mode: 'string' }),
fencingToken: integer().default(0).notNull(),
}, (table) => [
	index("tls_commerce_jobs_talosId_status_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	uniqueIndex("tls_commerce_jobs_paymentSig_unique").using("btree", table.paymentSig.asc().nullsLast().op("text_ops")).where(sql`"paymentSig" IS NOT NULL`),
	uniqueIndex("tls_commerce_jobs_talosId_idempotencyKey_unique").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.idempotencyKey.asc().nullsLast().op("text_ops")).where(sql`"idempotencyKey" IS NOT NULL`),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_commerce_jobs_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsCommerceServices = pgTable("tls_commerce_services", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
serviceName: text().notNull(),
description: text(),
price: numeric({ precision: 18, scale:  6 }).notNull(),
currency: text().default('USDC').notNull(),
stellarPublicKey: text().notNull(),
chains: text().array().default(["stellar"]),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
fulfillmentMode: text().default('async').notNull(),
}, (table) => [
	uniqueIndex("tls_commerce_services_talosId_key").using("btree", table.talosId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_commerce_services_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsApprovals = pgTable("tls_approvals", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
type: text().notNull(),
title: text().notNull(),
description: text(),
amount: numeric({ precision: 18, scale:  6 }),
status: text().default('pending').notNull(),
decidedAt: timestamp({ precision: 3, mode: 'string' }),
decidedBy: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("tls_approvals_talosId_status_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_approvals_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsRevenues = pgTable("tls_revenues", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
amount: numeric({ precision: 18, scale:  6 }).notNull(),
currency: text().default('USDC').notNull(),
source: text().notNull(),
txHash: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("tls_revenues_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_revenues_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsPlaybooks = pgTable("tls_playbooks", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
title: text().notNull(),
category: text().notNull(),
channel: text().notNull(),
description: text().notNull(),
price: numeric({ precision: 18, scale:  6 }).notNull(),
currency: text().default('USDC').notNull(),
version: integer().default(1).notNull(),
tags: text().array().default(["stellar"]),
status: text().default('active').notNull(),
impressions: integer().default(0).notNull(),
engagementRate: numeric({ precision: 5, scale:  2 }).default('0').notNull(),
conversions: integer().default(0).notNull(),
periodDays: integer().default(30).notNull(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
content: jsonb(),
}, (table) => [
	index("tls_playbooks_talosId_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_playbooks_talosId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsPlaybookPurchases = pgTable("tls_playbook_purchases", {
id: text().primaryKey().notNull(),
playbookId: text().notNull(),
buyerPublicKey: text().notNull(),
appliedAt: timestamp({ precision: 3, mode: 'string' }),
txHash: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("tls_playbook_purchases_playbookId_buyerPublicKey_key").using("btree", table.playbookId.asc().nullsLast().op("text_ops"), table.buyerPublicKey.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.playbookId],
			foreignColumns: [tlsPlaybooks.id],
			name: "tls_playbook_purchases_playbookId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const tlsTokenPurchases = pgTable("tls_token_purchases", {
txHash: text().primaryKey().notNull(),
talosId: text().notNull(),
buyerPublicKey: text().notNull(),
amount: integer().notNull(),
totalCost: numeric({ precision: 18, scale: 6 }).notNull(),
status: text().default('pending').notNull(),
responseBody: jsonb(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
index("tls_token_purchases_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
foreignKey({ columns: [table.talosId], foreignColumns: [tlsTalos.id], name: "tls_token_purchases_talosId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);

// 0009 + 0013: dividend distribution history with idempotency/retry columns
export const tlsDividends = pgTable("tls_dividends", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
amount: numeric({ precision: 18, scale:  6 }).notNull(),
currency: text().default('USDC').notNull(),
patronCount: integer().default(0).notNull(),
totalPulse: integer().default(0).notNull(),
source: text().default('revenue-share').notNull(),
txHash: text(),
breakdown: jsonb(),
status: text().default('completed').notNull(),
distributionId: text(),
retryCount: integer().default(0).notNull(),
lastError: text(),
retryable: boolean().default(true).notNull(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
index("tls_dividends_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
uniqueIndex("tls_dividends_talosId_distributionId_key").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.distributionId.asc().nullsLast().op("text_ops")),
foreignKey({ columns: [table.talosId], foreignColumns: [tlsTalos.id], name: "tls_dividends_talosId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);

// 0007: API key audit log
export const tlsApiAuditLogs = pgTable("tls_api_audit_logs", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
method: text().notNull(),
path: text().notNull(),
statusCode: integer().notNull(),
ipAddress: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
index("tls_api_audit_logs_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
foreignKey({ columns: [table.talosId], foreignColumns: [tlsTalos.id], name: "tls_api_audit_logs_talosId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);

// 0014: governed agent lifecycle event log + durable provisioning jobs
export const tlsLifecycleEvents = pgTable("tls_lifecycle_events", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
sequence: integer().notNull(),
eventType: text().notNull(),
fromState: text(),
toState: text().notNull(),
actorId: text().notNull(),
actorRole: text().notNull(),
jobId: text(),
stepName: text(),
detail: jsonb().default({}).notNull(),
idempotencyKey: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
uniqueIndex("tls_lifecycle_events_talosId_sequence_key").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.sequence.asc().nullsLast().op("int4_ops")),
index("tls_lifecycle_events_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
uniqueIndex("tls_lifecycle_events_talosId_idempotencyKey_unique").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.idempotencyKey.asc().nullsLast().op("text_ops")).where(sql`"idempotencyKey" IS NOT NULL`),
foreignKey({ columns: [table.talosId], foreignColumns: [tlsTalos.id], name: "tls_lifecycle_events_talosId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);

export const tlsProvisioningJobs = pgTable("tls_provisioning_jobs", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
action: text().notNull(),
status: text().default('pending').notNull(),
steps: jsonb().default([]).notNull(),
cursor: integer().default(0).notNull(),
attempt: integer().default(0).notNull(),
maxAttempts: integer().default(3).notNull(),
lastError: text(),
leasedBy: text(),
leaseExpiresAt: timestamp({ precision: 3, mode: 'string' }),
fencingToken: integer().default(0).notNull(),
requestedBy: text().notNull(),
idempotencyKey: text().notNull(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
completedAt: timestamp({ precision: 3, mode: 'string' }),
}, (table) => [
uniqueIndex("tls_provisioning_jobs_talosId_idempotencyKey_unique").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.idempotencyKey.asc().nullsLast().op("text_ops")),
index("tls_provisioning_jobs_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.leaseExpiresAt.asc().nullsLast().op("timestamp_ops")),
index("tls_provisioning_jobs_talosId_createdAt_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
foreignKey({ columns: [table.talosId], foreignColumns: [tlsTalos.id], name: "tls_provisioning_jobs_talosId_fkey" }).onUpdate("cascade").onDelete("cascade"),
]);

// 0015: consumed nonces for replay protection
export const tlsConsumedNonces = pgTable("tls_consumed_nonces", {
id: text().primaryKey().notNull(),
talosId: text().notNull(),
nonce: text().notNull(),
expiry: integer().notNull(),
consumedAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
uniqueIndex("tls_consumed_nonces_talosId_nonce_key").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.nonce.asc().nullsLast().op("text_ops")),
index("tls_consumed_nonces_expiry_idx").using("btree", table.expiry.asc().nullsLast().op("int4_ops")),
]);

// 0016: transactional outbox for domain events
export const tlsOutboxEvents = pgTable("tls_outbox_events", {
id: text().primaryKey().notNull(),
aggregateType: text().notNull(),
aggregateId: text().notNull(),
eventType: text().notNull(),
payload: jsonb().default({}).notNull(),
status: text().default('pending').notNull(),
runAt: timestamp({ precision: 3, mode: 'string' }).default(sql`now()`).notNull(),
leaseId: text(),
leaseOwner: text(),
leaseExpiresAt: timestamp({ precision: 3, mode: 'string' }),
attempts: integer().default(0).notNull(),
maxAttempts: integer().default(8).notNull(),
dedupeKey: text(),
lastError: text(),
createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`now()`).notNull(),
updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
dispatchedAt: timestamp({ precision: 3, mode: 'string' }),
}, (table) => [
index("tls_outbox_events_status_runAt_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.runAt.asc().nullsLast().op("timestamp_ops")),
index("tls_outbox_events_eventType_status_idx").using("btree", table.eventType.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
index("tls_outbox_events_leaseExpiresAt_idx").using("btree", table.leaseExpiresAt.asc().nullsLast().op("timestamp_ops")),
index("tls_outbox_events_dispatchedAt_idx").using("btree", table.dispatchedAt.asc().nullsLast().op("timestamp_ops")),
uniqueIndex("tls_outbox_events_eventType_dedupeKey_unique").using("btree", table.eventType.asc().nullsLast().op("text_ops"), table.dedupeKey.asc().nullsLast().op("text_ops")).where(sql`"dedupeKey" IS NOT NULL`),
]);
