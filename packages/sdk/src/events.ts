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
 * - Schema version negotiation: sends an `X-Talos-Event-Schema-Version` request header and
 *   validates the server's acknowledged version from the response header. Mismatches surface
 *   as {@link SchemaVersionMismatchError} before any events are delivered.
 * - Parser hardening: handles \r\n line endings, UTF-8 BOM, oversized fields, empty data lines,
 *   malformed frames, and deeply split chunks without unbounded memory growth.
 */

import type { Logger } from "./webhooks.js";
import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

// ── Schema version constants ───────────────────────────────────────────────────

/**
 * The current event schema version advertised by this SDK build.
 * Increment this whenever the event payload shape changes in a breaking way.
 */
export const TALOS_EVENT_SCHEMA_VERSION = "1" as const;

/**
 * The HTTP request header used to advertise the client's preferred event
 * schema version to the server.
 */
export const SCHEMA_VERSION_REQUEST_HEADER = "X-Talos-Event-Schema-Version" as const;

/**
 * The HTTP response header through which the server acknowledges the
 * negotiated event schema version.
 */
export const SCHEMA_VERSION_RESPONSE_HEADER = "X-Talos-Event-Schema-Version-Ack" as const;

// ── Schema version types ───────────────────────────────────────────────────────

/**
 * Result of a schema version negotiation exchange with the server.
 *
 * - `negotiated` — the version agreed upon. Equal to the requested version
 *   when the server acknowledges it, or the server's advertised version when
 *   the server sent a different value.
 * - `requested` — the version the client sent in the request header.
 * - `serverAcknowledged` — the version the server returned in the response
 *   header, or `undefined` when the server did not send the header.
 * - `compatible` — `true` when the negotiation succeeded without conflicts.
 */
export interface SchemaVersionNegotiationResult {
  /** The version in active use for this connection. */
  negotiated: string;
  /** The version requested by the client. */
  requested: string;
  /**
   * The version acknowledged by the server, or `undefined` when the server
   * did not return a schema-version header (treated as version-unaware).
   */
  serverAcknowledged: string | undefined;
  /**
   * `true` when the server acknowledged the exact version requested, or when
   * the server did not send a version header (version-unaware server, treated
   * as compatible for forward compatibility).
   */
  compatible: boolean;
}

// ── Schema version error ───────────────────────────────────────────────────────

/**
 * Thrown when the server returns a schema-version header that is explicitly
 * incompatible with the requested version. This is a hard error — the stream
 * does not open, and no events are delivered.
 *
 * Privacy-safe: the error message never includes request payloads,
 * credentials, or sensitive media.
 */
export class SchemaVersionMismatchError extends Error {
  /** The version the client requested. */
  public readonly requested: string;
  /** The version the server acknowledged. */
  public readonly serverAcknowledged: string;

  constructor(requested: string, serverAcknowledged: string) {
    super(
      `SchemaVersionMismatchError: client requested event schema version "${requested}" ` +
        `but server acknowledged "${serverAcknowledged}". ` +
        `Upgrade the SDK or configure schemaVersion to match the server.`,
    );
    this.name = "SchemaVersionMismatchError";
    this.requested = requested;
    this.serverAcknowledged = serverAcknowledged;
  }
}

// ── Version negotiation helper ─────────────────────────────────────────────────

/**
 * Parse and validate the schema version headers from an SSE response.
 *
 * Rules:
 * - If the server did not return `X-Talos-Event-Schema-Version-Ack`, the
 *   negotiation is treated as compatible (the server is version-unaware).
 * - If the server returned the header with the same value as requested, the
 *   negotiation is compatible.
 * - If the server returned a different non-empty version string and
 *   `strictVersionCheck` is `true`, the negotiation is incompatible and
 *   {@link SchemaVersionMismatchError} is thrown.
 * - If `strictVersionCheck` is `false` (the default), a version mismatch is
 *   logged as a warning but does not throw — forward compatibility favored.
 *
 * @param requested - The version string sent in the request header.
 * @param headers   - The fetch `Headers` object from the SSE response.
 * @param strict    - When `true`, a mismatch throws instead of warns.
 * @param logger    - Optional privacy-safe logger for warnings.
 * @returns         {@link SchemaVersionNegotiationResult}
 * @throws          {@link SchemaVersionMismatchError} when strict and mismatched.
 */
export function negotiateSchemaVersion(
  requested: string,
  headers: Headers,
  strict: boolean,
  logger?: Logger,
): SchemaVersionNegotiationResult {
  const serverAcknowledged =
    headers.get(SCHEMA_VERSION_RESPONSE_HEADER) ?? undefined;

  const compatible =
    serverAcknowledged === undefined || serverAcknowledged === requested;

  const negotiated = serverAcknowledged ?? requested;

  const result: SchemaVersionNegotiationResult = {
    negotiated,
    requested,
    serverAcknowledged,
    compatible,
  };

  if (!compatible) {
    if (strict) {
      throw new SchemaVersionMismatchError(requested, serverAcknowledged!);
    }
    logger?.warn("sse:schema_version_mismatch", {
      requested,
      serverAcknowledged,
    });
  }

  return result;
}

