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

  /** Privacy-safe logger. Payloads and credentials are never passed to it. */
  logger?: Logger;

  /** External AbortSignal — closing this also closes the stream. */
  signal?: AbortSignal;

  /** Seeded random function, for deterministic tests. @default Math.random */
  random?: () => number;

  /** Fetch implementation override (for testing). @default globalThis.fetch */
  fetch?: typeof globalThis.fetch;
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
      "authHeader" | "seenStore" | "logger" | "signal" | "fetch"
    >
  > &
    Pick<
      TalosEventStreamOptions,
      "authHeader" | "seenStore" | "logger" | "signal" | "fetch"
    >;

  private state: StreamState = StreamState.Idle;
  private lastEventId: string | undefined;
  private reconnectAttempt = 0;

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

  // ── Internal connection loop ───────────────────────────────────────────────

  private async run(): Promise<void> {
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

              // Advance Last-Event-ID
              if (finalId !== undefined) {
                this.lastEventId = finalId;
              }

              this.heartbeatMisses = 0;
              this._resetHeartbeatTimer();

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
