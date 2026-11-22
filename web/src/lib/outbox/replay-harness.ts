import { getConsumers as getRegisteredConsumers } from "./registry";
import { decideRetry } from "./retry";
import { outboxConfig } from "./config";
import { truncateError } from "./metrics";
import type { Consumer, DispatchSummary, OutboxEvent, OutboxStatus } from "./types";

export interface ReplayEventInput<TPayload = unknown> {
  /** Optional deterministic event ID. Defaults to `replay_evt_<index>`. */
  id?: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  dedupeKey?: string | null;
  maxAttempts?: number;
  /** Offset in ms from `startTimeMs` when the event is enqueued. Defaults to 0. */
  enqueuedAtMs?: number;
  /** Offset in ms from `startTimeMs` when the event is eligible to run (`runAt`). Defaults to `enqueuedAtMs`. */
  scheduledAtMs?: number;
  /**
   * 1-based attempt numbers on which the dispatcher simulates a crash after
   * running consumers and before `ack()`, leaving the lease to expire and be
   * reaped on a later tick.
   */
  simulateLeaseExpiryOnAttempts?: number[];
}

export interface ReplayEffect {
  effectKey: string;
  eventId: string;
  eventType: string;
  consumerIndex: number;
  attempt: number;
  tick: number;
  timestampMs: number;
}

export interface DuplicateEffectReport {
  effectKey: string;
  count: number;
  eventIds: string[];
  occurrences: Array<{
    eventId: string;
    consumerIndex: number;
    attempt: number;
    tick: number;
    timestampMs: number;
  }>;
}

