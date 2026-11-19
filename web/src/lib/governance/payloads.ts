/**
 * Typed governance action payloads.
 *
 * Every lifecycle action carries a discriminated payload validated here before
 * it reaches the state machine or the durable worker. Bounds are explicit on
 * every field: unbounded strings, arrays, and numbers are the usual way a
 * governance endpoint turns into a storage or CPU amplification vector.
 */
import { z } from "zod/v4";

import { LIFECYCLE_ACTIONS, LifecycleError, type LifecycleAction } from "./lifecycle";

const STELLAR_ADDRESS = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "must be a canonical Stellar G-address");

/** Idempotency keys are client-supplied; keep them opaque, bounded, and printable. */
const IDEMPOTENCY_KEY = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "idempotencyKey must be URL-safe");

const REASON = z.string().min(1).max(500);

/**
 * Capability grants an agent may hold. These are governance-level grants; the
 * per-tool manifests enforced inside the agent runtime are a separate, finer
 * layer and must be a subset of what is granted here.
 */
export const AGENT_PERMISSIONS = [
  "wallet.read",
  "wallet.transfer",
  "wallet.token_issue",
  "network.http",
  "network.browser",
  "commerce.sell",
  "commerce.buy",
  "publishing.post",
  "data.read_private",
] as const;

export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/** Permissions that can never be granted without an explicit governance vote. */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<string> = new Set([
  "wallet.transfer",
  "wallet.token_issue",
  "data.read_private",
]);

const budgetsSchema = z
  .object({
    // Auto-approval ceiling, in USDC. Above this the agent must escalate.
    approvalThreshold: z.number().nonnegative().max(1_000_000),
    // Total go-to-market allowance, in USDC.
    gtmBudget: z.number().nonnegative().max(10_000_000),
    // Hard monthly spend cap. Must dominate the auto-approval ceiling.
    monthlyCapUsd: z.number().positive().max(10_000_000),
  })
  .strict()
  .refine((b) => b.approvalThreshold <= b.monthlyCapUsd, {
    message: "approvalThreshold must not exceed monthlyCapUsd",
    path: ["approvalThreshold"],
  })
  .refine((b) => b.gtmBudget <= b.monthlyCapUsd * 12, {
    message: "gtmBudget must not exceed twelve months of monthlyCapUsd",
    path: ["gtmBudget"],
  });

const serviceSchema = z
  .object({
    serviceName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    price: z.number().positive().max(1_000_000),
    fulfillmentMode: z.enum(["instant", "async"]).default("async"),
  })
  .strict();

// ── create ───────────────────────────────────────────────────────────

export const createAgentPayloadSchema = z
  .object({
    name: z.string().min(1).max(100),
    category: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    // A persona is what the runtime prompts against — an empty one produces an
    // ungoverned agent, so it is required at proposal time rather than later.
    persona: z.string().min(20).max(4000),
    targetAudience: z.string().max(2000).optional(),
    permissions: z.array(z.enum(AGENT_PERMISSIONS)).min(1).max(AGENT_PERMISSIONS.length),
    operator: STELLAR_ADDRESS,
    budgets: budgetsSchema,
    services: z.array(serviceSchema).max(10).default([]),
    idempotencyKey: IDEMPOTENCY_KEY.optional(),
  })
  .strict();

// ── activate ─────────────────────────────────────────────────────────

export const activateAgentPayloadSchema = z
  .object({
    proposalId: z.string().min(1).max(64),
    // Explicit operator acknowledgement — the UI collects this from a
    // confirmation dialog and it is never defaulted server-side.
    confirmed: z.literal(true),
    idempotencyKey: IDEMPOTENCY_KEY.optional(),
  })
  .strict();

// ── pause ────────────────────────────────────────────────────────────

export const pauseAgentPayloadSchema = z
  .object({
    reason: REASON,
    /** Cancel queued-but-unstarted jobs. In-flight leases always drain. */
    cancelPendingJobs: z.boolean().default(true),
    idempotencyKey: IDEMPOTENCY_KEY.optional(),
  })
  .strict();

// ── retire ───────────────────────────────────────────────────────────

export const retireAgentPayloadSchema = z
  .object({
    reason: REASON,
    proposalId: z.string().min(1).max(64),
    confirmed: z.literal(true),
    /** Wait for in-flight jobs instead of cancelling them. */
    drainJobs: z.boolean().default(true),
    /** Where residual treasury balance is swept on retirement. */
    residualBeneficiary: STELLAR_ADDRESS.optional(),
    idempotencyKey: IDEMPOTENCY_KEY.optional(),
  })
  .strict();

// ── recover ──────────────────────────────────────────────────────────

export const recoverAgentPayloadSchema = z
  .object({
    reason: REASON,
    /** Provisioning job to resume. Omit to start a fresh provisioning run. */
    jobId: z.string().min(1).max(64).optional(),
    /**
     * Discard partially-applied state before retrying. Defaults to false so
     * recovery is resumable-by-default and destructive only on request.
     */
    forceCompensate: z.boolean().default(false),
    confirmed: z.literal(true),
    idempotencyKey: IDEMPOTENCY_KEY.optional(),
  })
  .strict();

