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
  allowed: boolean;
  rule: TransitionRule | null;
  error: LifecycleError | null;
}

/**
 * Pure evaluation of a requested transition. Never mutates state — callers are
 * responsible for persisting the outcome once `allowed` is true.
 */
export function evaluateTransition(request: TransitionRequest): TransitionDecision {
  const { action, from, actor, governanceApproved = false } = request;

  if (!isLifecycleAction(action)) {
    return {
      allowed: false,
      rule: null,
      error: new LifecycleError("LIFECYCLE_UNKNOWN_ACTION", `Unknown lifecycle action: ${String(action)}`, {
        action,
      }),
    };
  }

  if (from !== null && !isLifecycleState(from)) {
    return {
      allowed: false,
      rule: null,
      error: new LifecycleError("LIFECYCLE_UNKNOWN_STATE", `Unknown lifecycle state: ${String(from)}`, {
        from,
      }),
    };
  }

  if (from !== null && TERMINAL_STATES.has(from)) {
    return {
      allowed: false,
      rule: null,
      error: new LifecycleError(
        "LIFECYCLE_TERMINAL_STATE",
        `Agent is in terminal state "${from}" and cannot transition`,
        { from, action },
      ),
    };
  }

  const rule = findRule(action, from);
  if (!rule) {
    return {
      allowed: false,
      rule: null,
      error: new LifecycleError(
        "LIFECYCLE_INVALID_TRANSITION",
        `Cannot ${action} from state ${from === null ? "<none>" : `"${from}"`}`,
        { from, action },
      ),
    };
  }

  if (!rule.roles.some((role) => actor.roles.includes(role))) {
    return {
      allowed: false,
      rule,
      error: new LifecycleError(
        "LIFECYCLE_UNAUTHORIZED",
        `Actor is not permitted to ${action}`,
        { action, requiredRoles: rule.roles },
      ),
    };
  }

  if (rule.requiresGovernanceApproval && !governanceApproved) {
    return {
      allowed: false,
      rule,
      error: new LifecycleError(
        "LIFECYCLE_APPROVAL_REQUIRED",
        `Action "${action}" requires an approved governance record`,
        { action },
      ),
    };
  }

  return { allowed: true, rule, error: null };
}

// ── Legacy status mapping ────────────────────────────────────────────

export type LegacyTalosStatus = "Active" | "Paused" | "Retired";

/** Map a legacy `tls_talos.status` value onto the richer lifecycle state. */
export function toLifecycleState(status: LegacyTalosStatus): AgentLifecycleState {
  switch (status) {
    case "Active":
      return "active";
    case "Paused":
      return "paused";
    case "Retired":
      return "retired";
  }
}

/** Map a lifecycle state back onto the legacy status column. */
export function toLegacyStatus(state: AgentLifecycleState): LegacyTalosStatus {
  switch (state) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "retired":
      return "Retired";
    // In-flight and failure states have no legacy equivalent; they surface as
    // Paused so existing consumers never observe an unknown status value.
    case "proposed":
    case "provisioning":
    case "retiring":
    case "recovery_pending":
    case "failed":
      return "Paused";
  }
}

// ── Offline consistency report ───────────────────────────────────────

/**
 * A single lifecycle record as observed from the event log / talos row.
 * `state` is the latest known lifecycle state for the agent.
 */
export interface LifecycleRecord {
  agentId: string;
  state: AgentLifecycleState;
}

/** A service currently bound to an agent. */
export interface ActiveService {
  agentId: string;
  serviceId: string;
}

/** A job that has not yet reached a terminal outcome. */
export interface UnresolvedJob {
  agentId: string;
  jobId: string;
}

/**
 * Stable, machine-readable contradiction codes emitted by the consistency
 * report. These are part of the report contract — clients branch on them, so
 * values must never be repurposed.
 */
export const LIFECYCLE_CONTRADICTION_CODES = [
  "RETIRED_AGENT_WITH_ACTIVE_SERVICE",
  "ACTIVE_SERVICE_WITHOUT_LIFECYCLE_RECORD",
  "UNRESOLVED_JOB_ON_RETIRED_AGENT",
  "UNRESOLVED_JOB_WITHOUT_LIFECYCLE_RECORD",
  "DUPLICATE_LIFECYCLE_RECORD",
] as const;

export type LifecycleContradictionCode = (typeof LIFECYCLE_CONTRADICTION_CODES)[number];

export interface LifecycleContradiction {
  code: LifecycleContradictionCode;
  agentId: string;
  /** Human-readable explanation, safe to surface in a report. */
  message: string;
  /** Optional identifiers (serviceId / jobId) that triggered the contradiction. */
  refs: Record<string, string>;
}

