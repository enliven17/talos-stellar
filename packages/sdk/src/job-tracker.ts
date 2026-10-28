/**
 * Job tracking combining SSE progress streaming with exponential backoff polling fallback.
 *
 * Designed to provide buyers a single, resilient API to follow a purchased
 * commerce job to completion:
 *
 * 1. Opens an SSE stream to `/api/jobs/:id/progress` via {@link TalosEventStream}.
 * 2. If SSE disconnects or encounters transport errors (e.g. network drops, timeouts),
 *    automatically falls back to backoff polling via `getJobResult`.
 * 3. Bidirectionally deduplicates progress updates across SSE and polling using {@link SeenStore}.
 * 4. Yields ordered, deduplicated progress events and ends with the final result.
 * 5. Cleans up all streams and active timers on abort, completion, or error.
 *
 * @module job-tracker
 */

import type { TalosClient } from "./client.js";
import {
  TalosEventStream,
  type TalosStreamEvent,
  type SeenStore,
  InMemorySeenStore,
} from "./events.js";
import {
  TalosAPIError,
  TalosTimeoutError,
} from "./errors.js";
import type { CommerceJob } from "./types.js";
import type { ChaosInjector } from "./chaos.js";
import type { Logger } from "./webhooks.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Mid-flight progress payload reported for a job.
 */
export interface JobProgressDetails {
  /** Completion percentage (0-100). */
  percent: number | null;
  /** Current execution stage label. */
  stage: string | null;
  /** Human-readable progress message. */
  message: string | null;
  /** ISO timestamp when the progress was reported. */
  updatedAt?: string;
  /** Agent or worker ID that reported the progress. */
  reportedBy?: string;
}

/**
 * Event type discriminants emitted by the job tracker iterator.
 */
export type TrackJobEventType = "snapshot" | "progress" | "poll" | "result";

/**
 * A typed progress or completion event yielded by the `trackJob` iterator.
 */
export interface TrackJobEvent {
  /** Discriminant for the event kind. */
  type: TrackJobEventType;
  /** The ID of the job being tracked. */
  jobId: string;
  /** Current job status ("pending", "completed", "failed", "cancelled", etc.). */
  status: string;
  /** Progress details if available. */
  progress: JobProgressDetails | null;
  /** Convenience access for `progress?.percent ?? null`. */
  percent: number | null;
  /** Convenience access for `progress?.stage ?? null`. */
  stage: string | null;
  /** Convenience access for `progress?.message ?? null`. */
  message: string | null;
  /** Result payload if completed. */
  result?: unknown;
  /** Delivery source: "stream" (SSE) or "poll" (HTTP polling fallback). */
  source: "stream" | "poll";
  /** Wall-clock time when this event was received. */
  receivedAt: Date;
  /** Full underlying payload from the server. */
  raw?: unknown;
}

/**
 * Terminal statuses recognized for a job.
 */
export type JobTerminalStatus = "completed" | "failed" | "cancelled";

/**
 * Structured terminal outcome for a finished job.
 */
export interface JobTerminalOutcome {
  jobId: string;
  status: JobTerminalStatus;
  result?: unknown;
  job: CommerceJob;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when a tracked job reaches a terminal failure state ("failed" or "cancelled").
 */
export class JobTerminalError extends TalosAPIError {
  public readonly jobId: string;
  public readonly terminalStatus: string;
  public readonly job?: unknown;

