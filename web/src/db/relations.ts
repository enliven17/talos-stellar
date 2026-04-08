import { relations } from "drizzle-orm";
import {
  tlsTalos,
  tlsPatrons,
  tlsActivities,
  tlsApprovals,
  tlsRevenues,
  tlsCommerceServices,
  tlsCommerceJobs,
  tlsPlaybooks,
  tlsPlaybookPurchases,
} from "./schema";

export const talosRelations = relations(tlsTalos, ({ many, one }) => ({
  patrons: many(tlsPatrons),
  activities: many(tlsActivities),
  approvals: many(tlsApprovals),
  revenues: many(tlsRevenues),
  commerceServices: one(tlsCommerceServices),
  commerceJobs: many(tlsCommerceJobs),
  playbooks: many(tlsPlaybooks),
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
