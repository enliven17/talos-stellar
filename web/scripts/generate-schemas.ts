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
 *   pnpm schemas:generate
 *
 * Re-run whenever web/src/lib/schemas.ts changes.  CI will fail the
 * openapi-snapshot test if the generated files diverge.
 *
 * Output files:
 *   src/generated/schemas/<schemaName>.json   — one file per Zod schema export
 *   src/generated/schemas/index.json          — manifest listing all schemas
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";

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
  reportRevenueSchema,
  recordDividendSchema,
  updateStatusSchema,
  regenerateKeySchema,
  signPaymentSchema,
  buyTokenSchema,
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
    name: "createPlaybook",
    schema: createPlaybookSchema,
    routes: ["POST /api/playbooks"],
  },
] as const;

// ── Output directory ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../src/generated/schemas");
mkdirSync(OUT_DIR, { recursive: true });

// ── Generate ──────────────────────────────────────────────────────────────────

const manifest: Array<{ name: string; file: string; routes: readonly string[] }> = [];

for (const entry of schemas) {
  const jsonSchema = zodToJsonSchema(entry.schema, {
    name: entry.name,
    $refStrategy: "none", // inline all refs — simpler for the runtime validator
    target: "jsonSchema7",
  });

  // zodToJsonSchema wraps in { definitions: { <name>: ... } } when name is given
  // Extract the actual schema object
  const extracted =
    (jsonSchema as Record<string, unknown>).definitions?.[entry.name] ??
    jsonSchema;

  const fileName = `${entry.name}.json`;
  const filePath = join(OUT_DIR, fileName);

  writeFileSync(filePath, JSON.stringify(extracted, null, 2) + "\n", "utf8");
  manifest.push({ name: entry.name, file: fileName, routes: entry.routes });

  console.log(`  ✓ ${fileName}`);
}

// Write manifest
writeFileSync(
  join(OUT_DIR, "index.json"),
  JSON.stringify({ generated: new Date().toISOString(), schemas: manifest }, null, 2) + "\n",
  "utf8",
);

console.log(`\nGenerated ${schemas.length} schemas to ${OUT_DIR}`);
