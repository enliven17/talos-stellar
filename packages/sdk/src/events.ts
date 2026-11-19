/**
 * TalosEventStream — browser and Node-compatible SSE client for the Talos platform event stream.
 *
 * Design properties:
 * - Uses the Fetch API to open a text/event-stream connection; works in browsers and Node ≥18.
 * - Sends `Last-Event-ID` on every reconnect so the server can resume from the last seen event.
 * - Exponential backoff with jitter and a configurable cap; respects `retry:` field from server.
 * - Heartbeat detection: treats N consecutive comment-only ticks as a stall and reconnects.
 * - Duplicate suppression: an optional SeenStore lets callers skip already-processed event IDs.
 * - Abort/close: the stream can be cancelled at any time via `close()` or an external AbortSignal.
 * - Auth: reads the Bearer token from TalosClient options; never logged.
 * - Observability: privacy-safe structured log calls — no payloads or credentials are emitted.
 * - All resource consumption is bounded: reconnect budget, max delay, heartbeat window.
 */

import type { Logger } from "./webhooks.js";
import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

// ── Public event types ─────────────────────────────────────────────────────────

/** All well-known event types the Talos platform emits on the event stream. */
export type TalosEventType =
  | "activity.created"
  | "approval.created"
  | "approval.decided"
  | "revenue.recorded"
  | "job.created"
  | "job.completed"
  | "job.failed"
  | "talos.status_changed"
  | "heartbeat"
  | (string & {}); // allow unknown future events without losing type narrowing on known ones

/** A parsed SSE event delivered to the caller. */
export interface TalosStreamEvent {
  /** The SSE `id:` field — used for Last-Event-ID on reconnect. May be absent. */
  id: string | undefined;
  /** The SSE `event:` field. Defaults to `"message"` if the server omits it. */
  type: TalosEventType;
  /** The SSE `data:` field, concatenated across multi-line data blocks. */
  data: string;
  /** Wall-clock time the event was received by the client. */
  receivedAt: Date;
}

/** Callback invoked for each deduplicated, non-heartbeat event. */
export type TalosEventHandler = (
  event: TalosStreamEvent,
) => void | Promise<void>;

/** Callback invoked when the stream enters an error state before a reconnect attempt. */
export type TalosStreamErrorHandler = (error: unknown, attempt: number) => void;

/** Callback invoked when the stream closes permanently (abort or budget exhausted). */
export type TalosStreamCloseHandler = () => void;

// ── Duplicate suppression ──────────────────────────────────────────────────────

/**
 * Optional store to suppress duplicate events across reconnects.
 * The in-memory default is sufficient for process lifetime dedup;
 * supply a persistent implementation (Redis, DB) for cross-restart guarantees.
 */
export interface SeenStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

/** Simple bounded in-memory SeenStore (LRU eviction when capacity is reached). */
export class InMemorySeenStore implements SeenStore {
  private readonly ids: string[] = [];
  constructor(private readonly capacity: number = 10_000) {}

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  add(id: string): void {
    if (this.ids.length >= this.capacity) {
      this.ids.splice(0, Math.ceil(this.capacity * 0.1)); // evict oldest 10%
    }
    this.ids.push(id);
  }
}

// ── Resumable checkpoint ───────────────────────────────────────────────────────

/**
 * A persisted checkpoint capturing the last acknowledged event identity for a
 * stream. The stream loads this on connect so resumption survives process
 * restarts, and saves an updated checkpoint after every acknowledged event.
 */
export interface EventStreamCheckpoint {
  /** The SSE `id:` of the last acknowledged event. Drives `Last-Event-ID`. */
  eventId: string;
  /**
   * Monotonic ordering hint when the server provides one (parsed from the
   * event payload). Informational; the stream does not require it to resume.
   */
  sequence?: number;
  /** ISO 8601 timestamp captured when the checkpoint was recorded. */
  recordedAt: string;
  /**
   * `true` when the resume that produced this checkpoint detected a
   * server-side history gap (the server could not replay from the prior
   * cursor). Lets callers distinguish a clean resume from a gap recovery.
   */
  hadHistoryGap?: boolean;
}

