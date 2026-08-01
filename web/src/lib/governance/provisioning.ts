/**
 * Durable, compensated provisioning workflows.
 *
 * An approved lifecycle action becomes a row in `tls_provisioning_jobs` and is
 * then executed step by step. Every step commits its own state before the next
 * one starts, so a crash at any point leaves a record the worker can resume
 * from rather than a half-provisioned agent nobody can account for.
 *
 * Guarantees
 * ──────────
 * - **Idempotent submission**: a resubmitted action with the same key returns
 *   the original run instead of starting a second one.
 * - **Idempotent steps**: each step gets a deterministic key derived from
 *   `(jobId, stepName)`; a step that already recorded `completed` is replayed
 *   from its stored output, never re-executed.
 * - **Resumable**: state lives entirely in the row. Restarting the process
 *   loses nothing; the worker re-leases and continues from `cursor`.
 * - **Compensated**: on terminal failure, completed steps are undone in reverse
 *   order. Compensation itself is idempotent and its failures are recorded
 *   rather than swallowed.
 * - **Single-writer**: a lease with a fencing token prevents two workers from
 *   advancing the same run.
 */
import { and, eq, lt, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { tlsProvisioningJobs } from "@/db/schema";
import { logger } from "@/lib/logger";

import { LIFECYCLE_EVENTS, emitLifecycleEvent } from "./events";
import { LifecycleError, type AgentLifecycleState, type LifecycleAction } from "./lifecycle";

// ── Types ────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed" | "compensated";

export interface StepRecord {
  name: string;
  status: StepStatus;
  attempts: number;
  idempotencyKey: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Step output, persisted so a resumed run can read it without re-running. */
  output: Record<string, unknown> | null;
  /** Redacted, operator-facing failure message. */
  error: string | null;
}

export type ProvisioningJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "compensating"
  | "compensated"
  | "failed";

export interface StepContext {
  jobId: string;
  talosId: string;
  action: LifecycleAction;
  /** Deterministic key for this step — pass to any external system that accepts one. */
  idempotencyKey: string;
  /** Outputs of previously completed steps, keyed by step name. */
  outputs: Readonly<Record<string, Record<string, unknown> | null>>;
  signal: AbortSignal;
}

export interface StepDefinition {
  name: string;
  /** Perform the effect. Must tolerate being called after a partial prior attempt. */
  run: (ctx: StepContext) => Promise<Record<string, unknown>>;
  /**
   * Undo the effect. Called in reverse order on terminal failure. Must be safe
   * to call when `run` only partially applied, and safe to call twice.
   */
  compensate: (ctx: StepContext) => Promise<void>;
}

export interface WorkflowDefinition {
  action: LifecycleAction;
  steps: readonly StepDefinition[];
  /** State entered when every step completes. */
  successState: AgentLifecycleState;
  /** State entered when the run fails and compensation settles. */
  failureState: AgentLifecycleState;
}

// ── Configuration ────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Lease TTL. A run whose lease expires is reclaimable by another worker. */
export const LEASE_TTL_MS = envInt("PROVISIONING_LEASE_TTL_MS", 60_000);
/** Per-step wall-clock budget. Exceeding it aborts the step and counts an attempt. */
export const STEP_TIMEOUT_MS = envInt("PROVISIONING_STEP_TIMEOUT_MS", 30_000);
/** Attempts per step before the run is declared failed and compensated. */
export const MAX_STEP_ATTEMPTS = envInt("PROVISIONING_MAX_STEP_ATTEMPTS", 3);

// ── Submission ───────────────────────────────────────────────────────

export interface SubmitOptions {
  talosId: string;
  action: LifecycleAction;
  requestedBy: string;
  idempotencyKey: string;
  workflow: WorkflowDefinition;
}

function initialSteps(jobId: string, workflow: WorkflowDefinition): StepRecord[] {
  return workflow.steps.map((s) => ({
    name: s.name,
    status: "pending" as const,
    attempts: 0,
    idempotencyKey: `${jobId}:${s.name}`,
    startedAt: null,
    completedAt: null,
    output: null,
    error: null,
  }));
}

/**
 * Create a durable run, or return the existing one for this idempotency key.
 * The unique index on `(talosId, idempotencyKey)` is what makes the
 * check-then-insert safe under concurrent submission: a racing caller's insert
 * fails and it re-reads the winner.
 */
export async function submitProvisioningJob(
  opts: SubmitOptions,
): Promise<{ jobId: string; created: boolean }> {
  const existing = await findByIdempotencyKey(opts.talosId, opts.idempotencyKey);
  if (existing) return { jobId: existing.id, created: false };

  try {
    const [row] = await db
      .insert(tlsProvisioningJobs)
      .values({
        talosId: opts.talosId,
        action: opts.action,
        status: "pending",
        steps: [],
        cursor: 0,
        requestedBy: opts.requestedBy,
        idempotencyKey: opts.idempotencyKey,
        maxAttempts: MAX_STEP_ATTEMPTS,
      })
      .returning({ id: tlsProvisioningJobs.id });

    // Step keys embed the job id, so they are filled in once the id exists.
    await db
      .update(tlsProvisioningJobs)
      .set({ steps: initialSteps(row.id, opts.workflow) })
      .where(eq(tlsProvisioningJobs.id, row.id));

    return { jobId: row.id, created: true };
  } catch {
    const winner = await findByIdempotencyKey(opts.talosId, opts.idempotencyKey);
    if (winner) return { jobId: winner.id, created: false };
    throw new LifecycleError(
      "LIFECYCLE_CONFLICT",
      "Could not create provisioning run; retry with the same idempotency key",
      { talosId: opts.talosId },
    );
  }
}

async function findByIdempotencyKey(talosId: string, key: string) {
  return db
    .select({ id: tlsProvisioningJobs.id, status: tlsProvisioningJobs.status })
    .from(tlsProvisioningJobs)
    .where(
      and(eq(tlsProvisioningJobs.talosId, talosId), eq(tlsProvisioningJobs.idempotencyKey, key)),
    )
    .limit(1)
    .then((r) => r[0] ?? null);
}

// ── Leasing ──────────────────────────────────────────────────────────

/**
 * Take exclusive ownership of a run. The conditional UPDATE is the mutual
 * exclusion primitive — two workers issuing it concurrently produce exactly one
 * winner, because the loser's WHERE clause no longer matches.
 */
export async function acquireLease(
  jobId: string,
  workerId: string,
): Promise<{ fencingToken: number } | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);

  const rows = await db
    .update(tlsProvisioningJobs)
    .set({
      status: "running",
      leasedBy: workerId,
      leaseExpiresAt: expiresAt,
      fencingToken: sql`${tlsProvisioningJobs.fencingToken} + 1`,
    })
    .where(
      and(
        eq(tlsProvisioningJobs.id, jobId),
        or(
          eq(tlsProvisioningJobs.status, "pending"),
          // Reclaim a run whose owner died mid-flight.
          and(
            eq(tlsProvisioningJobs.status, "running"),
            lt(tlsProvisioningJobs.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning({ fencingToken: tlsProvisioningJobs.fencingToken });

  return rows[0] ?? null;
}

async function renewLease(jobId: string, workerId: string, fencingToken: number): Promise<boolean> {
  const rows = await db
    .update(tlsProvisioningJobs)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS) })
    .where(
      and(
        eq(tlsProvisioningJobs.id, jobId),
        eq(tlsProvisioningJobs.leasedBy, workerId),
        eq(tlsProvisioningJobs.fencingToken, fencingToken),
      ),
    )
    .returning({ id: tlsProvisioningJobs.id });

  return rows.length > 0;
}

// ── Execution ────────────────────────────────────────────────────────

/** Truncated, non-secret rendering of an error for persistence and UI. */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunResult {
  jobId: string;
  status: ProvisioningJobStatus;
  finalState: AgentLifecycleState | null;
  completedSteps: string[];
  failedStep: string | null;
}

/**
 * Drive a leased run to a terminal status. Safe to call repeatedly: already
 * completed steps replay from their persisted output, and a run that is already
 * terminal returns immediately.
 */
export async function runProvisioningJob(
  jobId: string,
  workflow: WorkflowDefinition,
  workerId: string,
  fencingToken: number,
): Promise<RunResult> {
  const job = await loadJob(jobId);
  if (!job) {
    throw new LifecycleError("LIFECYCLE_CONFLICT", "Provisioning run not found", { jobId });
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "compensated") {
    return {
      jobId,
      status: job.status as ProvisioningJobStatus,
      finalState: null,
      completedSteps: job.steps.filter((s) => s.status === "completed").map((s) => s.name),
      failedStep: job.steps.find((s) => s.status === "failed")?.name ?? null,
    };
  }

  // Backfill for runs created before their step list was written.
  const steps: StepRecord[] = job.steps.length > 0 ? job.steps : initialSteps(jobId, workflow);
  const outputs: Record<string, Record<string, unknown> | null> = {};
  for (const s of steps) {
    if (s.status === "completed") outputs[s.name] = s.output;
  }

  await emitLifecycleEvent({
    talosId: job.talosId,
    eventType: LIFECYCLE_EVENTS.PROVISIONING_STARTED,
    fromState: null,
    toState: "provisioning",
    actorId: "system",
    actorRole: "system",
    jobId,
    detail: { action: job.action, resumedFromStep: job.cursor },
    idempotencyKey: `${jobId}:started:${job.cursor}`,
  });

  for (let i = 0; i < workflow.steps.length; i++) {
    const definition = workflow.steps[i];
    const record = steps[i];

    // Replay: the effect already happened and its output is on record.
    if (record.status === "completed") {
      outputs[record.name] = record.output;
      continue;
    }

    if (!(await renewLease(jobId, workerId, fencingToken))) {
      // Another worker fenced us out. Stop without touching shared state.
      throw new LifecycleError("LIFECYCLE_CONFLICT", "Provisioning lease lost", {
        jobId,
        step: definition.name,
      });
    }

    record.status = "running";
    record.attempts += 1;
    record.startedAt = record.startedAt ?? new Date().toISOString();
    await persist(jobId, { steps, cursor: i, status: "running" });

    try {
      const output = await withTimeout(
        (signal) =>
          definition.run({
            jobId,
            talosId: job.talosId,
            action: job.action as LifecycleAction,
            idempotencyKey: record.idempotencyKey,
            outputs,
            signal,
          }),
        STEP_TIMEOUT_MS,
      );

      record.status = "completed";
      record.completedAt = new Date().toISOString();
      record.output = output;
      record.error = null;
      outputs[record.name] = output;

      await persist(jobId, { steps, cursor: i + 1, status: "running" });

      await emitLifecycleEvent({
        talosId: job.talosId,
        eventType: LIFECYCLE_EVENTS.STEP_COMPLETED,
        fromState: "provisioning",
        toState: "provisioning",
        actorId: "system",
        actorRole: "system",
        jobId,
        stepName: record.name,
        detail: { attempts: record.attempts },
        idempotencyKey: `${record.idempotencyKey}:completed`,
      });
    } catch (err) {
      record.error = safeError(err);
      const exhausted = record.attempts >= MAX_STEP_ATTEMPTS;
      record.status = exhausted ? "failed" : "pending";

      await persist(jobId, {
        steps,
        cursor: i,
        status: exhausted ? "compensating" : "pending",
        lastError: record.error,
      });

      logger.warn(
        {
          event: "provisioning.step_failed",
          jobId,
          talosId: job.talosId,
          step: record.name,
          attempts: record.attempts,
          exhausted,
        },
        "provisioning step failed",
      );

      await emitLifecycleEvent({
        talosId: job.talosId,
        eventType: LIFECYCLE_EVENTS.STEP_FAILED,
        fromState: "provisioning",
        toState: exhausted ? workflow.failureState : "provisioning",
        actorId: "system",
        actorRole: "system",
        jobId,
        stepName: record.name,
        detail: { attempts: record.attempts, error: record.error, exhausted },
        idempotencyKey: `${record.idempotencyKey}:failed:${record.attempts}`,
      });

      if (!exhausted) {
        // Leave the run claimable; the next poll retries this same step.
        return {
          jobId,
          status: "pending",
          finalState: null,
          completedSteps: Object.keys(outputs),
          failedStep: record.name,
        };
      }

      await compensate(job.talosId, jobId, workflow, steps, outputs, i);

      await persist(jobId, {
        steps,
        cursor: i,
        status: "failed",
        lastError: record.error,
        completedAt: new Date(),
      });

      await emitLifecycleEvent({
        talosId: job.talosId,
        eventType: LIFECYCLE_EVENTS.FAILED,
        fromState: "provisioning",
        toState: workflow.failureState,
        actorId: "system",
        actorRole: "system",
        jobId,
        stepName: record.name,
        detail: { error: record.error },
        idempotencyKey: `${jobId}:failed`,
      });

      return {
        jobId,
        status: "failed",
        finalState: workflow.failureState,
        completedSteps: Object.keys(outputs),
        failedStep: record.name,
      };
    }
  }

  await persist(jobId, {
    steps,
    cursor: workflow.steps.length,
    status: "completed",
    completedAt: new Date(),
    leasedBy: null,
    leaseExpiresAt: null,
  });

  await emitLifecycleEvent({
    talosId: job.talosId,
    eventType:
      workflow.successState === "retired" ? LIFECYCLE_EVENTS.RETIRED : LIFECYCLE_EVENTS.ACTIVATED,
    fromState: "provisioning",
    toState: workflow.successState,
    actorId: "system",
    actorRole: "system",
    jobId,
    detail: { steps: steps.map((s) => s.name) },
    idempotencyKey: `${jobId}:completed`,
  });

  return {
    jobId,
    status: "completed",
    finalState: workflow.successState,
    completedSteps: steps.map((s) => s.name),
    failedStep: null,
  };
}

/**
 * Unwind completed steps in reverse order. A compensation that itself fails is
 * recorded on the step and does not abort the remaining compensations — leaving
 * later steps applied would be strictly worse than a partial unwind we can see.
 */
async function compensate(
  talosId: string,
  jobId: string,
  workflow: WorkflowDefinition,
  steps: StepRecord[],
  outputs: Record<string, Record<string, unknown> | null>,
  failedIndex: number,
): Promise<void> {
  await emitLifecycleEvent({
    talosId,
    eventType: LIFECYCLE_EVENTS.COMPENSATION_STARTED,
    fromState: "provisioning",
    toState: "provisioning",
    actorId: "system",
    actorRole: "system",
    jobId,
    detail: { fromStep: workflow.steps[failedIndex]?.name ?? null },
    idempotencyKey: `${jobId}:compensation:started`,
  });

  for (let i = failedIndex; i >= 0; i--) {
    const record = steps[i];
    if (record.status !== "completed" && record.status !== "failed") continue;

    try {
      await withTimeout(
        (signal) =>
          workflow.steps[i].compensate({
            jobId,
            talosId,
            action: workflow.action,
            idempotencyKey: `${record.idempotencyKey}:compensate`,
            outputs,
            signal,
          }),
        STEP_TIMEOUT_MS,
      );
      record.status = "compensated";
    } catch (err) {
      record.error = `compensation failed: ${safeError(err)}`;
      logger.error(
        { event: "provisioning.compensation_failed", jobId, talosId, step: record.name },
        "compensation failed; manual reconciliation required",
      );
    }

    await persist(jobId, { steps, status: "compensating" });
  }

  await emitLifecycleEvent({
    talosId,
    eventType: LIFECYCLE_EVENTS.COMPENSATION_COMPLETED,
    fromState: "provisioning",
    toState: "provisioning",
    actorId: "system",
    actorRole: "system",
    jobId,
    detail: {
      compensated: steps.filter((s) => s.status === "compensated").map((s) => s.name),
      unresolved: steps.filter((s) => s.error?.startsWith("compensation failed")).map((s) => s.name),
    },
    idempotencyKey: `${jobId}:compensation:completed`,
  });
}

// ── Persistence helpers ──────────────────────────────────────────────

interface JobRow {
  id: string;
  talosId: string;
  action: string;
  status: string;
  steps: StepRecord[];
  cursor: number;
  fencingToken: number;
}

export async function loadJob(jobId: string): Promise<JobRow | null> {
  return db
    .select({
      id: tlsProvisioningJobs.id,
      talosId: tlsProvisioningJobs.talosId,
      action: tlsProvisioningJobs.action,
      status: tlsProvisioningJobs.status,
      steps: tlsProvisioningJobs.steps,
      cursor: tlsProvisioningJobs.cursor,
      fencingToken: tlsProvisioningJobs.fencingToken,
    })
    .from(tlsProvisioningJobs)
    .where(eq(tlsProvisioningJobs.id, jobId))
    .limit(1)
    .then((r) => (r[0] ? ({ ...r[0], steps: (r[0].steps ?? []) as StepRecord[] } as JobRow) : null));
}

async function persist(
  jobId: string,
  patch: {
    steps?: StepRecord[];
    cursor?: number;
    status?: ProvisioningJobStatus;
    lastError?: string;
    completedAt?: Date;
    leasedBy?: string | null;
    leaseExpiresAt?: Date | null;
  },
): Promise<void> {
  await db.update(tlsProvisioningJobs).set(patch).where(eq(tlsProvisioningJobs.id, jobId));
}

/**
 * Runs that are claimable right now: never started, or leased by a worker that
 * stopped renewing. Called by the restart-recovery sweep.
 */
export async function findResumableJobs(limit = 10): Promise<{ id: string; action: string }[]> {
  const now = new Date();
  return db
    .select({ id: tlsProvisioningJobs.id, action: tlsProvisioningJobs.action })
    .from(tlsProvisioningJobs)
    .where(
      or(
        eq(tlsProvisioningJobs.status, "pending"),
        and(
          eq(tlsProvisioningJobs.status, "running"),
          lt(tlsProvisioningJobs.leaseExpiresAt, now),
        ),
      ),
    )
    .limit(Math.min(Math.max(limit, 1), 100));
}

// ── Workflows ────────────────────────────────────────────────────────

/**
 * Provisioning steps for an approved agent. Each `run` is written to be
 * re-entrant: it checks for the effect before applying it, so a retry after an
 * ambiguous failure converges rather than duplicating.
 *
 * The concrete effects are delegated to the existing wallet, credential, and
 * service modules; this file owns only the durability contract around them.
 */
export function buildActivationWorkflow(effects: ProvisioningEffects): WorkflowDefinition {
  return {
    action: "activate",
    successState: "active",
    failureState: "failed",
    steps: [
      {
        name: "wallet",
        run: (ctx) => effects.createWallet(ctx),
        compensate: (ctx) => effects.releaseWallet(ctx),
      },
      {
        name: "credentials",
        run: (ctx) => effects.issueCredentials(ctx),
        compensate: (ctx) => effects.revokeCredentials(ctx),
      },
      {
        name: "services",
        run: (ctx) => effects.registerServices(ctx),
        compensate: (ctx) => effects.deregisterServices(ctx),
      },
      {
        name: "runtime",
        run: (ctx) => effects.startRuntime(ctx),
        compensate: (ctx) => effects.stopRuntime(ctx),
      },
    ],
  };
}

export function buildRetirementWorkflow(effects: ProvisioningEffects): WorkflowDefinition {
  return {
    action: "retire",
    successState: "retired",
    failureState: "failed",
    steps: [
      {
        name: "runtime",
        run: (ctx) => effects.stopRuntime(ctx).then(() => ({ stopped: true })),
        // Retirement is intentionally one-way: restarting a runtime we were
        // told to retire would contradict the governance decision. Recovery
        // goes through the `recover` action instead.
        compensate: async () => {},
      },
      {
        name: "services",
        run: (ctx) => effects.deregisterServices(ctx).then(() => ({ deregistered: true })),
        compensate: async () => {},
      },
      {
        name: "credentials",
        run: (ctx) => effects.revokeCredentials(ctx).then(() => ({ revoked: true })),
        compensate: async () => {},
      },
    ],
  };
}

/**
 * The side-effecting boundary. Implementations live next to the systems they
 * touch; injecting them keeps this module testable without a wallet, an RPC
 * endpoint, or a running agent.
 */
export interface ProvisioningEffects {
  createWallet(ctx: StepContext): Promise<Record<string, unknown>>;
  releaseWallet(ctx: StepContext): Promise<void>;
  issueCredentials(ctx: StepContext): Promise<Record<string, unknown>>;
  revokeCredentials(ctx: StepContext): Promise<void>;
  registerServices(ctx: StepContext): Promise<Record<string, unknown>>;
  deregisterServices(ctx: StepContext): Promise<void>;
  startRuntime(ctx: StepContext): Promise<Record<string, unknown>>;
  stopRuntime(ctx: StepContext): Promise<void>;
}

export function workflowFor(
  action: LifecycleAction,
  effects: ProvisioningEffects,
): WorkflowDefinition {
  switch (action) {
    case "activate":
    case "recover":
      return { ...buildActivationWorkflow(effects), action };
    case "retire":
      return buildRetirementWorkflow(effects);
    default:
      throw new LifecycleError(
        "LIFECYCLE_INVALID_TRANSITION",
        `Action ${action} has no durable workflow`,
        { action },
      );
  }
}