export interface ReplayEventOutcome {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  dedupeKey: string | null;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

export interface ReplayOptions {
  /** Deterministic starting epoch timestamp in ms. Defaults to 2026-01-01T00:00:00.000Z. */
  startTimeMs?: number;
  /** Deterministic PRNG seed for retry backoff jitter. Defaults to 1. */
  seed?: number;
  /** Maximum events leased per tick. Defaults to `outboxConfig.batchSize`. */
  batchSize?: number;
  /** Lease duration in ms before an unacked lease is reapable. Defaults to `outboxConfig.leaseDurationMs`. */
  leaseDurationMs?: number;
  /** Default max attempts when an event omits `maxAttempts`. Defaults to `outboxConfig.defaultMaxAttempts`. */
  defaultMaxAttempts?: number;
  /** Worker identifier stamped on leases. Defaults to `"replay-worker"`. */
  workerId?: string;
  /** Safety ceiling on dispatch ticks to prevent infinite loops. Defaults to 1000. */
  maxTicks?: number;
  /**
   * Optional consumer lookup override. Defaults to the global outbox registry
   * (`getConsumers` from `./registry`).
   */
  getConsumers?: (eventType: string) => Consumer<unknown>[];
  /**
   * Derives a logical effect key for a completed consumer invocation.
   * Return `null` to indicate the consumer produced no side effect (e.g. an
   * idempotent no-op). Defaults to
   * `${event.eventType}:${event.aggregateType}:${event.aggregateId}:consumer#${consumerIndex}`.
   */
  effectKeyFor?: (event: OutboxEvent, consumerIndex: number) => string | null;
}

export interface ReplayReport {
  ticks: number;
  totalEventsEnqueued: number;
  deduplicatedWrites: number;
  summary: DispatchSummary;
  events: ReplayEventOutcome[];
  effects: ReplayEffect[];
  duplicateEffects: DuplicateEffectReport[];
  hasDuplicateEffects: boolean;
  exhaustedMaxTicks: boolean;
}

interface InternalReplayRow {
  event: OutboxEvent;
  order: number;
  simulateLeaseExpiryOnAttempts: Set<number>;
}

const DEFAULT_START_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const DEFAULT_SEED = 1;
const DEFAULT_MAX_TICKS = 1_000;

/** Mulberry32 deterministic PRNG returning values in [0, 1). */
function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function defaultEffectKeyFor(event: OutboxEvent, consumerIndex: number): string {
  return `${event.eventType}:${event.aggregateType}:${event.aggregateId}:consumer#${consumerIndex}`;
}

function validateOptions(opts: ReplayOptions): {
  startTimeMs: number;
  seed: number;
  batchSize: number;
  leaseDurationMs: number;
  defaultMaxAttempts: number;
  workerId: string;
  maxTicks: number;
  resolveConsumers: (eventType: string) => Consumer<unknown>[];
  effectKeyFor: (event: OutboxEvent, consumerIndex: number) => string | null;
} {
  const startTimeMs = opts.startTimeMs ?? DEFAULT_START_TIME_MS;
  const seed = opts.seed ?? DEFAULT_SEED;
  const batchSize = opts.batchSize ?? outboxConfig.batchSize;
  const leaseDurationMs = opts.leaseDurationMs ?? outboxConfig.leaseDurationMs;
  const defaultMaxAttempts = opts.defaultMaxAttempts ?? outboxConfig.defaultMaxAttempts;
  const workerId = opts.workerId ?? "replay-worker";
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;

  if (!Number.isFinite(startTimeMs)) throw new Error("Replay option startTimeMs must be a finite number");
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("Replay option batchSize must be a positive integer");
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new Error("Replay option leaseDurationMs must be a positive integer");
  if (!Number.isInteger(defaultMaxAttempts) || defaultMaxAttempts <= 0) throw new Error("Replay option defaultMaxAttempts must be a positive integer");
  if (!Number.isInteger(maxTicks) || maxTicks <= 0) throw new Error("Replay option maxTicks must be a positive integer");

  return {
    startTimeMs,
    seed,
    batchSize,
    leaseDurationMs,
    defaultMaxAttempts,
    workerId,
    maxTicks,
    resolveConsumers: opts.getConsumers ?? getRegisteredConsumers,
    effectKeyFor: opts.effectKeyFor ?? defaultEffectKeyFor,
  };
}

/**
 * Deterministic in-memory outbox dispatch replay harness.
 *
 * Runs recorded synthetic event sequences through registered outbox consumers
 * using a virtual clock, seeded retry jitter, and in-memory lease ownership
 * semantics — without contacting Postgres, Stellar, or any live service.
 * Reports any duplicate consumer effects caused by retries, lease expiry
 * redeliveries, or non-deduplicated duplicate events.
 */
export async function runOutboxReplay(
  sequence: ReadonlyArray<ReplayEventInput>,
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  const config = validateOptions(opts);
  const rng = createSeededRng(config.seed);

  const summary: DispatchSummary = {
    leased: 0,
    dispatched: 0,
    retried: 0,
    deadLettered: 0,
    reaped: 0,
    pruned: 0,
  };

  const pendingEnqueue = sequence
    .map((input, idx) => ({
      input,
      idx,
      enqueuedAtMs: config.startTimeMs + (input.enqueuedAtMs ?? 0),
    }))
    .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs || a.idx - b.idx);

  let enqueueCursor = 0;
  let leaseCounter = 0;
  let deduplicatedWrites = 0;
  let nowMs = config.startTimeMs;

  const rows: InternalReplayRow[] = [];
  const dedupeIndex = new Map<string, InternalReplayRow>();
  const effects: ReplayEffect[] = [];

