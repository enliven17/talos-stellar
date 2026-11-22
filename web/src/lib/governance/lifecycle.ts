/**
 * Agent governance lifecycle — state machine, roles, and stable error codes.
 *
 * This module is the single source of truth for which lifecycle states exist,
 * which transitions are legal, and who is allowed to request them. It performs
 * no I/O so it can be imported from route handlers, the provisioning worker,
 * and tests without a database.
 *
 * Legacy compatibility: `tls_talos.status` predates this machine and only ever
 * held "Active" | "Paused" | "Retired" (plus the explicit "Draining" marketplace state). `toLifecycleState` / `toLegacyStatus`
 * map between the two so existing rows and API consumers keep working while the
 * richer state is tracked in the lifecycle event log.
 */

// ── States ───────────────────────────────────────────────────────────

export const AGENT_LIFECYCLE_STATES = [
  "proposed",
  "provisioning",
  "active",
  "paused",
  "retiring",
  "retired",
  "recovery_pending",
  "failed",
] as const;

export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

/** States from which no further transition is possible. */
export const TERMINAL_STATES: ReadonlySet<AgentLifecycleState> = new Set(["retired"]);

/** States that represent in-flight, server-owned work rather than a settled outcome. */
export const TRANSIENT_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  "provisioning",
  "retiring",
]);

/** States in which the agent may accept new work. */
export const OPERATIONAL_STATES: ReadonlySet<AgentLifecycleState> = new Set(["active"]);

