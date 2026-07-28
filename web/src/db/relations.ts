import { relations } from "drizzle-orm";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsApprovals,
  tlsRevenues,
  tlsDividends,
  tlsCommerceServices,
  tlsCommerceJobs,
  tlsPlaybooks,
  tlsPlaybookPurchases,
  tlsApiAuditLogs,
  tlsTokenPurchases,
  tlsBenchmarkRuns,
  tlsBenchmarkResults,
} from "./schema";

export const talosRelations = relations(tlsTalos, ({ many, one }) => ({
  patrons: many(tlsPatrons),
  activities: many(tlsActivities),
  approvals: many(tlsApprovals),
  revenues: many(tlsRevenues),
  dividends: many(tlsDividends),
  commerceServices: one(tlsCommerceServices),
  commerceJobs: many(tlsCommerceJobs),
  playbooks: many(tlsPlaybooks),
  auditLogs: many(tlsApiAuditLogs),
  tokenPurchases: many(tlsTokenPurchases),
  webhookSubscriptions: many(tlsWebhookSubscriptions),
  webhookDeliveries: many(tlsWebhookDeliveries),
}));

export const patronRelations = relations(tlsPatrons, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsPatrons.talosId], references: [tlsTalos.id] }),
}));

export const activityRelations = relations(tlsActivities, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsActivities.talosId], references: [tlsTalos.id] }),
}));

export const approvalRelations = relations(tlsApprovals, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsApprovals.talosId], references: [tlsTalos.id] }),
}));

export const revenueRelations = relations(tlsRevenues, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsRevenues.talosId], references: [tlsTalos.id] }),
}));

export const dividendRelations = relations(tlsDividends, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsDividends.talosId], references: [tlsTalos.id] }),
}));

export const commerceServiceRelations = relations(tlsCommerceServices, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsCommerceServices.talosId], references: [tlsTalos.id] }),
}));

export const commerceJobRelations = relations(tlsCommerceJobs, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsCommerceJobs.talosId], references: [tlsTalos.id] }),
}));

export const playbookRelations = relations(tlsPlaybooks, ({ one, many }) => ({
  talos: one(tlsTalos, { fields: [tlsPlaybooks.talosId], references: [tlsTalos.id] }),
  purchases: many(tlsPlaybookPurchases),
}));

export const playbookPurchaseRelations = relations(tlsPlaybookPurchases, ({ one }) => ({
  playbook: one(tlsPlaybooks, { fields: [tlsPlaybookPurchases.playbookId], references: [tlsPlaybooks.id] }),
}));

export const apiAuditLogRelations = relations(tlsApiAuditLogs, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsApiAuditLogs.talosId], references: [tlsTalos.id] }),
}));

export const tokenPurchaseRelations = relations(tlsTokenPurchases, ({ one }) => ({
  talos: one(tlsTalos, { fields: [tlsTokenPurchases.talosId], references: [tlsTalos.id] }),
}));

export const benchmarkRunRelations = relations(tlsBenchmarkRuns, ({ many }) => ({
  results: many(tlsBenchmarkResults),
}));

export const benchmarkResultRelations = relations(tlsBenchmarkResults, ({ one }) => ({
  run: one(tlsBenchmarkRuns, { fields: [tlsBenchmarkResults.runId], references: [tlsBenchmarkRuns.id] }),
}));
