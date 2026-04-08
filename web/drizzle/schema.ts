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
}, (table) => [
	uniqueIndex("tls_talos_apiKey_key").using("btree", table.apiKey.asc().nullsLast().op("text_ops")),
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
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
]);

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
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
	txHash: text(),
}, (table) => [
	index("tls_commerce_jobs_talosId_status_idx").using("btree", table.talosId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	uniqueIndex("tls_commerce_jobs_paymentSig_unique").using("btree", table.paymentSig.asc().nullsLast().op("text_ops")).where(sql`"paymentSig" IS NOT NULL`),
	foreignKey({
			columns: [table.talosId],
			foreignColumns: [tlsTalos.id],
			name: "tls_commerce_jobs_talosId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
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
		}).onUpdate("cascade").onDelete("cascade"),
]);