  const enqueueDueEvents = () => {
    while (enqueueCursor < pendingEnqueue.length && pendingEnqueue[enqueueCursor].enqueuedAtMs <= nowMs) {
      const { input, idx, enqueuedAtMs } = pendingEnqueue[enqueueCursor];
      enqueueCursor += 1;

      const dedupeKey = input.dedupeKey ?? null;
      if (dedupeKey !== null) {
        const compositeKey = `${input.eventType}\0${dedupeKey}`;
        if (dedupeIndex.has(compositeKey)) {
          deduplicatedWrites += 1;
          continue;
        }
      }

      const runAtMs =
        input.scheduledAtMs !== undefined ? config.startTimeMs + input.scheduledAtMs : enqueuedAtMs;
      const createdAt = new Date(enqueuedAtMs);

      const event: OutboxEvent = {
        id: input.id ?? `replay_evt_${idx + 1}`,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload ?? {},
        status: "pending",
        runAt: new Date(runAtMs),
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? config.defaultMaxAttempts,
        dedupeKey,
        lastError: null,
        createdAt,
        updatedAt: createdAt,
        dispatchedAt: null,
      };

      const row: InternalReplayRow = {
        event,
        order: rows.length,
        simulateLeaseExpiryOnAttempts: new Set(input.simulateLeaseExpiryOnAttempts ?? []),
      };
      rows.push(row);
      if (dedupeKey !== null) {
        dedupeIndex.set(`${input.eventType}\0${dedupeKey}`, row);
      }
    }
  };

  const reapExpiredLeases = (): number => {
    let reaped = 0;
    for (const row of rows) {
      const ev = row.event;
      if (ev.status !== "leased" || !ev.leaseExpiresAt) continue;
      if (ev.leaseExpiresAt.getTime() >= nowMs) continue;

      ev.leaseId = null;
      ev.leaseOwner = null;
      ev.leaseExpiresAt = null;
      ev.updatedAt = new Date(nowMs);
      if (ev.attempts < ev.maxAttempts) {
        ev.status = "pending";
        ev.runAt = new Date(nowMs);
        ev.lastError = "lease expired (dispatcher died mid-lease)";
      } else {
        ev.status = "dead_letter";
        ev.lastError = "lease expired and max attempts reached";
      }
      reaped += 1;
    }
    return reaped;
  };

  const leaseBatch = (): InternalReplayRow[] => {
    const due = rows
      .filter((r) => r.event.status === "pending" && r.event.runAt.getTime() <= nowMs)
      .sort((a, b) => a.event.runAt.getTime() - b.event.runAt.getTime() || a.order - b.order)
      .slice(0, config.batchSize);

    for (const row of due) {
      leaseCounter += 1;
      row.event.status = "leased";
      row.event.leaseId = `replay_lease_${leaseCounter}`;
      row.event.leaseOwner = config.workerId;
      row.event.leaseExpiresAt = new Date(nowMs + config.leaseDurationMs);
      row.event.attempts += 1;
      row.event.updatedAt = new Date(nowMs);
    }
    return due;
  };

  const ack = (row: InternalReplayRow, leaseId: string): boolean => {
    if (row.event.status !== "leased" || row.event.leaseId !== leaseId) return false;
    row.event.status = "dispatched";
    row.event.dispatchedAt = new Date(nowMs);
    row.event.leaseId = null;
    row.event.leaseOwner = null;
    row.event.leaseExpiresAt = null;
    row.event.updatedAt = new Date(nowMs);
    return true;
  };

  const fail = (row: InternalReplayRow, leaseId: string, error: unknown): OutboxStatus | null => {
    if (row.event.status !== "leased" || row.event.leaseId !== leaseId) return null;
    const lastError = truncateError(error);
    const decision = decideRetry({ attempts: row.event.attempts, maxAttempts: row.event.maxAttempts }, rng);

    row.event.leaseId = null;
    row.event.leaseOwner = null;
    row.event.leaseExpiresAt = null;
    row.event.lastError = lastError;
    row.event.updatedAt = new Date(nowMs);

    if (decision.action === "dead_letter") {
      row.event.status = "dead_letter";
      return "dead_letter";
    }

    row.event.status = "pending";
    row.event.runAt = new Date(nowMs + decision.delayMs);
    return "pending";
  };

  const nextWakeTimeMs = (): number | null => {
    let next: number | null = null;
    const consider = (ts: number) => {
      if (next === null || ts < next) next = ts;
    };

    if (enqueueCursor < pendingEnqueue.length) {
      consider(pendingEnqueue[enqueueCursor].enqueuedAtMs);
    }
    for (const row of rows) {
      if (row.event.status === "pending") {
        consider(row.event.runAt.getTime());
      } else if (row.event.status === "leased" && row.event.leaseExpiresAt) {
        // Reaping triggers strictly after leaseExpiresAt (`< now()` in store.ts)
        consider(row.event.leaseExpiresAt.getTime() + 1);
      }
    }
    return next;
  };

