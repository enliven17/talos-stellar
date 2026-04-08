import { relations } from "drizzle-orm/relations";
import { tlsTalos, tlsPatrons, tlsActivities, tlsCommerceJobs, tlsCommerceServices, tlsApprovals, tlsRevenues, tlsPlaybooks, tlsPlaybookPurchases } from "./schema";

export const tlsPatronsRelations = relations(tlsPatrons, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsPatrons.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsTalosRelations = relations(tlsTalos, ({many}) => ({
	tlsPatrons: many(tlsPatrons),
	tlsActivities: many(tlsActivities),
	tlsCommerceJobs: many(tlsCommerceJobs),
	tlsCommerceServices: many(tlsCommerceServices),
	tlsApprovals: many(tlsApprovals),
	tlsRevenues: many(tlsRevenues),
	tlsPlaybooks: many(tlsPlaybooks),
}));

export const tlsActivitiesRelations = relations(tlsActivities, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsActivities.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsCommerceJobsRelations = relations(tlsCommerceJobs, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsCommerceJobs.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsCommerceServicesRelations = relations(tlsCommerceServices, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsCommerceServices.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsApprovalsRelations = relations(tlsApprovals, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsApprovals.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsRevenuesRelations = relations(tlsRevenues, ({one}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsRevenues.talosId],
		references: [tlsTalos.id]
	}),
}));

export const tlsPlaybooksRelations = relations(tlsPlaybooks, ({one, many}) => ({
	tlsTalos: one(tlsTalos, {
		fields: [tlsPlaybooks.talosId],
		references: [tlsTalos.id]
	}),
	tlsPlaybookPurchases: many(tlsPlaybookPurchases),
}));

export const tlsPlaybookPurchasesRelations = relations(tlsPlaybookPurchases, ({one}) => ({
	tlsPlaybook: one(tlsPlaybooks, {
		fields: [tlsPlaybookPurchases.playbookId],
		references: [tlsPlaybooks.id]
	}),
}));