  constructor(
    jobId: string,
    status: string,
    job?: unknown,
    options?: { message?: string },
  ) {
    const msg = options?.message ?? `Job ${jobId} ended with status: ${status}`;
    super(0, msg, `/api/jobs/${encodeURIComponent(jobId)}/result`, {
      message: msg,
      code: "api_error",
      cause: job,
    });
    this.name = "JobTerminalError";
    this.jobId = jobId;
    this.terminalStatus = status;
    this.job = job;
  }
}

/**
 * Thrown when a tracked job ends with status "failed".
 */
export class JobFailedError extends JobTerminalError {
  constructor(jobId: string, job?: unknown) {
    super(jobId, "failed", job);
    this.name = "JobFailedError";
  }
}

/**
 * Thrown when a tracked job ends with status "cancelled".
 */
export class JobCancelledError extends JobTerminalError {
  constructor(jobId: string, job?: unknown) {
    super(jobId, "cancelled", job);
    this.name = "JobCancelledError";
  }
}

/**
 * Thrown when job tracking is aborted by an AbortSignal.
 */
export class JobTrackAbortedError extends TalosTimeoutError {
  public readonly jobId: string;
  constructor(jobId: string, message = `Tracking for job ${jobId} was aborted`) {
    super(0, message, `/api/jobs/${encodeURIComponent(jobId)}/progress`, { message });
    this.name = "JobTrackAbortedError";
    this.jobId = jobId;
  }
}

/**
 * Thrown when job tracking exceeds its timeout deadline.
 */
export class JobTrackTimeoutError extends TalosTimeoutError {
  public readonly jobId: string;
  constructor(jobId: string, timeoutMs: number) {
    const message = `Tracking for job ${jobId} timed out after ${timeoutMs}ms`;
    super(0, message, `/api/jobs/${encodeURIComponent(jobId)}/progress`, { message });
    this.name = "JobTrackTimeoutError";
    this.jobId = jobId;
  }
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface TrackJobOptions {
  /**
   * External cancellation signal. When aborted, streaming and polling stop,
   * timers are cleared, and the iterator ends or rejects with TalosTimeoutError.
   */
  signal?: AbortSignal;

  /**
   * Overall wall-clock timeout in milliseconds for tracking.
   * Surfaces as {@link JobTrackTimeoutError} when exceeded.
   */
  timeoutMs?: number;

  /**
   * Initial polling backoff interval in milliseconds.
   * Default: 500ms.
   */
  intervalMs?: number;

  /**
   * Maximum polling backoff interval in milliseconds.
   * Default: 10_000ms.
   */
  maxIntervalMs?: number;

  /**
   * Backoff multiplier for consecutive polls. Default: 2.
   */
  backoffMultiplier?: number;

  /**
   * Optional custom SeenStore for cross-reconnect duplicate suppression.
   * Default: InMemorySeenStore.
   */
  seenStore?: SeenStore;

  /**
   * Optional chaos injector for testing stream disconnects and transport faults.
   */
  chaosInjector?: ChaosInjector;

  /**
   * Optional fetch implementation override.
   */
  fetch?: typeof globalThis.fetch;

  /**
   * SSE path override (relative to client's baseUrl).
   * Default: `/api/jobs/${jobId}/progress`
   */
  path?: string;

  /**
   * Privacy-safe logger.
   */
  logger?: Logger;

  /**
   * Whether to throw when the job ends in "failed" or "cancelled".
   * When true (default), throws JobFailedError or JobCancelledError.
   * When false, yields the terminal result and completes.
   * Default: true.
   */
  throwOnTerminalError?: boolean;

  /**
   * Maximum SSE reconnect attempts before permanently switching to polling.
   * Default: 5.
   */
  maxStreamReconnectAttempts?: number;

  /**
   * Whether to prefer SSE first before falling back to polling.
   * Default: true. Set to false to disable SSE and use polling only.
   */
  preferSse?: boolean;

  /** Base URL override (used when trackJob is called standalone without a client). */
  baseUrl?: string;

  /** Auth header override (e.g. `"Bearer <token>"`). */
  authHeader?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Internal queue entry for async iterator buffering. */
type QueueEntry<T, R> =
  | { kind: "value"; value: T }
  | { kind: "return"; value: R }
  | { kind: "error"; error: unknown };

/**
 * Deterministic fingerprint for a progress update to ensure de-duplication
 * between SSE and polling.
 */
function computeEventFingerprint(
  jobId: string,
  event: {
    id?: string;
    status: string;
    percent?: number | null;
    stage?: string | null;
    message?: string | null;
    updatedAt?: string;
    hasResult?: boolean;
  },
): string {
  if (event.id) {
    return `${jobId}:id:${event.id}`;
  }
  const s = event.status ?? "";
  const p = event.percent != null ? String(event.percent) : "";
  const st = event.stage ?? "";
  const m = event.message ?? "";
  const u = event.updatedAt ?? "";
  const r = event.hasResult ? "1" : "0";
  return `${jobId}:fp:${s}|${p}|${st}|${m}|${u}|${r}`;
}

// ── JobTracker Class ──────────────────────────────────────────────────────────

/**
 * Async iterator following a purchased job to completion.
 *
 * Implements `AsyncIterableIterator<TrackJobEvent, CommerceJob>`:
 * - In `for await (const event of tracker)`: yields ordered, deduplicated progress events
 *   and concludes with the final result event.
 * - On `const { value, done } = await tracker.next()`: when `done: true`, `value` is the final `CommerceJob`.
 * - Property `tracker.result`: a Promise resolving to the final `CommerceJob`.
 */
export class JobTracker implements AsyncIterableIterator<TrackJobEvent, CommerceJob> {
  public readonly jobId: string;
  public readonly result: Promise<CommerceJob>;

  private resolveResult!: (job: CommerceJob) => void;
  private rejectResult!: (err: unknown) => void;

  private readonly client: TalosClient;
  private readonly options: TrackJobOptions;
  private readonly seenStore: SeenStore;
  private readonly baseUrl: string;
  private readonly authHeader: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly fetchFn: typeof globalThis.fetch;

  private readonly abortController = new AbortController();
  private readonly activeTimers = new Set<ReturnType<typeof setTimeout>>();

  // Iterator queue
  private readonly queue: QueueEntry<TrackJobEvent, CommerceJob>[] = [];
  private readonly waitingResolvers: Array<
    (entry: QueueEntry<TrackJobEvent, CommerceJob>) => void
  > = [];

  // Lifecycle flags
  private isTerminal = false;
  private isClosed = false;
  private isPolling = false;
  private isFallbackEngaged = false;

  private stream?: TalosEventStream;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private lastSeenResult?: unknown;
  private lastSeenJob?: unknown;

  constructor(client: TalosClient, jobId: string, options: TrackJobOptions = {}) {
    this.client = client;
    this.jobId = jobId;
    this.options = options;
    this.logger = options.logger;

    // Resolve connection config from client or options
    const clientAny = client as any;
    this.baseUrl = (options.baseUrl ?? clientAny.getBaseUrl?.() ?? clientAny.baseUrl ?? "https://talos-stellar.vercel.app").replace(/\/$/, "");
    this.authHeader = options.authHeader ?? clientAny.getAuthHeader?.() ?? clientAny.headers?.["Authorization"];
    this.fetchFn = options.fetch ?? clientAny.getFetch?.() ?? clientAny.fetchOverride ?? globalThis.fetch;

    this.seenStore = options.seenStore ?? new InMemorySeenStore();

    // Setup result promise
    this.result = new Promise<CommerceJob>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Suppress unhandled rejection on this.result if caller only consumes for-await
    this.result.catch(() => {});

    // Check pre-existing abort
    if (options.signal?.aborted) {
      const err = new JobTrackAbortedError(this.jobId, "trackJob aborted before starting");
      this.handleAbort(err);
      return;
    }

    // Attach external signal listener
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => this.handleAbort(new JobTrackAbortedError(this.jobId, "trackJob aborted")),
        { once: true },
      );
    }

    // Wall-clock deadline timer
    if (options.timeoutMs != null && options.timeoutMs > 0) {
      const ms = options.timeoutMs;
      this.deadlineTimer = setTimeout(() => {
        this.handleAbort(new JobTrackTimeoutError(this.jobId, ms));
      }, ms);
      this.activeTimers.add(this.deadlineTimer);
    }

    // Start tracking
    this.start();
  }

