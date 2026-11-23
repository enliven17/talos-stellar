/**
 * Offline lifecycle consistency report.
 *
 * Compares lifecycle records, active service registrations, and unresolved
 * commerce jobs to surface contradictions in agent state without mutating
 * any funded or operational data.
 *
 * "Offline" means this module performs no I/O of its own. The caller
 * assembles the input snapshot from whatever persistence layer is in use and
 * passes it in. That keeps the logic fully testable with synthetic fixtures
 * and makes it safe to invoke from a read-only audit path.
 *
 * A contradiction is a pairing of observed facts that are logically
 * inconsistent with the lifecycle state machine defined in lifecycle.ts.
 * The report lists every contradiction found — it never silently drops one.
 */

import {
  TERMINAL_STATES,
  OPERATIONAL_STATES,
  TRANSIENT_STATES,
  type AgentLifecycleState,
} from "./lifecycle";

// ── Input snapshot ───────────────────────────────────────────────────────────

/**
 * The latest lifecycle record as stored in the event log or the agent row.
 * Both `state` and `onlineFlag` are required so the report can compare them
 * independently.
 */
export interface LifecycleRecord {
  talosId: string;
  /** Current lifecycle state derived from the event log tip. */
  state: AgentLifecycleState;
  /**
   * The `agentOnline` boolean from the agent row. This is a secondary signal
   * that should track the lifecycle state but is updated by a separate path,
   * so it can drift.
   */
  onlineFlag: boolean;
  /**
   * Whether a `retiredAt` timestamp is set on the agent row. A retired agent
   * must have this set; a non-retired agent must not.
   */
  hasRetiredTimestamp: boolean;
}

/**
 * A registered service associated with the agent. An agent in a terminal or
 * transient state should not have active services routing payments to it.
 */
export interface ServiceRecord {
  serviceId: string;
  talosId: string;
  /**
   * Whether the service has a live Stellar payment key pointing at the agent's
   * wallet (i.e. `stellarPublicKey` is non-null and non-empty).
   */
  hasActivePaymentKey: boolean;
}

/**
 * A commerce job that has not reached a terminal state (`completed`,
 * `dead_letter`, `cancelled`). Unresolved jobs on a retired or terminal agent
 * are a contradiction.
 */
export interface UnresolvedJobRecord {
  jobId: string;
  talosId: string;
  /** Job status at snapshot time. */
  status: string;
}

/**
 * The complete input snapshot. All three collections are required; pass empty
 * arrays for collections that have no rows, never `undefined` or `null`.
 */
export interface ConsistencySnapshot {
  lifecycleRecords: LifecycleRecord[];
  serviceRecords: ServiceRecord[];
  unresolvedJobs: UnresolvedJobRecord[];
}

// ── Contradictions ───────────────────────────────────────────────────────────

/**
 * Stable machine-readable contradiction codes. Values must never be
 * repurposed once released — consumers branch on them.
 */
export const CONTRADICTION_CODES = [
  /**
   * Agent is in a terminal state but `agentOnline` is still `true`.
   * A retired (or otherwise terminal) agent cannot be online.
   */
  "TERMINAL_AGENT_ONLINE",

  /**
   * Agent is in a terminal state but has an active service with a live
   * payment key. No new payments should route to a terminal agent.
   */
  "TERMINAL_AGENT_WITH_ACTIVE_SERVICE",

  /**
   * Agent is in a terminal state but has unresolved (non-terminal) jobs.
   * Those jobs can never be fulfilled; they must be drained or cancelled.
   */
  "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS",

  /**
   * Agent is in the `active` state (should accept work) but `agentOnline`
   * is `false`. The agent row contradicts the lifecycle event log.
   */
  "ACTIVE_AGENT_OFFLINE_FLAG",

  /**
   * Agent is in a non-terminal, non-retired state but has a `retiredAt`
   * timestamp set on the agent row. The timestamp is inconsistent with the
   * current lifecycle position.
   */
  "STALE_RETIRED_TIMESTAMP",

  /**
   * Agent is in the `retired` state but has no `retiredAt` timestamp set.
   * A properly retired agent must have its retirement time recorded.
   */
  "RETIRED_STATE_MISSING_TIMESTAMP",

  /**
   * Agent is in a transient in-flight state (e.g. `provisioning`,
   * `retiring`) but `agentOnline` is `true`. Transient states represent
   * server-owned work and should not be exposing the agent as available.
   */
  "TRANSIENT_AGENT_ONLINE",
] as const;

export type ContradictionCode = (typeof CONTRADICTION_CODES)[number];

