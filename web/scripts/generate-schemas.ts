#!/usr/bin/env tsx
/**
 * web/scripts/generate-schemas.ts
 *
 * Generate JSON Schema files from the project's Zod schemas and write them to
 * web/src/generated/schemas/.  The generated files are committed to source
 * control so that:
 *
 *   1. The drift detector can load them at runtime without a build step.
 *   2. Schema diffs are visible in code review (a changed schema = a drift risk).
 *   3. The SDK can optionally bundle them for client-side pre-flight validation.
 *
 * Run:
 *   pnpm schemas:generate              — write schemas to src/generated/schemas/
 *   pnpm schemas:generate --check      — compare without writing (CI check)
 *
 * Re-run whenever web/src/lib/schemas.ts changes.  CI will fail the
 * openapi-snapshot test if the generated files diverge.
 *
 * Output files:
 *   src/generated/schemas/<schemaName>.json   — one file per Zod schema export
 *   src/generated/schemas/index.json          — manifest listing all schemas
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

// ── Import all Zod schemas ────────────────────────────────────────────────────

import {
  createTalosSchema,
  reportActivitySchema,
  createApprovalSchema,
  decideApprovalSchema,
  transferSchema,
  becomePatronSchema,
  revokePatronSchema,
  registerServiceSchema,
  crossChainWebhookSchema,
  submitBidSchema,
  claimJobSchema,
  heartbeatJobSchema,
  releaseJobSchema,
  submitJobResultSchema,
  reportJobProgressSchema,
  reportRevenueSchema,
  recordDividendSchema,
  updateStatusSchema,
  regenerateKeySchema,
  signPaymentSchema,
  buyTokenSchema,
  buybackSchema,
  createPlaybookSchema,
} from "../src/lib/schemas.js";

// ── Schema map: name → Zod schema → route key(s) ─────────────────────────────
//
// The "routes" field declares which HTTP method + path combinations use this
// schema as their request body.  Multiple routes can share one schema.

const schemas = [
  {
    name: "createTalos",
    schema: createTalosSchema,
    routes: ["POST /api/talos"],
  },
  {
    name: "reportActivity",
    schema: reportActivitySchema,
    routes: ["POST /api/talos/:id/activity"],
  },
  {
    name: "createApproval",
    schema: createApprovalSchema,
    routes: ["POST /api/talos/:id/approvals"],
  },
  {
    name: "decideApproval",
    schema: decideApprovalSchema,
    routes: ["POST /api/talos/:id/approvals/:approvalId/decide"],
  },
  {
    name: "transfer",
    schema: transferSchema,
    routes: ["POST /api/talos/:id/transfer"],
  },
  {
    name: "becomePatron",
    schema: becomePatronSchema,
    routes: ["POST /api/talos/:id/patron"],
  },
  {
    name: "revokePatron",
    schema: revokePatronSchema,
    routes: ["DELETE /api/talos/:id/patron"],
  },
  {
    name: "registerService",
    schema: registerServiceSchema,
    routes: ["PUT /api/talos/:id/service"],
  },
  {
    name: "crossChainWebhook",
    schema: crossChainWebhookSchema,
    routes: ["POST /api/talos/:id/cross-chain-webhook"],
  },
  {
    name: "submitBid",
    schema: submitBidSchema,
    routes: ["POST /api/jobs/:id/bid"],
  },
  {
    name: "claimJob",
    schema: claimJobSchema,
    routes: ["POST /api/jobs/:id/claim"],
  },
  {
    name: "heartbeatJob",
    schema: heartbeatJobSchema,
    routes: ["POST /api/jobs/:id/heartbeat"],
  },
  {
    name: "releaseJob",
    schema: releaseJobSchema,
    routes: ["POST /api/jobs/:id/release"],
  },
  {
    name: "submitJobResult",
    schema: submitJobResultSchema,
    routes: ["POST /api/jobs/:id/result"],
  },
  {
    name: "reportJobProgress",
    schema: reportJobProgressSchema,
    routes: ["POST /api/jobs/:id/progress"],
  },
  {
    name: "reportRevenue",
    schema: reportRevenueSchema,
    routes: ["POST /api/talos/:id/revenue"],
  },
  {
    name: "recordDividend",
    schema: recordDividendSchema,
    routes: ["POST /api/talos/:id/dividends"],
  },
  {
    name: "updateStatus",
    schema: updateStatusSchema,
    routes: ["PATCH /api/talos/:id/status"],
  },
  {
    name: "regenerateKey",
    schema: regenerateKeySchema,
    routes: ["POST /api/talos/:id/regenerate-key"],
  },
  {
    name: "signPayment",
    schema: signPaymentSchema,
    routes: ["POST /api/talos/:id/sign"],
  },
  {
    name: "buyToken",
    schema: buyTokenSchema,
    routes: ["POST /api/talos/:id/buy-token"],
  },
  {
    name: "buyback",
    schema: buybackSchema,
    routes: ["POST /api/talos/:id/revenue/buyback"],
  },
  {
    name: "createPlaybook",
    schema: createPlaybookSchema,
    routes: ["POST /api/playbooks"],
  },
] as const;

// ── Output directory ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../src/generated/schemas");

// ── Parse CLI flags ───────────────────────────────────────────────────────────

const CHECK_MODE = process.argv.includes("--check");

if (!CHECK_MODE) {
  mkdirSync(OUT_DIR, { recursive: true });
}

// ── Generate ──────────────────────────────────────────────────────────────────

const manifest: Array<{ name: string; file: string; routes: readonly string[] }> = [];
const diffs: string[] = [];

for (const entry of schemas) {
  const extracted = z.toJSONSchema(entry.schema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any",
  });

  const fileName = `${entry.name}.json`;
  const filePath = join(OUT_DIR, fileName);
  const newContent = JSON.stringify(extracted, null, 2) + "\n";

  if (CHECK_MODE) {
    if (!existsSync(filePath)) {
      diffs.push(`  ${fileName}: file missing`);
    } else {
      const existingContent = readFileSync(filePath, "utf8");
      if (existingContent !== newContent) {
        diffs.push(`  ${fileName}: content differs`);
      }
    }
  } else {
    writeFileSync(filePath, newContent, "utf8");
    console.log(`  ✓ ${fileName}`);
  }

  manifest.push({ name: entry.name, file: fileName, routes: entry.routes });
}

// Generate manifest
const manifestContent = JSON.stringify({ generated: new Date().toISOString(), schemas: manifest }, null, 2) + "\n";
const manifestPath = join(OUT_DIR, "index.json");

if (CHECK_MODE) {
  if (!existsSync(manifestPath)) {
    diffs.push(`  index.json: file missing`);
  } else {
    const existingManifest = readFileSync(manifestPath, "utf8");
    // Compare only the schemas array, ignore the generated timestamp
    const existingParsed = JSON.parse(existingManifest);
    const newParsed = JSON.parse(manifestContent);
    if (JSON.stringify(existingParsed.schemas) !== JSON.stringify(newParsed.schemas)) {
      diffs.push(`  index.json: content differs`);
    }
  }

  if (diffs.length > 0) {
    console.error("\n❌ Generated schemas are stale. Run 'pnpm --dir web schemas:generate' to update.\n");
    console.error("Differences:");
    diffs.forEach((d) => console.error(d));
    process.exit(1);
  } else {
    console.log("\n✓ All generated schemas are up to date.");
  }
} else {
  writeFileSync(manifestPath, manifestContent, "utf8");
  console.log(`\nGenerated ${schemas.length} schemas to ${OUT_DIR}`);
}