export function isLifecycleState(value: unknown): value is AgentLifecycleState {
  return typeof value === "string" && (AGENT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

// ── Actors ───────────────────────────────────────────────────────────

export const GOVERNANCE_ROLES = ["creator", "operator", "governance", "system"] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export interface LifecycleActor {
  /** Stellar G-address of the requester, or "system" for worker-driven transitions. */
  id: string;
  roles: readonly GovernanceRole[];
}

// ── Actions ──────────────────────────────────────────────────────────

export const LIFECYCLE_ACTIONS = ["create", "activate", "pause", "retire", "recover"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export function isLifecycleAction(value: unknown): value is LifecycleAction {
  return typeof value === "string" && (LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

export interface TransitionRule {
  action: LifecycleAction;
  /** `null` means "no prior state" — only valid for `create`. */
  from: readonly (AgentLifecycleState | null)[];
  to: AgentLifecycleState;
  /** Actor needs at least one of these roles. */
  roles: readonly GovernanceRole[];
  /** Transition is refused unless an approved governance record is supplied. */
  requiresGovernanceApproval: boolean;
  /** Transition hands off to the durable provisioning worker instead of settling inline. */
  durable: boolean;
}

/**
 * The complete transition table. Order matters only for readability — lookup is
 * keyed by (action, fromState) and every pair resolves to at most one rule.
 */
export const TRANSITION_RULES: readonly TransitionRule[] = [
  {
    action: "create",
    from: [null],
    to: "proposed",
    roles: ["creator", "operator", "governance"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "activate",
    from: ["proposed"],
    to: "provisioning",
    roles: ["governance", "operator"],
    requiresGovernanceApproval: true,
    durable: true,
  },
  {
    // Emitted by the provisioning worker once every step has committed.
    action: "activate",
    from: ["provisioning"],
    to: "active",
    roles: ["system"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "activate",
    from: ["paused"],
    to: "active",
    roles: ["operator", "governance"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "pause",
    from: ["active"],
    to: "paused",
    roles: ["operator", "governance", "system"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "retire",
    from: ["active", "paused"],
    to: "retiring",
    roles: ["governance"],
    requiresGovernanceApproval: true,
    durable: true,
  },
  {
    // Emitted by the worker after outstanding jobs have drained.
    action: "retire",
    from: ["retiring"],
    to: "retired",
    roles: ["system"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "recover",
    from: ["failed"],
    to: "recovery_pending",
    roles: ["operator", "governance"],
    requiresGovernanceApproval: false,
    durable: false,
  },
  {
    action: "recover",
    from: ["recovery_pending"],
    to: "provisioning",
    roles: ["governance", "operator"],
    requiresGovernanceApproval: true,
    durable: true,
  },
];

/**
 * System-only failure edges. The worker moves an agent here when a durable job
 * exhausts its retries and its compensations have settled.
 */
export const FAILURE_TRANSITIONS: ReadonlyMap<AgentLifecycleState, AgentLifecycleState> = new Map([
  ["provisioning", "failed"],
  ["retiring", "failed"],
  ["recovery_pending", "failed"],
]);

export function findRule(
  action: LifecycleAction,
  from: AgentLifecycleState | null,
): TransitionRule | null {
  return TRANSITION_RULES.find((r) => r.action === action && r.from.includes(from)) ?? null;
}

/** Actions this actor could legally request from the given state, for UI affordances. */
export function allowedActions(
  from: AgentLifecycleState,
  actor: LifecycleActor,
): LifecycleAction[] {
  return TRANSITION_RULES.filter(
    (r) =>
      r.from.includes(from) &&
      r.roles.some((role) => actor.roles.includes(role)) &&
      // System edges are never operator-requestable, even for a system actor
      // arriving over HTTP — the worker calls the runner directly.
      !(r.roles.length === 1 && r.roles[0] === "system"),
  ).map((r) => r.action);
}

// ── Errors ───────────────────────────────────────────────────────────

/**
 * Stable, machine-readable error codes. These are part of the API contract —
 * clients branch on them, so values must never be repurposed.
 */
export const LIFECYCLE_ERROR_CODES = [
  "LIFECYCLE_UNKNOWN_ACTION",
  "LIFECYCLE_UNKNOWN_STATE",
  "LIFECYCLE_INVALID_TRANSITION",
  "LIFECYCLE_TERMINAL_STATE",
  "LIFECYCLE_UNAUTHORIZED",
  "LIFECYCLE_APPROVAL_REQUIRED",
  "LIFECYCLE_PREREQUISITE_FAILED",
  "LIFECYCLE_INVALID_PAYLOAD",
  "LIFECYCLE_CONFLICT",
] as const;

export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number];

const ERROR_STATUS: Record<LifecycleErrorCode, number> = {
  LIFECYCLE_UNKNOWN_ACTION: 400,
  LIFECYCLE_UNKNOWN_STATE: 400,
  LIFECYCLE_INVALID_TRANSITION: 409,
  LIFECYCLE_TERMINAL_STATE: 409,
  LIFECYCLE_UNAUTHORIZED: 403,
  LIFECYCLE_APPROVAL_REQUIRED: 403,
  LIFECYCLE_PREREQUISITE_FAILED: 422,
  LIFECYCLE_INVALID_PAYLOAD: 400,
  LIFECYCLE_CONFLICT: 409,
};

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly status: number;
  /** Safe-to-expose context. Never place secrets or raw payloads here. */
  readonly details: Record<string, unknown>;

  constructor(code: LifecycleErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toResponseBody(): { error: string; code: LifecycleErrorCode; details: Record<string, unknown> } {
    return { error: this.message, code: this.code, details: this.details };
  }
}

// ── Transition evaluation ────────────────────────────────────────────

export interface TransitionRequest {
  action: LifecycleAction;
  from: AgentLifecycleState | null;
  actor: LifecycleActor;
  /** Set when an approved governance record backs this request. */
  governanceApproved?: boolean;
}

export interface TransitionDecision {
  action: LifecycleAction;
  from: AgentLifecycleState | null;
  to: AgentLifecycleState;
  durable: boolean;
  actor: LifecycleActor;
}

/**
 * Validate a requested transition. Throws {@link LifecycleError} with a stable
 * code on rejection; returns the resolved target state on success.
 *
 * Checks run in a fixed order so a caller probing the API cannot use the error
 * code to distinguish "state I am not allowed to see" from "state that does not
 * permit this": ordering is validity first, then authorization.
 */
export function evaluateTransition(request: TransitionRequest): TransitionDecision {
  const { action, from, actor } = request;

  if (!isLifecycleAction(action)) {
    throw new LifecycleError("LIFECYCLE_UNKNOWN_ACTION", `Unknown lifecycle action: ${action}`, {
      allowed: [...LIFECYCLE_ACTIONS],
    });
  }

  if (from !== null && !isLifecycleState(from)) {
    throw new LifecycleError("LIFECYCLE_UNKNOWN_STATE", `Unknown lifecycle state: ${from}`, {
      allowed: [...AGENT_LIFECYCLE_STATES],
    });
  }

  if (from !== null && TERMINAL_STATES.has(from)) {
    throw new LifecycleError(
      "LIFECYCLE_TERMINAL_STATE",
      `Agent is ${from}; no further lifecycle transitions are possible`,
      { from },
    );
  }

  const rule = findRule(action, from);
  if (!rule) {
    throw new LifecycleError(
      "LIFECYCLE_INVALID_TRANSITION",
      `Cannot ${action} an agent in state ${from ?? "none"}`,
      {
        from,
        action,
        validFrom: TRANSITION_RULES.filter((r) => r.action === action).flatMap((r) => r.from),
      },
    );
  }

  if (!rule.roles.some((role) => actor.roles.includes(role))) {
    throw new LifecycleError(
      "LIFECYCLE_UNAUTHORIZED",
      `Action ${action} requires one of: ${rule.roles.join(", ")}`,
      { action, requiredRoles: [...rule.roles] },
    );
  }

  if (rule.requiresGovernanceApproval && request.governanceApproved !== true) {
    throw new LifecycleError(
      "LIFECYCLE_APPROVAL_REQUIRED",
      `Action ${action} requires an approved governance proposal`,
      { action, from },
    );
  }

  return { action, from, to: rule.to, durable: rule.durable, actor };
}

/** Resolve the failure edge for a state, or throw if the state cannot fail. */
export function failureStateFor(from: AgentLifecycleState): AgentLifecycleState {
  const to = FAILURE_TRANSITIONS.get(from);
  if (!to) {
    throw new LifecycleError(
      "LIFECYCLE_INVALID_TRANSITION",
      `State ${from} has no failure transition`,
      { from },
    );
  }
  return to;
}

// ── Legacy status bridge ─────────────────────────────────────────────

const LEGACY_TO_LIFECYCLE: Record<string, AgentLifecycleState> = {
  active: "active",
  paused: "paused",
  retired: "retired",
  proposed: "proposed",
  provisioning: "provisioning",
  retiring: "retiring",
  draining: "retiring",
  recovery_pending: "recovery_pending",
  failed: "failed",
};

/**
 * Map a persisted `tls_talos.status` value onto a lifecycle state.
 * Unrecognised legacy values fall back to "active" — the pre-existing default —
 * so rows written before this machine landed continue to serve traffic.
 */
export function toLifecycleState(dbStatus: string | null | undefined): AgentLifecycleState {
  if (!dbStatus) return "active";
  return LEGACY_TO_LIFECYCLE[dbStatus.trim().toLowerCase()] ?? "active";
}

/**
 * Map a lifecycle state back onto the legacy `status` column. Transient and
 * failure states collapse onto "Paused" so that every existing consumer that
 * only understands Active/Paused/Retired treats them as "not accepting work",
 * which is the safe reading.
 */
export function toLegacyStatus(state: AgentLifecycleState): "Active" | "Paused" | "Retired" {
  if (state === "active") return "Active";
  if (state === "retired") return "Retired";
  return "Paused";
}

export function acceptsNewWork(state: AgentLifecycleState): boolean {
  return OPERATIONAL_STATES.has(state);
}

// ── Lifecycle Checklist ──────────────────────────────────────────────

export type ObligationId =
  | "owner_authorization"
  | "in_flight_jobs"
  | "service_availability"
  | "governance_approval"
  | "wallet_bound";

export interface LifecycleObligation {
  id: ObligationId;
  title: string;
  description: string;
  satisfied: boolean;
  blocking: boolean;
  count?: number;
  requiredFor: LifecycleAction[];
}

export interface LifecycleNextAction {
  action: LifecycleAction;
  label: string;
  description: string;
  enabled: boolean;
  blockingObligationIds: ObligationId[];
}

export interface LifecycleChecklistContext {
  talosId: string;
  state: AgentLifecycleState;
  actor: LifecycleActor;
  agentOnline: boolean;
  inFlightJobs: number;
  pendingProposalsCount: number;
  hasWallet: boolean;
  hasApprovedProposal?: boolean;
  retiredAt?: Date | string | null;
}

export interface LifecycleChecklist {
  talosId: string;
  state: AgentLifecycleState;
  legacyStatus: "Active" | "Paused" | "Retired";
  isOwner: boolean;
  canRetire: boolean;
  obligations: LifecycleObligation[];
  allowedNextActions: LifecycleNextAction[];
  observedAt: string;
}

/**
 * Evaluate the owner-facing lifecycle checklist for an agent.
 *
 * Checks all blocking obligations (in-flight commerce jobs, service intake availability,
 * governance proposals, owner authorization) and returns the allowed next actions.
 * Preserves private financial details by returning only high-level status, counts,
 * and public addresses.
 */
export function evaluateLifecycleChecklist(ctx: LifecycleChecklistContext): LifecycleChecklist {
  if (!isLifecycleState(ctx.state)) {
    throw new LifecycleError("LIFECYCLE_UNKNOWN_STATE", `Unknown lifecycle state: ${ctx.state}`, {
      allowed: [...AGENT_LIFECYCLE_STATES],
    });
  }

  const isOwner = ctx.actor.roles.includes("creator") || ctx.actor.roles.includes("operator");
  const isRetired = ctx.state === "retired" || Boolean(ctx.retiredAt);

  const obligations: LifecycleObligation[] = [];

  // 1. Owner authorization
  obligations.push({
    id: "owner_authorization",
    title: "Owner Authorization",
    description: isOwner
      ? "Connected wallet is verified as agent owner/operator"
      : "Connected wallet holds no owner role on this agent",
    satisfied: isOwner,
    blocking: !isOwner,
    requiredFor: ["activate", "pause", "retire", "recover"],
  });

  // 2. In-flight jobs
  const inFlightCount = Math.max(0, ctx.inFlightJobs);
  const jobsSettled = isRetired || inFlightCount === 0;
  obligations.push({
    id: "in_flight_jobs",
    title: "In-Flight Commerce Jobs",
    description: isRetired
      ? "Historical commerce jobs are settled"
      : inFlightCount === 0
        ? "No commerce jobs in flight"
        : `${inFlightCount} in-flight job(s) must drain before retirement`,
    satisfied: jobsSettled,
    blocking: !jobsSettled,
    count: inFlightCount,
    requiredFor: ["retire"],
  });

  // 3. Service availability (intake paused)
  const intakePaused = isRetired || !ctx.agentOnline || ctx.state === "paused";
  obligations.push({
    id: "service_availability",
    title: "Service Intake Paused",
    description: isRetired
      ? "Agent services are permanently retired"
      : intakePaused
        ? "Service intake is paused and agent is offline"
        : "Agent is online and accepting new requests (pause required before retirement)",
    satisfied: intakePaused,
    blocking: ctx.state === "active" && ctx.agentOnline,
    requiredFor: ["retire"],
  });

  // 4. Governance proposals
  const pendingCount = Math.max(0, ctx.pendingProposalsCount);
  const govSatisfied = isRetired ? true : pendingCount === 0 || Boolean(ctx.hasApprovedProposal);
  obligations.push({
    id: "governance_approval",
    title: "Governance Approvals",
    description: isRetired
      ? "All governance proposals concluded"
      : ctx.state === "proposed"
        ? (ctx.hasApprovedProposal ? "Governance proposal approved" : "Awaiting governance proposal approval")
        : pendingCount === 0
          ? "No unresolved governance proposals"
          : `${pendingCount} pending proposal(s) awaiting resolution`,
    satisfied: govSatisfied,
    blocking: ctx.state === "proposed" && !ctx.hasApprovedProposal,
    count: pendingCount,
    requiredFor: ["activate", "retire"],
  });

  // 5. Wallet binding
  obligations.push({
    id: "wallet_bound",
    title: "Agent Wallet Bound",
    description: ctx.hasWallet
      ? "Agent wallet is provisioned and bound"
      : "No agent wallet assigned",
    satisfied: ctx.hasWallet,
    blocking: !ctx.hasWallet && ctx.state === "proposed",
    requiredFor: ["activate"],
  });

  // Determine canRetire
  const canRetire =
    !isRetired &&
    isOwner &&
    (ctx.state === "active" || ctx.state === "paused") &&
    inFlightCount === 0 &&
    intakePaused;

  // Determine allowedNextActions
  const allowedNextActions: LifecycleNextAction[] = [];

  if (!isRetired) {
    if (ctx.state === "active") {
      const pauseBlockedBy: ObligationId[] = [];
      if (!isOwner) pauseBlockedBy.push("owner_authorization");

      allowedNextActions.push({
        action: "pause",
        label: "Pause Agent",
        description: "Halt new request intake so in-flight work can drain",
        enabled: isOwner,
        blockingObligationIds: pauseBlockedBy,
      });

      const retireBlockedBy: ObligationId[] = [];
      if (!isOwner) retireBlockedBy.push("owner_authorization");
      if (inFlightCount > 0) retireBlockedBy.push("in_flight_jobs");
      if (ctx.agentOnline) retireBlockedBy.push("service_availability");

      allowedNextActions.push({
        action: "retire",
        label: "Retire Agent",
        description: "Permanently retire this agent and preserve historical records",
        enabled: canRetire,
        blockingObligationIds: retireBlockedBy,
      });
    } else if (ctx.state === "paused") {
      const activateBlockedBy: ObligationId[] = [];
      if (!isOwner) activateBlockedBy.push("owner_authorization");

      allowedNextActions.push({
        action: "activate",
        label: "Resume Agent",
        description: "Unpause agent and resume accepting customer requests",
        enabled: isOwner,
        blockingObligationIds: activateBlockedBy,
      });

      const retireBlockedBy: ObligationId[] = [];
      if (!isOwner) retireBlockedBy.push("owner_authorization");
      if (inFlightCount > 0) retireBlockedBy.push("in_flight_jobs");

      allowedNextActions.push({
        action: "retire",
        label: "Retire Agent",
        description: "Permanently retire this agent and preserve historical records",
        enabled: canRetire,
        blockingObligationIds: retireBlockedBy,
      });
    } else if (ctx.state === "proposed") {
      const activateBlockedBy: ObligationId[] = [];
      if (!isOwner) activateBlockedBy.push("owner_authorization");
      if (!ctx.hasApprovedProposal) activateBlockedBy.push("governance_approval");
      if (!ctx.hasWallet) activateBlockedBy.push("wallet_bound");

      allowedNextActions.push({
        action: "activate",
        label: "Activate Agent",
        description: "Provision agent wallet and services once proposal is approved",
        enabled: isOwner && Boolean(ctx.hasApprovedProposal) && ctx.hasWallet,
        blockingObligationIds: activateBlockedBy,
      });
    } else if (ctx.state === "failed") {
      const recoverBlockedBy: ObligationId[] = [];
      if (!isOwner) recoverBlockedBy.push("owner_authorization");

      allowedNextActions.push({
        action: "recover",
        label: "Recover Agent",
        description: "Initiate recovery workflow after failed provisioning",
        enabled: isOwner,
        blockingObligationIds: recoverBlockedBy,
      });
    }
  }

  return {
    talosId: ctx.talosId,
    state: ctx.state,
    legacyStatus: toLegacyStatus(ctx.state),
    isOwner,
    canRetire,
    obligations,
    allowedNextActions,
    observedAt: new Date().toISOString(),
  };
}