/** How the server signalled a history gap on reconnect. */
export type HistoryGapSignal = "response-header" | "event";

/**
 * Information surfaced to {@link TalosEventStreamOptions.onHistoryGap} when the
 * stream detects that the server could not replay history from the last
 * checkpoint, distinguishing a history gap from an ordinary reconnect.
 */
export interface HistoryGapInfo {
  /** The checkpoint the stream attempted to resume from, if any. */
  requestedAfterEventId?: string;
  /** How the gap was signalled. */
  signal: HistoryGapSignal;
  /** Server-supplied reason, when present. */
  reason?: string;
  /** The earliest event id the server can currently replay, if provided. */
  firstAvailableEventId?: string;
  /** ISO 8601 timestamp the gap was detected. */
  detectedAt: string;
}

/**
 * Caller-supplied durable store for the last acknowledged event identity.
 *
 * Used by {@link TalosEventStream} so resume cursors survive process restarts.
 * The stream calls `load()` once on connect to seed `Last-Event-ID`, and
 * `save()` after every acknowledged event (in `"auto"` ack mode) or when the
 * caller calls {@link TalosEventStream.acknowledge} (in `"manual"` mode).
 *
 * Implementations must not throw from `load` / `save` / `clear` — a thrown
 * error is swallowed and treated as "no checkpoint available" so a
 * misbehaving store never wedges the stream.
 */
export interface CheckpointStore {
  /** Load the persisted checkpoint, or `undefined` when none exists. */
  load(): Promise<EventStreamCheckpoint | undefined>;
  /** Persist (overwrite) the current checkpoint. */
  save(checkpoint: EventStreamCheckpoint): Promise<void>;
  /** Drop the persisted checkpoint. */
  clear(): Promise<void>;
}

/** When the stream persists a checkpoint. See {@link TalosEventStreamOptions.ackMode}. */
export type CheckpointAckMode = "auto" | "manual";

/**
 * Simple in-memory {@link CheckpointStore} for process-lifetime resume.
 * Supply a persistent implementation (DB, Redis, file) for cross-restart
 * guarantees. Methods are async to match the {@link CheckpointStore} contract.
 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private checkpoint?: EventStreamCheckpoint;
  async load(): Promise<EventStreamCheckpoint | undefined> {
    return this.checkpoint;
  }
  async save(checkpoint: EventStreamCheckpoint): Promise<void> {
    this.checkpoint = { ...checkpoint };
  }
  async clear(): Promise<void> {
    this.checkpoint = undefined;
  }
}

// ── Configuration ──────────────────────────────────────────────────────────────

export interface TalosEventStreamOptions {
  /**
   * The platform event-stream URL path (relative to the client's baseUrl).
   * @default "/api/events"
   */
  path?: string;

  /**
   * Auth header value — typically `"Bearer <key>"`.
   * When not set, no Authorization header is sent.
   */
  authHeader?: string;

  /** Reconnect budget — maximum number of reconnect attempts before giving up. @default 10 */
  maxReconnectAttempts?: number;

  /** Base reconnect delay in milliseconds. @default 1000 */
  baseReconnectDelayMs?: number;

  /** Maximum reconnect delay in milliseconds. @default 30_000 */
  maxReconnectDelayMs?: number;

  /** Whether to apply full jitter to reconnect delays. @default true */
  jitter?: boolean;

  /**
   * Number of consecutive heartbeat ticks (comment lines / `event: heartbeat`) with no
   * data events before the client treats the connection as stalled and reconnects.
   * @default 3
   */
  maxHeartbeatMisses?: number;

  /**
   * Interval in milliseconds at which the heartbeat watchdog fires.
   * @default 30_000
   */
  heartbeatIntervalMs?: number;

  /** Optional store for duplicate-event suppression. */
  seenStore?: SeenStore;

  /**
   * Optional durable checkpoint store for cross-restart resume. When set,
   * the stream seeds `Last-Event-ID` from the persisted checkpoint on connect
   * and persists an updated checkpoint after every acknowledged event, so a
   * process restart resumes from the last acknowledged event identity rather
   * than the live (in-memory) cursor.
   *
   * Omitting it preserves the prior in-memory-only behavior.
   */
  checkpointStore?: CheckpointStore;

  /**
   * When to persist a checkpoint to {@link TalosEventStreamOptions.checkpointStore}.
   *
   * - `"auto"` (default): persist after every delivered, non-duplicate event.
   * - `"manual"`: only persist when the caller calls
   *   {@link TalosEventStream.acknowledge} with the event id it has processed.
   *
   * Has no effect when `checkpointStore` is not set.
   */
  ackMode?: CheckpointAckMode;

  /**
   * Handler invoked when the stream detects a server-side history gap on
   * reconnect (the server could not replay from the last checkpoint). Lets
   * callers distinguish a history gap from an ordinary (replayable) reconnect.
   * Invoked fire-and-forget and must not throw.
   */
  onHistoryGap?: (info: HistoryGapInfo) => void;

  /** Privacy-safe logger. Payloads and credentials are never passed to it. */
  logger?: Logger;

  /** External AbortSignal — closing this also closes the stream. */
  signal?: AbortSignal;

  /** Seeded random function, for deterministic tests. @default Math.random */
  random?: () => number;

  /** Fetch implementation override (for testing). @default globalThis.fetch */
  fetch?: typeof globalThis.fetch;

  /** Optional chaos injector for fault injection during SSE connections. */
  chaosInjector?: ChaosInjector;
}