export interface LifecycleConsistencyInput {
  lifecycleRecords: readonly LifecycleRecord[];
  activeServices: readonly ActiveService[];
  unresolvedJobs: readonly UnresolvedJob[];
}

export interface LifecycleConsistencyReport {
  /** True when no contradictions were found. */
  consistent: boolean;
  contradictions: LifecycleContradiction[];
  /** Per-agent summary of the observed state, for operator review. */
  agents: Array<{
    agentId: string;
    state: AgentLifecycleState | null;
    activeServiceIds: string[];
    unresolvedJobIds: string[];
  }>;
}

/**
 * Build an offline, read-only consistency report comparing lifecycle records,
 * active services and unresolved jobs.
 *
 * This function performs no I/O and never mutates funded state — it only reads
 * the supplied snapshots and returns contradictions for operator review.
 */
export function buildLifecycleConsistencyReport(
  input: LifecycleConsistencyInput,
): LifecycleConsistencyReport {
  const contradictions: LifecycleContradiction[] = [];

  // Index lifecycle records by agent, flagging duplicates.
  const stateByAgent = new Map<string, AgentLifecycleState>();
  const duplicateAgents = new Set<string>();
  for (const record of input.lifecycleRecords) {
    if (stateByAgent.has(record.agentId)) {
      duplicateAgents.add(record.agentId);
    } else {
      stateByAgent.set(record.agentId, record.state);
    }
  }

  for (const agentId of duplicateAgents) {
    contradictions.push({
      code: "DUPLICATE_LIFECYCLE_RECORD",
      agentId,
      message: `Agent ${agentId} has more than one lifecycle record`,
      refs: {},
    });
  }

  // Group services and jobs by agent for the per-agent summary.
  const servicesByAgent = new Map<string, string[]>();
  for (const service of input.activeServices) {
    const list = servicesByAgent.get(service.agentId) ?? [];
    list.push(service.serviceId);
    servicesByAgent.set(service.agentId, list);
  }

  const jobsByAgent = new Map<string, string[]>();
  for (const job of input.unresolvedJobs) {
    const list = jobsByAgent.get(job.agentId) ?? [];
    list.push(job.jobId);
    jobsByAgent.set(job.agentId, list);
  }

  // Active services must belong to a known, non-retired agent.
  for (const service of input.activeServices) {
    const state = stateByAgent.get(service.agentId);
    if (state === undefined) {
      contradictions.push({
        code: "ACTIVE_SERVICE_WITHOUT_LIFECYCLE_RECORD",
        agentId: service.agentId,
        message: `Active service ${service.serviceId} has no lifecycle record for agent ${service.agentId}`,
        refs: { serviceId: service.serviceId },
      });
    } else if (state === "retired") {
      contradictions.push({
        code: "RETIRED_AGENT_WITH_ACTIVE_SERVICE",
        agentId: service.agentId,
        message: `Retired agent ${service.agentId} still has active service ${service.serviceId}`,
        refs: { serviceId: service.serviceId },
      });
    }
  }

  // Unresolved jobs must belong to a known, non-retired agent.
  for (const job of input.unresolvedJobs) {
    const state = stateByAgent.get(job.agentId);
    if (state === undefined) {
      contradictions.push({
        code: "UNRESOLVED_JOB_WITHOUT_LIFECYCLE_RECORD",
        agentId: job.agentId,
        message: `Unresolved job ${job.jobId} has no lifecycle record for agent ${job.agentId}`,
        refs: { jobId: job.jobId },
      });
    } else if (state === "retired") {
      contradictions.push({
        code: "UNRESOLVED_JOB_ON_RETIRED_AGENT",
        agentId: job.agentId,
        message: `Retired agent ${job.agentId} still has unresolved job ${job.jobId}`,
        refs: { jobId: job.jobId },
      });
    }
  }

  // Per-agent summary across every agent referenced by any snapshot.
  const agentIds = new Set<string>([
    ...stateByAgent.keys(),
    ...servicesByAgent.keys(),
    ...jobsByAgent.keys(),
  ]);

  const agents = Array.from(agentIds)
    .sort()
    .map((agentId) => ({
      agentId,
      state: stateByAgent.get(agentId) ?? null,
      activeServiceIds: [...(servicesByAgent.get(agentId) ?? [])].sort(),
      unresolvedJobIds: [...(jobsByAgent.get(agentId) ?? [])].sort(),
    }));

  return {
    consistent: contradictions.length === 0,
    contradictions,
    agents,
  };
}