export interface Contradiction {
  /** Stable identifier for this contradiction type. */
  code: ContradictionCode;
  /** Human-readable explanation, safe to expose to operators. */
  message: string;
  /** Agent to which this contradiction applies. */
  talosId: string;
  /**
   * Supporting evidence gathered from the snapshot. Never contains funded
   * amounts, secrets, or personal data — only structural identifiers.
   */
  evidence: Record<string, unknown>;
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface ConsistencyReport {
  /**
   * ISO-8601 timestamp at which the report was produced. This is the wall
   * clock time of evaluation, not the snapshot time, since the snapshot
   * does not carry a timestamp of its own.
   */
  generatedAt: string;
  /** Number of lifecycle records evaluated. */
  agentCount: number;
  /** Number of service records evaluated. */
  serviceCount: number;
  /** Number of unresolved job records evaluated. */
  unresolvedJobCount: number;
  /**
   * All contradictions found. Empty when the snapshot is fully consistent.
   * Sorted by talosId then code so the output is deterministic.
   */
  contradictions: Contradiction[];
  /**
   * `true` when no contradictions were found. Convenience flag; equivalent
   * to `contradictions.length === 0`.
   */
  consistent: boolean;
}

// ── Checks ───────────────────────────────────────────────────────────────────

function checkTerminalAgentOnline(record: LifecycleRecord): Contradiction | null {
  if (!TERMINAL_STATES.has(record.state)) return null;
  if (!record.onlineFlag) return null;
  return {
    code: "TERMINAL_AGENT_ONLINE",
    message: `Agent is in terminal state "${record.state}" but agentOnline is true`,
    talosId: record.talosId,
    evidence: { state: record.state, onlineFlag: record.onlineFlag },
  };
}

function checkTerminalAgentWithActiveServices(
  record: LifecycleRecord,
  serviceRecords: ServiceRecord[],
): Contradiction | null {
  if (!TERMINAL_STATES.has(record.state)) return null;
  const active = serviceRecords.filter(
    (s) => s.talosId === record.talosId && s.hasActivePaymentKey,
  );
  if (active.length === 0) return null;
  return {
    code: "TERMINAL_AGENT_WITH_ACTIVE_SERVICE",
    message: `Agent is in terminal state "${record.state}" but has ${active.length} service(s) with active payment keys`,
    talosId: record.talosId,
    evidence: {
      state: record.state,
      activeServiceIds: active.map((s) => s.serviceId),
    },
  };
}

function checkTerminalAgentWithUnresolvedJobs(
  record: LifecycleRecord,
  unresolvedJobs: UnresolvedJobRecord[],
): Contradiction | null {
  if (!TERMINAL_STATES.has(record.state)) return null;
  const jobs = unresolvedJobs.filter((j) => j.talosId === record.talosId);
  if (jobs.length === 0) return null;
  return {
    code: "TERMINAL_AGENT_WITH_UNRESOLVED_JOBS",
    message: `Agent is in terminal state "${record.state}" but has ${jobs.length} unresolved job(s)`,
    talosId: record.talosId,
    evidence: {
      state: record.state,
      unresolvedJobIds: jobs.map((j) => j.jobId),
      statuses: [...new Set(jobs.map((j) => j.status))],
    },
  };
}

function checkActiveAgentOfflineFlag(record: LifecycleRecord): Contradiction | null {
  if (!OPERATIONAL_STATES.has(record.state)) return null;
  if (record.onlineFlag) return null;
  return {
    code: "ACTIVE_AGENT_OFFLINE_FLAG",
    message: `Agent is in operational state "${record.state}" but agentOnline is false`,
    talosId: record.talosId,
    evidence: { state: record.state, onlineFlag: record.onlineFlag },
  };
}

function checkStaleRetiredTimestamp(record: LifecycleRecord): Contradiction | null {
  if (record.state === "retired") return null;
  if (!record.hasRetiredTimestamp) return null;
  return {
    code: "STALE_RETIRED_TIMESTAMP",
    message: `Agent is in state "${record.state}" but has a retiredAt timestamp set`,
    talosId: record.talosId,
    evidence: { state: record.state, hasRetiredTimestamp: true },
  };
}

function checkRetiredStateMissingTimestamp(record: LifecycleRecord): Contradiction | null {
  if (record.state !== "retired") return null;
  if (record.hasRetiredTimestamp) return null;
  return {
    code: "RETIRED_STATE_MISSING_TIMESTAMP",
    message: `Agent is in state "retired" but has no retiredAt timestamp`,
    talosId: record.talosId,
    evidence: { state: record.state, hasRetiredTimestamp: false },
  };
}

function checkTransientAgentOnline(record: LifecycleRecord): Contradiction | null {
  if (!TRANSIENT_STATES.has(record.state)) return null;
  if (!record.onlineFlag) return null;
  return {
    code: "TRANSIENT_AGENT_ONLINE",
    message: `Agent is in transient state "${record.state}" but agentOnline is true`,
    talosId: record.talosId,
    evidence: { state: record.state, onlineFlag: record.onlineFlag },
  };
}

// ── Report builder ───────────────────────────────────────────────────────────

/**
 * Produce an offline lifecycle consistency report from the given snapshot.
 *
 * This function is pure: it performs no I/O, never throws, and never mutates
 * its inputs or any external state. The caller is responsible for assembling
 * the snapshot from the data layer and for deciding what to do with the
 * resulting contradictions.
 */
export function buildConsistencyReport(snapshot: ConsistencySnapshot): ConsistencyReport {
  const { lifecycleRecords, serviceRecords, unresolvedJobs } = snapshot;

  const contradictions: Contradiction[] = [];

  for (const record of lifecycleRecords) {
    const checks = [
      checkTerminalAgentOnline(record),
      checkTerminalAgentWithActiveServices(record, serviceRecords),
      checkTerminalAgentWithUnresolvedJobs(record, unresolvedJobs),
      checkActiveAgentOfflineFlag(record),
      checkStaleRetiredTimestamp(record),
      checkRetiredStateMissingTimestamp(record),
      checkTransientAgentOnline(record),
    ];
    for (const c of checks) {
      if (c !== null) contradictions.push(c);
    }
  }

  // Deterministic output: sort by talosId then code.
  contradictions.sort((a, b) => {
    const byId = a.talosId.localeCompare(b.talosId);
    return byId !== 0 ? byId : a.code.localeCompare(b.code);
  });

  return {
    generatedAt: new Date().toISOString(),
    agentCount: lifecycleRecords.length,
    serviceCount: serviceRecords.length,
    unresolvedJobCount: unresolvedJobs.length,
    contradictions,
    consistent: contradictions.length === 0,
  };
}