// ── Internal state ─────────────────────────────────────────────────────────────

type StreamState = "idle" | "connecting" | "open" | "reconnecting" | "closed";
const StreamState = {
  Idle: "idle" as StreamState,
  Connecting: "connecting" as StreamState,
  Open: "open" as StreamState,
  Reconnecting: "reconnecting" as StreamState,
  Closed: "closed" as StreamState,
};

// ── Main class ─────────────────────────────────────────────────────────────────

/**
 * Long-lived SSE client for the Talos platform event stream.
 *
 * Usage:
 * ```ts
 * const stream = new TalosEventStream("https://talos-stellar.vercel.app", {
 *   authHeader: "Bearer my-api-key",
 * });
 * stream.on("event", (evt) => console.log(evt));
 * stream.on("error", (err, attempt) => console.error(err, attempt));
 * stream.on("close", () => console.log("stream closed"));
 * stream.connect();
 * ```
 */
export class TalosEventStream {
  private readonly baseUrl: string;
  private readonly opts: Required<
    Omit<
      TalosEventStreamOptions,
      | "authHeader"
      | "seenStore"
      | "logger"
      | "signal"
      | "fetch"
      | "chaosInjector"
      | "checkpointStore"
      | "onHistoryGap"
    >
  > &
    Pick<
      TalosEventStreamOptions,
      | "authHeader"
      | "seenStore"
      | "logger"
      | "signal"
      | "fetch"
      | "chaosInjector"
      | "checkpointStore"
      | "onHistoryGap"
    >;

  private state: StreamState = StreamState.Idle;
  private lastEventId: string | undefined;
  private reconnectAttempt = 0;
  /**
   * Whether the current connection's resume detected a server-side history
   * gap. Reset to `false` at the start of every connection; set to `true` when
   * a gap is signalled (response header or `event: history.gap`). Recorded on
   * each persisted checkpoint so callers can distinguish a clean resume from a
   * gap recovery.
   */
  private lastResumeHadHistoryGap = false;

  // heartbeat watchdog
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatMisses = 0;

  // internal abort for this stream instance
  private readonly controller = new AbortController();

  // event handlers
  private readonly eventHandlers = new Set<TalosEventHandler>();
  private readonly errorHandlers = new Set<TalosStreamErrorHandler>();
  private readonly closeHandlers = new Set<TalosStreamCloseHandler>();