// ── Dispatch ─────────────────────────────────────────────────────────

export const LIFECYCLE_PAYLOAD_SCHEMAS = {
  create: createAgentPayloadSchema,
  activate: activateAgentPayloadSchema,
  pause: pauseAgentPayloadSchema,
  retire: retireAgentPayloadSchema,
  recover: recoverAgentPayloadSchema,
} as const satisfies Record<LifecycleAction, z.ZodType>;

export type CreateAgentPayload = z.infer<typeof createAgentPayloadSchema>;
export type ActivateAgentPayload = z.infer<typeof activateAgentPayloadSchema>;
export type PauseAgentPayload = z.infer<typeof pauseAgentPayloadSchema>;
export type RetireAgentPayload = z.infer<typeof retireAgentPayloadSchema>;
export type RecoverAgentPayload = z.infer<typeof recoverAgentPayloadSchema>;

export type LifecyclePayload =
  | { action: "create"; payload: CreateAgentPayload }
  | { action: "activate"; payload: ActivateAgentPayload }
  | { action: "pause"; payload: PauseAgentPayload }
  | { action: "retire"; payload: RetireAgentPayload }
  | { action: "recover"; payload: RecoverAgentPayload };

/**
 * Validate `{ action, payload }` from an untrusted request body.
 * Throws {@link LifecycleError} with `LIFECYCLE_INVALID_PAYLOAD` on failure —
 * issue paths are echoed back, issue *values* never are.
 */
export function parseLifecyclePayload(raw: unknown): LifecyclePayload {
  if (typeof raw !== "object" || raw === null) {
    throw new LifecycleError("LIFECYCLE_INVALID_PAYLOAD", "Request body must be an object");
  }

  const action = (raw as { action?: unknown }).action;
  if (typeof action !== "string" || !(action in LIFECYCLE_PAYLOAD_SCHEMAS)) {
    throw new LifecycleError("LIFECYCLE_UNKNOWN_ACTION", `Unknown lifecycle action`, {
      allowed: [...LIFECYCLE_ACTIONS],
    });
  }

  const schema = LIFECYCLE_PAYLOAD_SCHEMAS[action as LifecycleAction];
  const result = schema.safeParse((raw as { payload?: unknown }).payload ?? {});

  if (!result.success) {
    throw new LifecycleError("LIFECYCLE_INVALID_PAYLOAD", "Payload validation failed", {
      action,
      issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }

  return { action, payload: result.data } as LifecyclePayload;
}

// ── Prerequisites ────────────────────────────────────────────────────

export interface PrerequisiteContext {
  /** Operator address recorded on the agent, if it has been provisioned. */
  operator: string | null;
  /** Permissions granted by the approved proposal. */
  grantedPermissions: readonly string[];
  /** Whether the agent already holds a funded wallet. */
  hasWallet: boolean;
  /** Number of registered commerce services. */
  serviceCount: number;
  /** Jobs still in flight — retirement must not strand paid work. */
  inFlightJobs: number;
}

/**
 * Cross-field checks that need database state and therefore cannot live in the
 * Zod schemas. Throws `LIFECYCLE_PREREQUISITE_FAILED` on the first violation.
 */
export function assertPrerequisites(parsed: LifecyclePayload, ctx: PrerequisiteContext): void {
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw new LifecycleError("LIFECYCLE_PREREQUISITE_FAILED", message, {
      action: parsed.action,
      ...details,
    });
  };

  switch (parsed.action) {
    case "create": {
      const privileged = parsed.payload.permissions.filter((p) => PRIVILEGED_PERMISSIONS.has(p));
      if (privileged.length > 0 && parsed.payload.budgets.monthlyCapUsd <= 0) {
        fail("Privileged permissions require a positive monthly spend cap", { privileged });
      }
      if (
        parsed.payload.services.length > 0 &&
        !parsed.payload.permissions.includes("commerce.sell")
      ) {
        fail("Services were declared without the commerce.sell permission");
      }
      break;
    }

    case "activate": {
      if (!ctx.operator) fail("Agent has no operator of record");
      if (ctx.grantedPermissions.length === 0) fail("Approved proposal granted no permissions");
      break;
    }

    case "pause":
      break;

    case "retire": {
      if (parsed.payload.drainJobs && ctx.inFlightJobs > 0) {
        fail("Agent still has in-flight jobs; drain them or retire with drainJobs=false", {
          inFlightJobs: ctx.inFlightJobs,
        });
      }
      if (parsed.payload.residualBeneficiary && !ctx.hasWallet) {
        fail("Cannot sweep residual balance: agent has no wallet");
      }
      break;
    }

    case "recover": {
      if (parsed.payload.forceCompensate && !parsed.payload.jobId) {
        fail("forceCompensate requires the jobId of the run to unwind");
      }
      break;
    }
  }
}
