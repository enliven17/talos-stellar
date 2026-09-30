import { pgTable, text, integer, boolean, timestamp, uuid } from 'drizzle-orm/pg-core';

export const capabilities = pgTable('capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const marketplaceItems = pgTable('marketplace_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  price: integer('price').notNull(),
  currency: text('currency').notNull().default('USD'),
  provider: text('provider').notNull(),
  rating: integer('rating').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const itemCapabilities = pgTable('item_capabilities', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id')
    .references(() => marketplaceItems.id)
    .notNull(),
  capabilityId: uuid('capability_id')
    .references(() => capabilities.id)
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});