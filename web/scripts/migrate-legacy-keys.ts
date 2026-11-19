/**
 * Legacy Key Migration Script
 *
 * Migrates plaintext API keys from tls_talos.apiKey into the tls_api_keys
 * table as admin-scoped hashed keys. This is a one-time migration.
 *
 * Usage:
 *   cd web
 *   DATABASE_URL=<pooler_url> npx tsx scripts/migrate-legacy-keys.ts
 *   DATABASE_URL=<pooler_url> npx tsx scripts/migrate-legacy-keys.ts --dry-run
 *   DATABASE_URL=<pooler_url> npx tsx scripts/migrate-legacy-keys.ts --clear-plaintext
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string
 *
 * Flags:
 *   --dry-run: Plan migration without making any writes. Prints counts only.
 *   --clear-plaintext: After successful migration, clear the plaintext apiKey column
 *                      from tls_talos. This is NOT done by default.
 *
 * The script is idempotent: it skips TALOS records that already have a
 * matching scoped key in tls_api_keys.
 */

import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, isNotNull } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { hashApiKey } from "../src/lib/auth";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool, { schema });

export interface TalosRow {
  id: string;
  apiKey: string | null;
}

export interface MigrationPlan {
  toMigrate: Array<{ talosId: string; keyHash: string }>;
  toSkip: Array<{ talosId: string; keyHash: string }>;
  errors: Array<{ talosId: string; error: string }>;
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: number;
  total: number;
}

/**
 * Pure function to plan migration from talos rows.
 * Returns a plan with rows to migrate, skip, and potential errors.
 */
export function planMigration(rows: TalosRow[]): MigrationPlan {
  const plan: MigrationPlan = {
    toMigrate: [],
    toSkip: [],
    errors: [],
  };

  for (const row of rows) {
    if (row.apiKey === null) {
      plan.errors.push({ talosId: row.id, error: "apiKey is null" });
      continue;
    }

    try {
      const keyHash = hashApiKey(row.apiKey);
      // We'll check if it exists in the DB during execution
      // For planning, we assume all are candidates for migration
      plan.toMigrate.push({ talosId: row.id, keyHash });
    } catch (err) {
      plan.errors.push({
        talosId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return plan;
}

async function checkExistingKeyHash(keyHash: string): Promise<boolean> {
  const existing = await db
    .select({ id: schema.tlsApiKeys.id })
    .from(schema.tlsApiKeys)
    .where(eq(schema.tlsApiKeys.keyHash, keyHash))
    .limit(1)
    .then((r) => r[0] ?? null);
  return !!existing;
}

async function executeMigration(
  dryRun: boolean,
  clearPlaintext: boolean
): Promise<MigrationResult> {
  const talosRows = await db
    .select({ id: schema.tlsTalos.id, apiKey: schema.tlsTalos.apiKey })
    .from(schema.tlsTalos)
    .where(isNotNull(schema.tlsTalos.apiKey));

  const plan = planMigration(talosRows);

  if (dryRun) {
    // In dry-run mode, just return counts without executing
    return {
      migrated: plan.toMigrate.length,
      skipped: 0,
      errors: plan.errors.length,
      total: talosRows.length,
    };
  }

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of plan.toMigrate) {
    const exists = await checkExistingKeyHash(item.keyHash);

    if (exists) {
      skipped++;
      continue;
    }

    try {
      await db.insert(schema.tlsApiKeys).values({
        talosId: item.talosId,
        name: "Legacy (migrated)",
        keyHash: item.keyHash,
        scopes: ["admin"],
        status: "active",
      });
      migrated++;
      console.log(`✓ Migrated key for TALOS ${item.talosId}`);
    } catch (err) {
      errors++;
      console.error(`✗ Failed to migrate key for TALOS ${item.talosId}:`, err);
    }
  }

  for (const error of plan.errors) {
    errors++;
    console.error(`✗ Error for TALOS ${error.talosId}: ${error.error}`);
  }

  // Clear plaintext keys if requested
  if (clearPlaintext && migrated > 0) {
    console.log("\nClearing plaintext apiKey columns...");
    try {
      await db
        .update(schema.tlsTalos)
        .set({ apiKey: null })
        .where(isNotNull(schema.tlsTalos.apiKey));
      console.log("✓ Cleared plaintext apiKey values");
    } catch (err) {
      console.error("✗ Failed to clear plaintext apiKey values:", err);
      errors++;
    }
  }

  return {
    migrated,
    skipped,
    errors,
    total: talosRows.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const clearPlaintext = args.includes("--clear-plaintext");

  if (dryRun) {
    console.log("🔍 Dry-run mode: no writes will be performed\n");
  }

  if (clearPlaintext && dryRun) {
    console.error("Error: --clear-plaintext cannot be used with --dry-run");
    process.exit(1);
  }

  const result = await executeMigration(dryRun, clearPlaintext);

  console.log("\n" + "═".repeat(60));
  console.log("Migration Summary");
  console.log("═".repeat(60));
  console.log(`Total rows with apiKey: ${result.total}`);
  console.log(`To migrate:            ${result.migrated}`);
  console.log(`Skipped (already exists): ${result.skipped}`);
  console.log(`Errors:                ${result.errors}`);
  console.log("═".repeat(60));

  if (dryRun) {
    console.log("\n✨ Dry-run complete. No changes were made.");
  } else if (result.errors > 0) {
    console.log("\n⚠️  Migration completed with errors.");
    process.exit(1);
  } else {
    console.log("\n✨ Migration complete!");
  }

  await pool.end();
}

// Only run main() when this file is executed directly
if (require.main === module) {
  main().catch(async (err) => {
    console.error("Fatal error:", err);
    await pool.end();
    process.exit(1);
  });
}