  /**
   * Whether fallback polling has engaged due to stream error or disconnect.
   */
  get fallbackEngaged(): boolean {
    return this.isFallbackEngaged;
  }

  // ── AsyncIterator Protocol ──────────────────────────────────────────────────

  [Symbol.asyncIterator](): this {
    return this;
  }

  async next(): Promise<IteratorResult<TrackJobEvent, CommerceJob>> {
    const entry = await this.dequeue();
    if (entry.kind === "value") {
      return { done: false, value: entry.value };
    }
    if (entry.kind === "return") {
      return { done: true, value: entry.value };
    }
    throw entry.error;
  }

  async return(value?: CommerceJob | PromiseLike<CommerceJob>): Promise<IteratorResult<TrackJobEvent, CommerceJob>> {
    this.cleanup();
    const resolved = await Promise.resolve(value as CommerceJob);
    return { done: true, value: resolved };
  }

  async throw(e?: unknown): Promise<IteratorResult<TrackJobEvent, CommerceJob>> {
    this.cleanup();
    throw e;
  }

  /** Manually abort tracking. Cleans up streams, polling, and timers. */
  abort(reason?: unknown): void {
    const err = reason instanceof Error ? reason : new JobTrackAbortedError(this.jobId);
    this.handleAbort(err);
  }

  // ── Queue Management ────────────────────────────────────────────────────────

