/**
 * Legacy Key Migration Script
 *
 * Migrates plaintext API keys from tls_talos.apiKey into the tls_api_keys
 * table as admin-scoped hashed keys. This is a one-time migration.
 *
 * Usage:
 *   npx tsx src/lib/migrate-legacy-keys.ts
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string
 *
 * The script is idempotent: it skips TALOS records that already have a
 * matching scoped key in tls_api_keys.
 */
import { db } from "@/db";
import { tlsTalos, tlsApiKeys } from "@/db/schema";
import { eq, isNotNull, sql } from "drizzle-orm";
import { hashApiKey } from "@/lib/auth";
import { logger } from "@/lib/logger";

async function migrateLegacyKeys() {
  const talosRows = await db
    .select({ id: tlsTalos.id, apiKey: tlsTalos.apiKey })
    .from(tlsTalos)
    .where(isNotNull(tlsTalos.apiKey));

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of talosRows) {
    if (!row.apiKey) continue;

    const keyHash = hashApiKey(row.apiKey);

    // Check if a matching scoped key already exists
    const existing = await db
      .select({ id: tlsApiKeys.id })
      .from(tlsApiKeys)
      .where(eq(tlsApiKeys.keyHash, keyHash))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing) {
      skipped++;
      continue;
    }

    try {
      await db.insert(tlsApiKeys).values({
        talosId: row.id,
        name: "Legacy (migrated)",
        keyHash,
        scopes: ["admin"],
        status: "active",
      });
      migrated++;
      logger.info({ talosId: row.id }, "migrate: legacy key migrated");
    } catch (err) {
      errors++;
      logger.error({ talosId: row.id, err }, "migrate: failed to migrate legacy key");
    }
  }

  logger.info({ migrated, skipped, errors, total: talosRows.length }, "migrate: legacy key migration complete");
}

migrateLegacyKeys().catch((err) => {
  logger.error({ err }, "migrate: fatal error");
  process.exit(1);
});
