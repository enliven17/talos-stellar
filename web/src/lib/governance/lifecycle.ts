/**
 * Agent governance lifecycle — state machine, roles, and stable error codes.
 *
 * This module is the single source of truth for which lifecycle states exist,
 * which transitions are legal, and who is allowed to request them. It performs
 * no I/O so it can be imported from route handlers, the provisioning worker,
 * and tests without a database.
 *
 * Legacy compatibility: `tls_talos.status` predates this machine and only ever
 * held "Active" | "Paused" | "Retired". `toLifecycleState` / `toLegacyStatus`
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