  constructor(baseUrl: string, opts: TalosEventStreamOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.opts = {
      path: opts.path ?? "/api/events",
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
      baseReconnectDelayMs: opts.baseReconnectDelayMs ?? 1000,
      maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 30_000,
      jitter: opts.jitter ?? true,
      maxHeartbeatMisses: opts.maxHeartbeatMisses ?? 3,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30_000,
      random: opts.random ?? Math.random,
      authHeader: opts.authHeader,
      seenStore: opts.seenStore,
      logger: opts.logger,
      signal: opts.signal,
      fetch: opts.fetch,
      chaosInjector: opts.chaosInjector,
      ackMode: opts.ackMode ?? "auto",
      checkpointStore: opts.checkpointStore,
      onHistoryGap: opts.onHistoryGap,
    };

    // Forward external abort
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => this.close(), { once: true });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Register a handler for stream events. Returns `this` for chaining. */
  on(event: "event", handler: TalosEventHandler): this;
  on(event: "error", handler: TalosStreamErrorHandler): this;
  on(event: "close", handler: TalosStreamCloseHandler): this;
  on(event: string, handler: unknown): this {
    if (event === "event") this.eventHandlers.add(handler as TalosEventHandler);
    else if (event === "error")
      this.errorHandlers.add(handler as TalosStreamErrorHandler);
    else if (event === "close")
      this.closeHandlers.add(handler as TalosStreamCloseHandler);
    return this;
  }

  /** Remove a previously registered handler. */
  off(event: "event", handler: TalosEventHandler): this;
  off(event: "error", handler: TalosStreamErrorHandler): this;
  off(event: "close", handler: TalosStreamCloseHandler): this;
  off(event: string, handler: unknown): this {
    if (event === "event")
      this.eventHandlers.delete(handler as TalosEventHandler);
    else if (event === "error")
      this.errorHandlers.delete(handler as TalosStreamErrorHandler);
    else if (event === "close")
      this.closeHandlers.delete(handler as TalosStreamCloseHandler);
    return this;
  }

  /** Start the stream. Safe to call multiple times — ignored if already open/connecting. */
  connect(): void {
    if (
      this.state === StreamState.Open ||
      this.state === StreamState.Connecting ||
      this.state === StreamState.Closed
    ) {
      return;
    }
    this.reconnectAttempt = 0;
    void this.run();
  }

  /** Permanently close the stream. No reconnects will be attempted after this. */
  close(): void {
    if (this.state === StreamState.Closed) return;
    this._setState(StreamState.Closed);
    this.controller.abort();
    this._clearHeartbeatTimer();
    this._emitClose();
  }

  /** Current connection state, primarily for testing and observability. */
  get connectionState(): string {
    return this.state;
  }

  /** The last event ID seen — sent as `Last-Event-ID` on reconnect. */
  get lastSeenEventId(): string | undefined {
    return this.lastEventId;
  }

  /**
   * Whether the current connection's resume detected a server-side history
   * gap (the server could not replay from the last checkpoint). Reset to
   * `false` on each new connection. Useful for observability; callers that
   * need to react should use {@link TalosEventStreamOptions.onHistoryGap}.
   */
  get hadHistoryGapOnLastResume(): boolean {
    return this.lastResumeHadHistoryGap;
  }

  /**
   * Manually acknowledge that an event has been processed, persisting a
   * checkpoint to {@link TalosEventStreamOptions.checkpointStore}.
   *
   * Only effective in `"manual"` ack mode with a configured checkpoint store.
   * In `"auto"` mode (the default) checkpoints are persisted automatically
   * after every delivered event and this call is a no-op.
   *
   * Never throws — a failing store is swallowed so processing is never wedged.
   */
  async acknowledge(eventId: string): Promise<void> {
    if (this.opts.ackMode !== "manual" || !this.opts.checkpointStore) return;
    if (typeof eventId !== "string" || eventId === "") return;
    await this._persistCheckpoint(eventId);
  }

  // ── Internal connection loop ───────────────────────────────────────────────