  private enqueue(entry: QueueEntry<TrackJobEvent, CommerceJob>): void {
    if (this.isClosed && entry.kind !== "error") {
      return;
    }
    const resolver = this.waitingResolvers.shift();
    if (resolver) {
      resolver(entry);
    } else {
      this.queue.push(entry);
    }
  }

  private dequeue(): Promise<QueueEntry<TrackJobEvent, CommerceJob>> {
    const entry = this.queue.shift();
    if (entry) {
      return Promise.resolve(entry);
    }
    return new Promise((resolve) => {
      this.waitingResolvers.push(resolve);
    });
  }

  // ── Connection & Streaming ──────────────────────────────────────────────────

  private start(): void {
    if (this.isClosed || this.isTerminal) return;

    if (this.options.preferSse === false) {
      this.startFallbackPolling();
      return;
    }

    const clientAny = this.client as any;
    const chaos = this.options.chaosInjector ?? clientAny.getChaosInjector?.() ?? clientAny.chaosInjector;

    try {
      this.stream = new TalosEventStream(this.baseUrl, {
        path: this.options.path ?? `/api/jobs/${encodeURIComponent(this.jobId)}/progress`,
        authHeader: this.authHeader,
        signal: this.abortController.signal,
        chaosInjector: chaos,
        fetch: this.fetchFn,
        logger: this.logger,
        maxReconnectAttempts: this.options.maxStreamReconnectAttempts ?? 5,
        seenStore: this.seenStore,
      });

      this.stream.on("event", (evt) => {
        void this.handleStreamEvent(evt);
      });

      this.stream.on("error", (err, attempt) => {
        this.logger?.warn("track_job:stream_error", {
          jobId: this.jobId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
        // Acceptance criteria: Fallback engages on stream errors
        this.isFallbackEngaged = true;
        this.startFallbackPolling();
      });

      this.stream.on("close", () => {
        if (!this.isTerminal && !this.isClosed) {
          this.logger?.info("track_job:stream_closed_falling_back", { jobId: this.jobId });
          this.isFallbackEngaged = true;
          this.startFallbackPolling();
        }
      });

      this.stream.connect();
    } catch (err) {
      this.logger?.warn("track_job:stream_connect_failed", {
        jobId: this.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.isFallbackEngaged = true;
      this.startFallbackPolling();
    }
  }

  private async handleStreamEvent(evt: TalosStreamEvent): Promise<void> {
    if (this.isTerminal || this.isClosed) return;
    if (evt.type === "ping" || evt.type === "heartbeat") return;

    let payload: any;
    try {
      payload = JSON.parse(evt.data);
    } catch {
      payload = { message: evt.data };
    }

    if (evt.type === "done") {
      const status = payload?.status ?? "completed";
      if (status === "completed") {
        await this.completeJob({
          status: "completed",
          result: payload?.result ?? this.lastSeenResult,
          job: this.lastSeenJob,
          source: "stream",
        });
      } else {
        await this.failJob(status, payload);
      }
      return;
    }

    const status = payload?.status ?? "pending";
    const progressDetails = payload?.progress ?? null;
    const percent = typeof progressDetails?.percent === "number" ? progressDetails.percent : null;
    const stage = typeof progressDetails?.stage === "string" ? progressDetails.stage : null;
    const message = typeof progressDetails?.message === "string" ? progressDetails.message : null;
    const result = payload?.result;

    if (result !== undefined && result !== null) {
      this.lastSeenResult = result;
    }
    this.lastSeenJob = payload;

    const dedupKey = computeEventFingerprint(this.jobId, {
      id: evt.id,
      status,
      percent,
      stage,
      message,
      updatedAt: progressDetails?.updatedAt ?? payload?.updatedAt,
      hasResult: result !== undefined && result !== null,
    });

    if (await this.seenStore.has(dedupKey)) {
      return;
    }
    await this.seenStore.add(dedupKey);
    if (evt.id) {
      await this.seenStore.add(`${this.jobId}:id:${evt.id}`);
    }

    if (status === "completed") {
      await this.completeJob({
        status: "completed",
        result: result ?? payload?.result,
        job: payload,
        source: "stream",
        percent: percent ?? 100,
        stage: stage ?? "completed",
        message,
      });
      return;
    }

    if (status === "failed" || status === "cancelled") {
      await this.failJob(status, payload);
      return;
    }

    const event: TrackJobEvent = {
      type: evt.type === "snapshot" ? "snapshot" : "progress",
      jobId: this.jobId,
      status,
      progress: progressDetails ? {
        percent,
        stage,
        message,
        updatedAt: progressDetails.updatedAt,
        reportedBy: progressDetails.reportedBy,
      } : null,
      percent,
      stage,
      message,
      source: "stream",
      receivedAt: evt.receivedAt ?? new Date(),
      raw: payload,
    };

    this.enqueue({ kind: "value", value: event });
  }

  // ── Polling Fallback ────────────────────────────────────────────────────────

  private startFallbackPolling(): void {
    if (this.isPolling || this.isTerminal || this.isClosed) {
      return;
    }
    this.isPolling = true;
    void this.runPollingLoop();
  }

  private async runPollingLoop(): Promise<void> {
    let interval = Math.max(50, this.options.intervalMs ?? 500);
    const maxInterval = this.options.maxIntervalMs ?? 10_000;
    const multiplier = this.options.backoffMultiplier ?? 2;

    while (!this.isTerminal && !this.isClosed) {
      if (this.abortController.signal.aborted) {
        break;
      }

      try {
        const job = await this.client.getJobResult(this.jobId, {
          signal: this.abortController.signal,
        });

        if (this.isTerminal || this.isClosed) break;

        await this.handleJobPollResult(job);

        if (this.isTerminal) break;
      } catch (err) {
        if (this.isTerminal || this.isClosed) break;
        if (this.abortController.signal.aborted) break;

        this.logger?.warn("track_job:poll_error", {
          jobId: this.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (this.isTerminal || this.isClosed) break;

      await this.sleep(interval);

      interval = Math.min(
        Math.round(interval * multiplier * (0.75 + 0.25 * Math.random())),
        maxInterval,
      );
    }
  }

  private async handleJobPollResult(job: CommerceJob): Promise<void> {
    const rawAny = job as any;
    const status = job.status ?? "pending";
    const progressDetails = rawAny.progress ?? null;
    const percent = typeof progressDetails?.percent === "number" ? progressDetails.percent : null;
    const stage = typeof progressDetails?.stage === "string" ? progressDetails.stage : null;
    const message = typeof progressDetails?.message === "string" ? progressDetails.message : null;
    const result = job.result;

    if (result !== undefined && result !== null) {
      this.lastSeenResult = result;
    }
    this.lastSeenJob = job;

    const dedupKey = computeEventFingerprint(this.jobId, {
      status,
      percent,
      stage,
      message,
      updatedAt: progressDetails?.updatedAt ?? job.updatedAt,
      hasResult: result !== undefined && result !== null,
    });

    if (status === "completed") {
      await this.completeJob({
        status: "completed",
        result,
        job,
        source: "poll",
        percent: percent ?? 100,
        stage: stage ?? "completed",
        message,
      });
      return;
    }

    if (status === "failed" || status === "cancelled") {
      await this.failJob(status, job);
      return;
    }

    if (await this.seenStore.has(dedupKey)) {
      return;
    }
    await this.seenStore.add(dedupKey);

    const event: TrackJobEvent = {
      type: "poll",
      jobId: this.jobId,
      status,
      progress: progressDetails ? {
        percent,
        stage,
        message,
        updatedAt: progressDetails.updatedAt,
        reportedBy: progressDetails.reportedBy,
      } : null,
      percent,
      stage,
      message,
      source: "poll",
      receivedAt: new Date(),
      raw: job,
    };

    this.enqueue({ kind: "value", value: event });
  }

  // ── Terminal Outcomes ───────────────────────────────────────────────────────

  private async completeJob(details: {
    status: string;
    result?: unknown;
    job?: any;
    source: "stream" | "poll";
    percent?: number | null;
    stage?: string | null;
    message?: string | null;
  }): Promise<void> {
    if (this.isTerminal) return;
    this.isTerminal = true;

    let finalJob: CommerceJob;
    if (details.job && details.job.id && details.result !== undefined) {
      finalJob = {
        talosId: details.job.talosId ?? "",
        requesterTalosId: details.job.requesterTalosId ?? "",
        serviceName: details.job.serviceName ?? "",
        amount: details.job.amount ?? "0",
        createdAt: details.job.createdAt ?? new Date().toISOString(),
        updatedAt: details.job.updatedAt ?? new Date().toISOString(),
        ...details.job,
        id: this.jobId,
        status: details.status,
        result: details.result ?? details.job.result,
      };
    } else {
      try {
        finalJob = await this.client.getJobResult(this.jobId, {
          signal: this.abortController.signal,
        });
      } catch {
        finalJob = {
          id: this.jobId,
          status: details.status,
          result: details.result,
          talosId: "",
          requesterTalosId: "",
          serviceName: "",
          amount: "0",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    }

    const resultEvent: TrackJobEvent = {
      type: "result",
      jobId: this.jobId,
      status: "completed",
      progress: {
        percent: details.percent ?? 100,
        stage: details.stage ?? "completed",
        message: details.message ?? null,
      },
      percent: details.percent ?? 100,
      stage: details.stage ?? "completed",
      message: details.message ?? null,
      result: finalJob.result ?? details.result,
      source: details.source,
      receivedAt: new Date(),
      raw: finalJob,
    };

    this.enqueue({ kind: "value", value: resultEvent });
    this.enqueue({ kind: "return", value: finalJob });
    this.resolveResult(finalJob);
    this.cleanup();
  }

  private async failJob(status: string, job?: any): Promise<void> {
    if (this.isTerminal) return;
    this.isTerminal = true;
    this.cleanup();

    const commerceJob: CommerceJob = {
      id: this.jobId,
      status,
      result: job?.result,
      talosId: job?.talosId ?? "",
      requesterTalosId: job?.requesterTalosId ?? "",
      serviceName: job?.serviceName ?? "",
      amount: job?.amount ?? "0",
      createdAt: job?.createdAt ?? new Date().toISOString(),
      updatedAt: job?.updatedAt ?? new Date().toISOString(),
      ...job,
    };

    const error = status === "cancelled"
      ? new JobCancelledError(this.jobId, commerceJob)
      : new JobFailedError(this.jobId, commerceJob);

    if (this.options.throwOnTerminalError !== false) {
      this.enqueue({ kind: "error", error });
      this.rejectResult(error);
    } else {
      const event: TrackJobEvent = {
        type: "result",
        jobId: this.jobId,
        status,
        progress: null,
        percent: null,
        stage: status,
        message: null,
        result: commerceJob.result,
        source: "stream",
        receivedAt: new Date(),
        raw: commerceJob,
      };
      this.enqueue({ kind: "value", value: event });
      this.enqueue({ kind: "return", value: commerceJob });
      this.resolveResult(commerceJob);
    }
  }

  // ── Abort & Cleanup ─────────────────────────────────────────────────────────

  private handleAbort(error: unknown): void {
    if (this.isClosed || this.isTerminal) return;
    this.isClosed = true;
    this.isTerminal = true;
    this.cleanup();
    this.enqueue({ kind: "error", error });
    this.rejectResult(error);
  }

  private sleep(ms: number): Promise<void> {
    if (this.abortController.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          this.activeTimers.delete(timer);
        }
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      };

      timer = setTimeout(() => {
        if (timer !== undefined) this.activeTimers.delete(timer);
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      this.activeTimers.add(timer);
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private cleanup(): void {
    if (this.stream) {
      try {
        this.stream.close();
      } catch {
        // ignore
      }
    }
    for (const t of this.activeTimers) {
      clearTimeout(t);
    }
    this.activeTimers.clear();
    this.abortController.abort();
  }
}

// ── Standalone Helper ─────────────────────────────────────────────────────────

/**
 * Follow a purchased job to completion with progress streaming and polling fallback.
 *
 * @example
 * ```ts
 * for await (const event of trackJob(client, jobId, { signal })) {
 *   console.log(`Job ${event.jobId}: ${event.percent}% - ${event.stage}`);
 * }
 * ```
 */
export function trackJob(
  client: TalosClient,
  jobId: string,
  options?: TrackJobOptions,
): JobTracker;
export function trackJob(
  jobId: string,
  options?: TrackJobOptions & { client?: TalosClient },
): JobTracker;
export function trackJob(
  clientOrJobId: TalosClient | string,
  jobIdOrOptions?: string | (TrackJobOptions & { client?: TalosClient }),
  maybeOptions?: TrackJobOptions,
): JobTracker {
  if (typeof clientOrJobId === "string") {
    const jobId = clientOrJobId;
    const opts = (jobIdOrOptions as (TrackJobOptions & { client?: TalosClient })) ?? {};
    if (!opts.client) {
      throw new TypeError("trackJob requires a TalosClient instance (pass as first argument or options.client)");
    }
    return new JobTracker(opts.client, jobId, opts);
  }
  const client = clientOrJobId;
  const jobId = jobIdOrOptions as string;
  return new JobTracker(client, jobId, maybeOptions);
}