  let ticks = 0;
  let exhaustedMaxTicks = false;

  while (true) {
    enqueueDueEvents();

    const hasPendingOrLeased = rows.some((r) => r.event.status === "pending" || r.event.status === "leased");
    const hasFutureEnqueues = enqueueCursor < pendingEnqueue.length;
    if (!hasPendingOrLeased && !hasFutureEnqueues) break;

    if (ticks >= config.maxTicks) {
      exhaustedMaxTicks = true;
      break;
    }

    ticks += 1;
    summary.reaped += reapExpiredLeases();

    const batch = leaseBatch();
    summary.leased += batch.length;

    if (batch.length === 0) {
      const wake = nextWakeTimeMs();
      if (wake === null) break;
      nowMs = Math.max(nowMs + 1, wake);
      continue;
    }

    for (const row of batch) {
      const event = row.event;
      const leaseId = event.leaseId!;
      const handlers = config.resolveConsumers(event.eventType);

      if (handlers.length === 0) {
        event.status = "dead_letter";
        event.leaseId = null;
        event.leaseOwner = null;
        event.leaseExpiresAt = null;
        event.lastError = truncateError(new Error(`No consumer registered for event type "${event.eventType}"`));
        event.updatedAt = new Date(nowMs);
        summary.deadLettered += 1;
        continue;
      }

      try {
        for (let consumerIndex = 0; consumerIndex < handlers.length; consumerIndex += 1) {
          await handlers[consumerIndex](event);
          const effectKey = config.effectKeyFor(event, consumerIndex);
          if (effectKey !== null) {
            effects.push({
              effectKey,
              eventId: event.id,
              eventType: event.eventType,
              consumerIndex,
              attempt: event.attempts,
              tick: ticks,
              timestampMs: nowMs,
            });
          }
        }

        if (row.simulateLeaseExpiryOnAttempts.has(event.attempts)) {
          // Simulate dispatcher crash after consumer execution and before ack().
          continue;
        }

        if (ack(row, leaseId)) summary.dispatched += 1;
      } catch (err) {
        const status = fail(row, leaseId, err);
        if (status === "dead_letter") summary.deadLettered += 1;
        else if (status === "pending") summary.retried += 1;
      }
    }

    const wake = nextWakeTimeMs();
    if (wake !== null && wake > nowMs) {
      nowMs = wake;
    }
  }

  const effectsByKey = new Map<string, ReplayEffect[]>();
  for (const eff of effects) {
    const list = effectsByKey.get(eff.effectKey) ?? [];
    list.push(eff);
    effectsByKey.set(eff.effectKey, list);
  }

  const duplicateEffects: DuplicateEffectReport[] = [];
  for (const [effectKey, list] of effectsByKey.entries()) {
    if (list.length > 1) {
      const eventIds = Array.from(new Set(list.map((e) => e.eventId)));
      duplicateEffects.push({
        effectKey,
        count: list.length,
        eventIds,
        occurrences: list.map((e) => ({
          eventId: e.eventId,
          consumerIndex: e.consumerIndex,
          attempt: e.attempt,
          tick: e.tick,
          timestampMs: e.timestampMs,
        })),
      });
    }
  }

  const events: ReplayEventOutcome[] = rows.map(({ event }) => ({
    id: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    dedupeKey: event.dedupeKey,
    status: event.status,
    attempts: event.attempts,
    maxAttempts: event.maxAttempts,
    lastError: event.lastError,
  }));

  return {
    ticks,
    totalEventsEnqueued: sequence.length,
    deduplicatedWrites,
    summary,
    events,
    effects,
    duplicateEffects,
    hasDuplicateEffects: duplicateEffects.length > 0,
    exhaustedMaxTicks,
  };
}