  private async run(): Promise<void> {
    // Seed the resume cursor from the durable checkpoint so a fresh process
    // resumes from the last acknowledged event identity rather than starting
    // live. Done once, before the reconnect loop, so mid-loop reconnects keep
    // using the in-memory cursor that the stream keeps up to date.
    await this._loadCheckpoint();
    while (
      this.state !== StreamState.Closed &&
      this.reconnectAttempt <= this.opts.maxReconnectAttempts
    ) {
      this._setState(
        this.reconnectAttempt === 0
          ? StreamState.Connecting
          : StreamState.Reconnecting,
      );
      this.opts.logger?.info("sse:connecting", {
        attempt: this.reconnectAttempt,
        lastEventId: this.lastEventId ?? null,
      });

      try {
        await this._openConnection();
        // Clean exit from connection — break only if closed externally
        if (this.state === StreamState.Closed) break;
        // Server closed the stream; treat as recoverable
        this._emitError(
          new Error("Server closed the SSE stream"),
          this.reconnectAttempt,
        );
      } catch (err) {
        if (this.state === StreamState.Closed) break;
        this._emitError(err, this.reconnectAttempt);
        this.opts.logger?.warn("sse:error", {
          attempt: this.reconnectAttempt,
          errorType: err instanceof Error ? err.constructor.name : typeof err,
        });
      } finally {
        this._clearHeartbeatTimer();
      }

      this.reconnectAttempt += 1;

      if (
        this.state !== StreamState.Closed &&
        this.reconnectAttempt <= this.opts.maxReconnectAttempts
      ) {
        const delay = this._reconnectDelay(this.reconnectAttempt);
        this.opts.logger?.info("sse:reconnect_scheduled", {
          attempt: this.reconnectAttempt,
          delayMs: delay,
        });
        await this._sleep(delay);
      }
    }

    if (this.state !== StreamState.Closed) {
      this.opts.logger?.warn("sse:budget_exhausted", {
        attempts: this.reconnectAttempt,
      });
      this.close();
    }
  }

  private async _openConnection(): Promise<void> {
    const url = `${this.baseUrl}${this.opts.path}`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.opts.authHeader) {
      headers["Authorization"] = this.opts.authHeader;
    }
    if (this.lastEventId !== undefined) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    if (this.opts.chaosInjector) {
      await this.opts.chaosInjector.maybeInjectFault(FaultType.NETWORK_DELAY);
      await this.opts.chaosInjector.maybeInjectFault(FaultType.NETWORK_DROP);
      await this.opts.chaosInjector.maybeInjectFault(FaultType.API_TIMEOUT);
    }

    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    const res = await fetchFn(url, {
      headers,
      signal: this.controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new TalosStreamError(res.status, body, url);
    }

    if (!res.body) {
      throw new TalosStreamError(0, "Response body is null", url);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new TalosStreamError(
        0,
        `Unexpected content-type: ${contentType}`,
        url,
      );
    }

    // Per-connection reset: the gap flag reflects THIS connection's resume.
    this.lastResumeHadHistoryGap = false;

    // Distinguish a server-side history gap from an ordinary reconnect: when
    // resuming with a Last-Event-ID, a server that cannot replay from that
    // cursor signals it via the `x-talos-stream-gap` response header. An
    // ordinary (replayable) reconnect omits the header.
    if (this.lastEventId !== undefined) {
      const gapHeader = res.headers.get("x-talos-stream-gap");
      if (gapHeader === "true" || gapHeader === "1") {
        const reason = res.headers.get("x-talos-stream-gap-reason") ?? undefined;
        this._emitHistoryGap({
          signal: "response-header",
          requestedAfterEventId: this.lastEventId,
          reason,
        });
      }
    }

    this._setState(StreamState.Open);
    this.heartbeatMisses = 0;
    this._resetHeartbeatTimer();

    await this._readStream(res.body);
  }

  // ── SSE stream reader ──────────────────────────────────────────────────────

  private async _readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Current event being accumulated
    let eventId: string | undefined;
    let eventType: TalosEventType = "message";
    let dataLines: string[] = [];