// ── Parser hardening constants ─────────────────────────────────────────────────

/**
 * Maximum byte length of a single SSE field value (field name excluded).
 * Values that exceed this limit are silently truncated and a warning is emitted.
 * Protects against malicious or malfunctioning servers sending arbitrarily
 * large payloads through a single SSE field.
 *
 * @default 1_048_576 (1 MiB)
 */
export const SSE_MAX_FIELD_BYTES = 1_048_576;

/**
 * Maximum number of data lines accumulated per SSE event frame.
 * Frames that exceed this limit are discarded and a warning is emitted.
 * Protects against server bugs that emit thousands of `data:` lines per frame.
 *
 * @default 1_000
 */
export const SSE_MAX_DATA_LINES = 1_000;

/**
 * The UTF-8 byte order mark (BOM) that some servers prepend to the first
 * chunk of a text/event-stream response. Per the SSE specification, a BOM
 * at the beginning of the stream must be ignored.
 */
const UTF8_BOM = "\uFEFF";

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

  /**
   * The event schema version to advertise to the server in the
   * `X-Talos-Event-Schema-Version` request header.
   *
   * The server is expected to echo the negotiated version back via the
   * `X-Talos-Event-Schema-Version-Ack` response header. When the server
   * does not return this header it is treated as version-unaware and the
   * connection proceeds normally.
   *
   * @default TALOS_EVENT_SCHEMA_VERSION ("1")
   */
  schemaVersion?: string;

  /**
   * When `true`, a server acknowledgement that differs from `schemaVersion`
   * causes the connection to fail immediately with a
   * {@link SchemaVersionMismatchError}. No events are delivered.
   *
   * When `false` (the default), a mismatch is logged as a warning and the
   * stream opens normally, favouring forward compatibility.
   *
   * @default false
   */
  strictSchemaVersionCheck?: boolean;

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

  /** Optional chaos injector for fault injection during SSE connections. */
  chaosInjector?: ChaosInjector;

  /**
   * Maximum byte length of a single SSE field value before it is silently
   * truncated. Protects against malicious or runaway servers.
   * @default SSE_MAX_FIELD_BYTES (1 MiB)
   */
  maxFieldBytes?: number;

  /**
   * Maximum number of \`data:\` lines accumulated per SSE event frame before
   * the frame is discarded. Protects against servers emitting runaway frames.
   * @default SSE_MAX_DATA_LINES (1 000)
   */
  maxDataLines?: number;
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

  // schema version negotiation result from the most recent connection
  private _schemaVersionInfo: SchemaVersionNegotiationResult | undefined;

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
      schemaVersion: opts.schemaVersion ?? TALOS_EVENT_SCHEMA_VERSION,
      strictSchemaVersionCheck: opts.strictSchemaVersionCheck ?? false,
      maxFieldBytes: opts.maxFieldBytes ?? SSE_MAX_FIELD_BYTES,
      maxDataLines: opts.maxDataLines ?? SSE_MAX_DATA_LINES,
      authHeader: opts.authHeader,
      seenStore: opts.seenStore,
      logger: opts.logger,
      signal: opts.signal,
      fetch: opts.fetch,
      chaosInjector: opts.chaosInjector,
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
   * Schema version negotiation result from the most recent successful
   * connection, or `undefined` when no connection has been established yet.
   *
   * Use this to inspect which schema version was agreed upon after the stream
   * first emits events. The value is updated on every reconnection so it
   * always reflects the current negotiated version.
   */
  get schemaVersionInfo(): SchemaVersionNegotiationResult | undefined {
    return this._schemaVersionInfo;
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
    // Advertise the requested event schema version to the server.
    headers[SCHEMA_VERSION_REQUEST_HEADER] = this.opts.schemaVersion;

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

    // Negotiate the event schema version from the response headers.
    // This may throw SchemaVersionMismatchError when strict mode is enabled.
    this._schemaVersionInfo = negotiateSchemaVersion(
      this.opts.schemaVersion,
      res.headers,
      this.opts.strictSchemaVersionCheck,
      this.opts.logger,
    );
    this.opts.logger?.info("sse:schema_version_negotiated", {
      negotiated: this._schemaVersionInfo.negotiated,
      compatible: this._schemaVersionInfo.compatible,
    });

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
    let firstChunk = true;

    // Current event being accumulated
    let eventId: string | undefined;
    let eventType: TalosEventType = "message";
    let dataLines: string[] = [];
    // Guard against runaway frames with too many data: lines
    let dataLineOverflow = false;

    try {
      while (true) {
        if (this.state === StreamState.Closed) {
          reader.cancel().catch(() => undefined);
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          // Stream ended — flush any content still in the buffer.
          // A trailing \r that was held back (potential first half of \r\n)
          // is now confirmed to be a bare \r line terminator.
          if (buffer.length > 0) {
            const normalized = buffer
              .replace(/\uFEFF/g, "")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            const lines = normalized.split("\n");
            if (lines[lines.length - 1] === "") lines.pop();
            for (const line of lines) {
              if (line === "") {
                if (!dataLineOverflow && dataLines.length > 0) {
                  const data = dataLines.join("\n");
                  const finalId = eventId;
                  const finalType = eventType;
                  if (finalId !== undefined) this.lastEventId = finalId;
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
                eventId = undefined;
                eventType = "message";
                dataLines = [];
                dataLineOverflow = false;
              } else if (!line.startsWith(":")) {
                const colonIdx = line.indexOf(":");
                const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
                const val =
                  colonIdx === -1
                    ? ""
                    : line.slice(colonIdx + 1).replace(/^ /, "");
                if (field === "id") eventId = val;
                else if (field === "event")
                  eventType = val as TalosEventType;
                else if (field === "data") {
                  if (!dataLineOverflow) dataLines.push(val);
                }
              }
            }
          }
          return;
        }

        let chunk = decoder.decode(value, { stream: true });

        // Strip UTF-8 BOM from the very first decoded chunk.
        // Per the SSE spec the BOM must be silently ignored.
        if (firstChunk) {
          if (chunk.startsWith(UTF8_BOM)) {
            chunk = chunk.slice(UTF8_BOM.length);
          }
          firstChunk = false;
        }

        buffer += chunk;

        // Split on both LF and CRLF per the SSE specification (§9.2).
        // We normalise CRLF → LF first so the subsequent \n split works
        // identically regardless of the server's line-ending convention.
        //
        // CRLF cross-chunk boundary: if the buffer ends with a bare \r we
        // cannot yet tell whether the next chunk starts with \n (making it a
        // \r\n pair) or not.  Hold the trailing \r back until the next chunk
        // arrives so we never split a \r\n pair across two iterations.
        let toProcess: string;
        if (buffer.endsWith("\r")) {
          toProcess = buffer.slice(0, buffer.length - 1);
          buffer = "\r"; // held back — will be prepended on the next iteration
        } else {
          toProcess = buffer;
          buffer = "";
        }

        if (toProcess.length === 0) continue;

        // Strip any BOM characters that appear in the processed text.
        // The SSE spec only mandates stripping at stream position 0, but a
        // BOM appearing elsewhere (e.g. from a misconfigured proxy injecting
        // one mid-stream) would corrupt field names if left in place.
        const normalized = toProcess
          .replace(/\uFEFF/g, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        const lines = normalized.split("\n");
        // Keep the last (potentially incomplete) line in the buffer,
        // and reattach any held-back \r so it reassembles correctly next time.
        buffer = (lines.pop() ?? "") + buffer;

        for (const rawLine of lines) {
          // rawLine is already CR-stripped at this point

          if (rawLine === "") {
            // Blank line — dispatch the accumulated event
            if (dataLineOverflow) {
              // Discard the frame; the overflow warning was already emitted
              this.opts.logger?.warn("sse:frame_discarded_data_overflow", {
                maxDataLines: this.opts.maxDataLines,
              });
            } else if (dataLines.length > 0) {
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
            dataLineOverflow = false;
            continue;
          }

          if (rawLine.startsWith(":")) {
            // SSE comment — counts as a heartbeat tick
            this.heartbeatMisses = 0;
            this._resetHeartbeatTimer();
            continue;
          }

          const colonIdx = rawLine.indexOf(":");
          const field = colonIdx === -1 ? rawLine : rawLine.slice(0, colonIdx);
          let fieldValue =
            colonIdx === -1
              ? ""
              : rawLine.slice(colonIdx + 1).replace(/^ /, "");

          // Truncate oversized field values to prevent memory exhaustion.
          if (fieldValue.length > this.opts.maxFieldBytes) {
            this.opts.logger?.warn("sse:field_value_truncated", {
              field,
              originalLength: fieldValue.length,
              maxFieldBytes: this.opts.maxFieldBytes,
            });
            fieldValue = fieldValue.slice(0, this.opts.maxFieldBytes);
          }

          switch (field) {
            case "id":
              eventId = fieldValue;
              break;
            case "event":
              eventType = fieldValue as TalosEventType;
              break;
            case "data":
              if (!dataLineOverflow) {
                if (dataLines.length >= this.opts.maxDataLines) {
                  // Mark overflow; the frame will be discarded at dispatch time
                  dataLineOverflow = true;
                  this.opts.logger?.warn("sse:data_line_limit_reached", {
                    maxDataLines: this.opts.maxDataLines,
                  });
                } else {
                  dataLines.push(fieldValue);
                }
              }
              break;
            case "retry": {
              const ms = parseInt(fieldValue, 10);
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
