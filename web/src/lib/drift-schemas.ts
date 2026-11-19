/**
 * Schema registry bootstrap for the drift detection system.
 *
 * Loads the generated JSON Schema files from web/src/generated/schemas/ and
 * registers them against their canonical route keys so that withDriftDetection
 * can look them up by "METHOD /path/pattern".
 *
 * Import this module ONCE at application startup (e.g. from a shared layout or
 * from each route file that wants drift detection).  It is safe to import
 * multiple times — registerSchema is idempotent.
 *
 * The generated JSON files are committed to source control and updated by
 * running `pnpm schemas:generate` whenever web/src/lib/schemas.ts changes.
 */

import { registerSchema } from "./drift/middleware.js";
import type { JsonSchemaObject } from "./drift/types.js";

// ── Import generated schemas ──────────────────────────────────────────────────
// These JSON files are produced by web/scripts/generate-schemas.ts.

import createTalos from "../generated/schemas/createTalos.json" with { type: "json" };
import reportActivity from "../generated/schemas/reportActivity.json" with { type: "json" };
import createApproval from "../generated/schemas/createApproval.json" with { type: "json" };
import decideApproval from "../generated/schemas/decideApproval.json" with { type: "json" };
import transfer from "../generated/schemas/transfer.json" with { type: "json" };
import becomePatron from "../generated/schemas/becomePatron.json" with { type: "json" };
import revokePatron from "../generated/schemas/revokePatron.json" with { type: "json" };
import registerService from "../generated/schemas/registerService.json" with { type: "json" };
import crossChainWebhook from "../generated/schemas/crossChainWebhook.json" with { type: "json" };
import submitBid from "../generated/schemas/submitBid.json" with { type: "json" };
import claimJob from "../generated/schemas/claimJob.json" with { type: "json" };
import heartbeatJob from "../generated/schemas/heartbeatJob.json" with { type: "json" };
import releaseJob from "../generated/schemas/releaseJob.json" with { type: "json" };
import submitJobResult from "../generated/schemas/submitJobResult.json" with { type: "json" };
import reportRevenue from "../generated/schemas/reportRevenue.json" with { type: "json" };
import recordDividend from "../generated/schemas/recordDividend.json" with { type: "json" };
import updateStatus from "../generated/schemas/updateStatus.json" with { type: "json" };
import regenerateKey from "../generated/schemas/regenerateKey.json" with { type: "json" };
import signPayment from "../generated/schemas/signPayment.json" with { type: "json" };
import buyToken from "../generated/schemas/buyToken.json" with { type: "json" };
import createPlaybook from "../generated/schemas/createPlaybook.json" with { type: "json" };

// ── Registration ──────────────────────────────────────────────────────────────

const registrations: Array<{ route: string; schema: unknown }> = [
  { route: "POST /api/talos",                                        schema: createTalos },
  { route: "POST /api/talos/:id/activity",                           schema: reportActivity },
  { route: "POST /api/talos/:id/approvals",                          schema: createApproval },
  { route: "POST /api/talos/:id/approvals/:approvalId/decide",       schema: decideApproval },
  { route: "POST /api/talos/:id/transfer",                           schema: transfer },
  { route: "POST /api/talos/:id/patron",                             schema: becomePatron },
  { route: "DELETE /api/talos/:id/patron",                           schema: revokePatron },
  { route: "PUT /api/talos/:id/service",                             schema: registerService },
  { route: "POST /api/talos/:id/cross-chain-webhook",                schema: crossChainWebhook },
  { route: "POST /api/jobs/:id/bid",                                 schema: submitBid },
  { route: "POST /api/jobs/:id/claim",                               schema: claimJob },
  { route: "POST /api/jobs/:id/heartbeat",                           schema: heartbeatJob },
  { route: "POST /api/jobs/:id/release",                             schema: releaseJob },
  { route: "POST /api/jobs/:id/result",                              schema: submitJobResult },
  { route: "POST /api/talos/:id/revenue",                            schema: reportRevenue },
  { route: "POST /api/talos/:id/dividends",                          schema: recordDividend },
  { route: "PATCH /api/talos/:id/status",                            schema: updateStatus },
  { route: "POST /api/talos/:id/regenerate-key",                     schema: regenerateKey },
  { route: "POST /api/talos/:id/sign",                               schema: signPayment },
  { route: "POST /api/talos/:id/buy-token",                          schema: buyToken },
  { route: "POST /api/playbooks",                                    schema: createPlaybook },
];

// Register all schemas once (idempotent)
let _bootstrapped = false;

export function bootstrapDriftSchemas(): void {
  if (_bootstrapped) return;
  for (const { route, schema } of registrations) {
    registerSchema(route, schema as JsonSchemaObject);
  }
  _bootstrapped = true;
}

/** Force re-registration (for tests that call resetDriftConfig). */
export function resetBootstrap(): void {
  _bootstrapped = false;
}

// Auto-bootstrap on import
bootstrapDriftSchemas();