    try {
      while (true) {
        if (this.state === StreamState.Closed) {
          reader.cancel().catch(() => undefined);
          return;
        }

        const { done, value } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, "");

          if (line === "") {
            // Blank line — dispatch the accumulated event
            if (dataLines.length > 0) {
              const data = dataLines.join("\n");
              const finalId = eventId;
              const finalType = eventType;

              this.heartbeatMisses = 0;
              this._resetHeartbeatTimer();

              if (finalType === "history.gap") {
                // Server-side history gap signalled mid-stream — distinguish it
                // from an ordinary reconnect. Control events never advance
                // the resume cursor and are never dispatched to user handlers.
                this._handleHistoryGapEvent(data);
              } else {
                // Advance Last-Event-ID (preserves prior behavior, including
                // heartbeat events that carry an id).
                if (finalId !== undefined) {
                  this.lastEventId = finalId;
                }

                if (finalType !== "heartbeat") {
                  const evt: TalosStreamEvent = {
                    id: finalId,
                    type: finalType,
                    data,
                    receivedAt: new Date(),
                  };
                  await this._dispatch(evt);
                }
              }
            }
            // Reset accumulator
            eventId = undefined;
            eventType = "message";
            dataLines = [];
            continue;
          }

          if (line.startsWith(":")) {
            // SSE comment — counts as a heartbeat tick
            this.heartbeatMisses = 0;
            this._resetHeartbeatTimer();
            continue;
          }

          const colonIdx = line.indexOf(":");
          const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
          const value =
            colonIdx === -1 ? "" : line.slice(colonIdx + 1).replace(/^ /, "");

          switch (field) {
            case "id":
              eventId = value;
              break;
            case "event":
              eventType = value as TalosEventType;
              break;
            case "data":
              dataLines.push(value);
              break;
            case "retry": {
              const ms = parseInt(value, 10);
              if (!Number.isNaN(ms)) {
                // Server hint: update base reconnect delay
                this.opts.baseReconnectDelayMs = ms;
              }
              break;
            }
            default:
              // Unknown field — ignore per spec
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Event dispatch with dedup ──────────────────────────────────────────────

  private async _dispatch(evt: TalosStreamEvent): Promise<void> {
    // Duplicate suppression
    if (evt.id !== undefined && this.opts.seenStore) {
      const seen = await this.opts.seenStore.has(evt.id);
      if (seen) {
        this.opts.logger?.info("sse:duplicate_suppressed", {
          eventId: evt.id,
          eventType: evt.type,
        });
        return;
      }
      await this.opts.seenStore.add(evt.id);
    }

    for (const handler of this.eventHandlers) {
      try {
        await handler(evt);
      } catch (err) {
        this.opts.logger?.error("sse:handler_error", {
          eventType: evt.type,
          errorType: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // Auto-ack: persist a checkpoint for the last delivered event identity so
    // a restart resumes from here. Manual mode leaves persistence to
    // acknowledge(). Only events with an id can anchor a checkpoint.
    if (
      this.opts.ackMode === "auto" &&
      this.opts.checkpointStore !== undefined &&
      evt.id !== undefined
    ) {
      await this._persistCheckpoint(evt.id);
    }
  }

  // ── Checkpoint persistence ─────────────────────────────────────────────────

  /** Seed {@link lastEventId} from the durable checkpoint once, before run(). */
  private async _loadCheckpoint(): Promise<void> {
    if (this.opts.checkpointStore === undefined) return;
    // An in-memory cursor already set this session wins over the stored one.
    if (this.lastEventId !== undefined) return;
    try {
      const cp = await this.opts.checkpointStore.load();
      if (cp && typeof cp.eventId === "string" && cp.eventId !== "") {
        this.lastEventId = cp.eventId;
      }
    } catch {
      // A misbehaving store must not wedge the stream; treat as no checkpoint.
    }
  }

  /** Persist a checkpoint for the given event id. Never throws. */
  private async _persistCheckpoint(eventId: string): Promise<void> {
    if (this.opts.checkpointStore === undefined) return;
    try {
      await this.opts.checkpointStore.save({
        eventId,
        recordedAt: new Date().toISOString(),
        hadHistoryGap: this.lastResumeHadHistoryGap,
      });
    } catch {
      // Swallow; a failing store must not break the stream.
    }
  }

  // ── History-gap detection ──────────────────────────────────────────────────

  /**
   * Surface a server-side history gap. Sets the per-connection gap flag (so
   * subsequent checkpoints record it) and notifies the caller's handler.
   */
  private _emitHistoryGap(info: Omit<HistoryGapInfo, "detectedAt">): void {
    this.lastResumeHadHistoryGap = true;
    const full: HistoryGapInfo = { ...info, detectedAt: new Date().toISOString() };
    this.opts.logger?.warn("sse:history_gap", {
      signal: full.signal,
      requestedAfterEventId: full.requestedAfterEventId ?? null,
      reason: full.reason ?? null,
    });
    if (this.opts.onHistoryGap) {
      try {
        this.opts.onHistoryGap(full);
      } catch {
        // An observer must not break the stream.
      }
    }
  }

  /** Parse an `event: history.gap` payload and surface the gap. */
  private _handleHistoryGapEvent(data: string): void {
    let reason: string | undefined;
    let firstAvailableEventId: string | undefined;
    if (data.length > 0) {
      try {
        const parsed: unknown = JSON.parse(data);
        if (parsed != null && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.reason === "string") reason = obj.reason;
          const fa =
            obj.firstAvailableEventId ?? obj.first_available_event_id;
          if (typeof fa === "string") firstAvailableEventId = fa;
        }
      } catch {
        // Non-JSON data — still a gap signal, just without metadata.
      }
    }
    this._emitHistoryGap({
      signal: "event",
      requestedAfterEventId: this.lastEventId,
      reason,
      firstAvailableEventId,
    });
  }

  // ── Heartbeat watchdog ─────────────────────────────────────────────────────

  private _resetHeartbeatTimer(): void {
    if (this.opts.heartbeatIntervalMs <= 0) return;
    this._clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatMisses += 1;
      this.opts.logger?.warn("sse:heartbeat_miss", {
        misses: this.heartbeatMisses,
        max: this.opts.maxHeartbeatMisses,
      });
      if (this.heartbeatMisses >= this.opts.maxHeartbeatMisses) {
        this.opts.logger?.warn("sse:stall_detected", {
          misses: this.heartbeatMisses,
        });
        // Abort the current fetch so _openConnection throws and run() reconnects
        this.controller.abort();
        // Re-arm the internal abort controller is not possible; we use a fresh approach:
        // emit an error and let the reconnect loop handle it.
        this._emitError(
          new Error("Heartbeat stall detected"),
          this.reconnectAttempt,
        );
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private _clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // ── Reconnect backoff ──────────────────────────────────────────────────────

  private _reconnectDelay(attempt: number): number {
    const base = this.opts.baseReconnectDelayMs;
    const cap = this.opts.maxReconnectDelayMs;
    const exponential = Math.min(base * Math.pow(2, attempt - 1), cap);
    if (!this.opts.jitter) return exponential;
    return Math.floor(this.opts.random() * exponential);
  }

  private _sleep(ms: number): Promise<void> {
    if (this.controller.signal.aborted) {
      return Promise.reject(new Error("Stream closed during sleep"));
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("Stream closed during sleep"));
      };
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _setState(s: StreamState): void {
    this.state = s;
  }

  private _emitError(err: unknown, attempt: number): void {
    for (const h of this.errorHandlers) {
      try {
        h(err, attempt);
      } catch {
        // suppress handler errors
      }
    }
  }

  private _emitClose(): void {
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        // suppress handler errors
      }
    }
  }
}

// ── Error type ─────────────────────────────────────────────────────────────────

/** Thrown when the SSE connection receives a non-2xx HTTP response. */
export class TalosStreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`TalosStreamError ${status} at ${url}: ${body}`);
    this.name = "TalosStreamError";
  }
}
