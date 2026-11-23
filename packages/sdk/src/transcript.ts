/**
 * Deterministic HTTP transcript recorder and replayer for SDK support cases.
 *
 * Privacy and safety guarantees:
 * - Request bodies are NEVER recorded (omitted entirely).
 * - Sensitive query credentials (tokens, signatures, keys) in paths are redacted.
 * - Sensitive request and response headers (Authorization, X-Api-Key, Cookie, etc.)
 *   are redacted.
 * - Replayer deterministically matches method and path to return synthetic
 *   responses without needing or inspecting private request bodies.
 *
 * @module transcript
 */

import { redactEventPath, redactSecrets, type HeaderSource } from "./errors.js";

/**
 * Timing snapshot for a recorded request.
 */
export interface TranscriptTiming {
  /** Wall-clock duration of the request/response cycle in milliseconds. */
  durationMs: number;
  /** ISO 8601 timestamp captured when the request began. */
  startedAt: string;
}

/**
 * Sanitized representation of the request that was recorded.
 * Request bodies are deliberately excluded for privacy and safety.
 */
export interface TranscriptRequest {
  /** Uppercase HTTP method (e.g. GET, POST, DELETE). */
  method: string;
  /** Sanitized path with credential query parameters redacted. */
  path: string;
  /** Sanitized request headers with sensitive credentials redacted. */
  headers: Record<string, string>;
}

/**
 * Representation of the response that was recorded.
 */
export interface TranscriptResponse {
  /** HTTP status code (or 0 for network/transport failures). */
  status: number;
  /** HTTP status text (e.g. "OK", "Payment Required"). */
  statusText?: string;
  /** Sanitized response headers. */
  headers: Record<string, string>;
  /**
   * Captured synthetic response body payload (JSON or string).
   * Request bodies are NEVER captured.
   */
  body?: unknown;
}

/**
 * One recorded entry in an HTTP transcript.
 */
export interface TranscriptEntry {
  /** Unique identifier for this entry within the transcript. */
  id: string;
  /** Attempt number for retry tracking (1-based). */
  attempt: number;
  /** Sanitized HTTP method (convenience projection of `request.method`). */
  method: string;
  /** Sanitized request path (convenience projection of `request.path`). */
  path: string;
  /** Response status code (convenience projection of `response.status`). */
  status: number;
  /** Response status text (convenience projection of `response.statusText`). */
  statusText?: string;
  /** Request duration in milliseconds (convenience projection of `timing.durationMs`). */
  durationMs: number;
  /** ISO 8601 timestamp when request started (convenience projection of `timing.startedAt`). */
  startedAt: string;
  /** Sanitized request headers (convenience projection of `request.headers`). */
  requestHeaders?: Record<string, string>;
  /** Sanitized response headers (convenience projection of `response.headers`). */
  responseHeaders?: Record<string, string>;
  /** Response body payload (convenience projection of `response.body`). Request bodies are NEVER recorded. */
  responseBody?: unknown;

  /** Structured request snapshot. */
  request: TranscriptRequest;
  /** Structured response snapshot. */
  response: TranscriptResponse;
  /** Structured timing snapshot. */
  timing: TranscriptTiming;
}

/**
 * Full serialized HTTP transcript.
 */
export interface HttpTranscript {
  /** Schema version for forward/backward compatibility. */
  version: 1;
  /** ISO 8601 timestamp when the transcript was captured/exported. */
  recordedAt: string;
  /** Ordered list of recorded entries. */
  entries: TranscriptEntry[];
  /** Optional caller-supplied metadata (environment, client version, etc.). */
  metadata?: Record<string, unknown>;
}

export interface TranscriptRecorderOptions {
  /** Maximum number of entries to retain in memory (default: 100). */
  maxEntries?: number;
  /** Whether to capture response bodies (default: true). Request bodies are NEVER captured. */
  captureResponseBody?: boolean;
  /** Maximum response body size in bytes to record (default: 65536). */
  maxResponseBodyBytes?: number;
  /** Additional sensitive header names or regexes to redact. */
  sensitiveHeaders?: RegExp | string[];
  /** Optional metadata to include in the exported transcript. */
  metadata?: Record<string, unknown>;
}

export interface TranscriptReplayOptions {
  /**
   * Replay matching strategy:
   * - `"fifo"` (default): Plays matching entries in FIFO order, advancing on each call.
   *   Ideal for sequences of retries (e.g. 503 -> 200).
   * - `"exact"`: Matches exact unplayed entry for method and path.
   * - `"fallback"`: If no unplayed entry matches, reuses the most recent matching entry.
   */
  strategy?: "fifo" | "exact" | "fallback";
  /** Base URL to strip when matching against request URLs. */
  baseUrl?: string;
  /**
   * What to do when a requested route has no match in the transcript:
   * - `"throw"` (default): Throws an Error describing the unmatched route.
   * - `"404"`: Returns a synthetic 404 response.
   */
  onUnmatched?: "throw" | "404";
}

/** Default sensitive header keys that must always be redacted. */
const SENSITIVE_HEADER_PATTERN =
  /^(?:x-)?(token|authorization|secret|api[_-]?key|password|cookie|set-cookie|signature|message|nonce|hash|payment)$/i;

/**
 * Sanitize a request path by stripping/redacting sensitive query parameters.
 */
export function sanitizeTranscriptPath(rawPath: string): string {
  if (!rawPath) return "/";
  // If rawPath is a full URL, extract path + query
  try {
    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
      const u = new URL(rawPath);
      return redactEventPath(`${u.pathname}${u.search}`);
    }
  } catch {
    // Fall back to redactEventPath directly
  }
  return redactEventPath(rawPath);
}

/**
 * Sanitize headers for transcript recording.
 */
export function sanitizeTranscriptHeaders(
  headers: HeaderSource,
  extraSensitive?: RegExp | string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  const entries: [string, string][] = [];
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      entries.push([key, value]);
    });
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      if (typeof v === "string") entries.push([k, v]);
    }
  }

  const isExtraSensitive = (key: string): boolean => {
    if (!extraSensitive) return false;
    if (extraSensitive instanceof RegExp) return extraSensitive.test(key);
    return extraSensitive.some((s) => s.toLowerCase() === key.toLowerCase());
  };

  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_PATTERN.test(lower) || isExtraSensitive(lower)) {
      out[lower] = "[REDACTED]";
    } else {
      out[lower] = value;
    }
  }

  return out;
}

/**
 * Sanitize a response body for transcript storage.
 */
export function sanitizeTranscriptResponseBody(
  body: unknown,
  maxBytes = 65536,
): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    return body.length > maxBytes ? `${body.slice(0, maxBytes)}...[TRUNCATED]` : body;
  }
  if (typeof body === "object") {
    const redacted = redactSecrets(body);
    try {
      const serialized = JSON.stringify(redacted);
      if (serialized.length > maxBytes) {
        return { _truncated: true, _bytes: serialized.length };
      }
      return redacted;
    } catch {
      return undefined;
    }
  }
  return body;
}

/**
 * In-memory recorder for HTTP transactions.
 */
export class TranscriptRecorder {
  private readonly maxEntries: number;
  private readonly captureResponseBody: boolean;
  private readonly maxResponseBodyBytes: number;
  private readonly sensitiveHeaders?: RegExp | string[];
  private readonly metadata?: Record<string, unknown>;
  private readonly entries: TranscriptEntry[] = [];
  private sequence = 0;

  constructor(options?: TranscriptRecorderOptions) {
    this.maxEntries = options?.maxEntries ?? 100;
    this.captureResponseBody = options?.captureResponseBody ?? true;
    this.maxResponseBodyBytes = options?.maxResponseBodyBytes ?? 65536;
    this.sensitiveHeaders = options?.sensitiveHeaders;
    this.metadata = options?.metadata;
  }

  /**
   * Record one HTTP interaction. Request bodies are intentionally excluded
   * and never accepted into transcript entries.
   */
  record(params: {
    method: string;
    path: string;
    status: number;
    statusText?: string;
    durationMs: number;
    startedAt?: string;
    attempt?: number;
    requestHeaders?: HeaderSource;
    responseHeaders?: HeaderSource;
    responseBody?: unknown;
  }): TranscriptEntry {
    this.sequence++;
    const id = `tx_${this.sequence}_${Date.now()}`;
    const sanitizedPath = sanitizeTranscriptPath(params.path);
    const sanitizedReqHeaders = sanitizeTranscriptHeaders(params.requestHeaders, this.sensitiveHeaders);
    const sanitizedResHeaders = sanitizeTranscriptHeaders(params.responseHeaders, this.sensitiveHeaders);
    const startedAt = params.startedAt ?? new Date().toISOString();
    const durationMs = Math.max(0, params.durationMs);
    const attempt = params.attempt ?? 1;

    let responseBody: unknown;
    if (this.captureResponseBody && params.responseBody !== undefined) {
      responseBody = sanitizeTranscriptResponseBody(params.responseBody, this.maxResponseBodyBytes);
    }

    const request: TranscriptRequest = {
      method: params.method.toUpperCase(),
      path: sanitizedPath,
      headers: sanitizedReqHeaders,
    };

    const response: TranscriptResponse = {
      status: params.status,
      statusText: params.statusText,
      headers: sanitizedResHeaders,
      ...(responseBody !== undefined ? { body: responseBody } : {}),
    };

    const timing: TranscriptTiming = {
      durationMs,
      startedAt,
    };

    const entry: TranscriptEntry = {
      id,
      attempt,
      method: request.method,
      path: request.path,
      status: response.status,
      statusText: response.statusText,
      durationMs: timing.durationMs,
      startedAt: timing.startedAt,
      requestHeaders: sanitizedReqHeaders,
      responseHeaders: sanitizedResHeaders,
      responseBody,
      request,
      response,
      timing,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return entry;
  }

  getEntries(): readonly TranscriptEntry[] {
    return [...this.entries];
  }

  getTranscript(): HttpTranscript {
    return {
      version: 1,
      recordedAt: new Date().toISOString(),
      entries: [...this.entries],
      ...(this.metadata ? { metadata: { ...this.metadata } } : {}),
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.sequence = 0;
  }

  toJSON(): HttpTranscript {
    return this.getTranscript();
  }

  export(indent = 2): string {
    return JSON.stringify(this.getTranscript(), null, indent);
  }

  get length(): number {
    return this.entries.length;
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * Deterministic synthetic response replayer.
 */
export class TranscriptReplayer {
  private readonly entries: TranscriptEntry[];
  private readonly playedIndices = new Set<number>();
  private readonly strategy: "fifo" | "exact" | "fallback";
  private readonly onUnmatched: "throw" | "404";
  private readonly baseUrl?: string;

  constructor(
    transcript: HttpTranscript | readonly TranscriptEntry[],
    options?: TranscriptReplayOptions,
  ) {
    this.entries = Array.isArray(transcript)
      ? [...transcript]
      : (transcript as HttpTranscript)?.entries
        ? [...(transcript as HttpTranscript).entries]
        : [];
    this.strategy = options?.strategy ?? "fifo";
    this.onUnmatched = options?.onUnmatched ?? "throw";
    this.baseUrl = options?.baseUrl;
  }

  /**
   * Custom fetch implementation reproducing synthetic responses.
   * Request bodies are never required or inspected.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input
        ? (input as Request).method
        : "GET")
    ).toUpperCase();

    let requestPath = rawUrl;
    try {
      const parsed = new URL(rawUrl, "http://localhost");
      requestPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Relative path kept as-is
    }
    const sanitizedPath = sanitizeTranscriptPath(requestPath);

    const matchIndex = this.findMatchingEntryIndex(method, sanitizedPath);

    if (matchIndex === -1) {
      if (this.onUnmatched === "404") {
        return new Response(
          JSON.stringify({
            error: "Not Found",
            message: `No transcript entry for ${method} ${sanitizedPath}`,
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(
        `TranscriptReplayError: No matching transcript entry for ${method} ${sanitizedPath}`,
      );
    }

    const entry = this.entries[matchIndex];
    this.playedIndices.add(matchIndex);

    // Status 0 represents a transport/network error
    if (entry.status === 0) {
      throw new TypeError(`Simulated transport failure on ${method} ${sanitizedPath}`);
    }

    const resHeaders = new Headers(
      entry.responseHeaders ?? entry.response?.headers,
    );
    const bodyVal = entry.responseBody ?? entry.response?.body;
    let bodyText: string | null = null;
    if (bodyVal !== undefined && bodyVal !== null) {
      if (typeof bodyVal === "string") {
        bodyText = bodyVal;
      } else {
        bodyText = JSON.stringify(bodyVal);
        if (!resHeaders.has("content-type")) {
          resHeaders.set("content-type", "application/json");
        }
      }
    }

    const status = entry.status ?? entry.response?.status ?? 200;
    const statusText =
      entry.statusText ??
      entry.response?.statusText ??
      (status === 200 ? "OK" : "");

    return new Response(status === 204 ? null : bodyText, {
      status,
      statusText,
      headers: resHeaders,
    });
  }

  private findMatchingEntryIndex(method: string, path: string): number {
    const normalize = (p: string) => {
      if (this.baseUrl && p.startsWith(this.baseUrl)) {
        p = p.slice(this.baseUrl.length);
      }
      return p.startsWith("/") ? p : `/${p}`;
    };

    const targetPath = normalize(path);

    const matches = (entry: TranscriptEntry): boolean => {
      const entryMethod = (
        entry.method ??
        entry.request?.method ??
        "GET"
      ).toUpperCase();
      if (entryMethod !== method) return false;
      const entryPath = normalize(entry.path ?? entry.request?.path ?? "");
      return entryPath === targetPath;
    };

    if (this.strategy === "fifo" || this.strategy === "exact") {
      for (let i = 0; i < this.entries.length; i++) {
        if (!this.playedIndices.has(i) && matches(this.entries[i])) {
          return i;
        }
      }
      return -1;
    }

    // fallback: unplayed first, then any matching
    for (let i = 0; i < this.entries.length; i++) {
      if (!this.playedIndices.has(i) && matches(this.entries[i])) {
        return i;
      }
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (matches(this.entries[i])) {
        return i;
      }
    }
    return -1;
  }

  getPlayedEntries(): readonly TranscriptEntry[] {
    return Array.from(this.playedIndices).map((i) => this.entries[i]);
  }

  getRemainingEntries(): readonly TranscriptEntry[] {
    return this.entries.filter((_, i) => !this.playedIndices.has(i));
  }

  reset(): void {
    this.playedIndices.clear();
  }
}

/**
 * Factory helper to create a TranscriptRecorder.
 */
export function createTranscriptRecorder(
  options?: TranscriptRecorderOptions,
): TranscriptRecorder {
  return new TranscriptRecorder(options);
}

/**
 * Factory helper to create a custom fetch function that replays responses
 * from an HTTP transcript.
 */
export function createTranscriptReplayer(
  transcript: HttpTranscript | readonly TranscriptEntry[],
  options?: TranscriptReplayOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const replayer = new TranscriptReplayer(transcript, options);
  return (input, init) => replayer.fetch(input, init);
}

/**
 * Parse and validate a serialized transcript JSON string.
 */
export function parseTranscript(json: string): HttpTranscript {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Invalid transcript: expected object with version 1 and an entries array");
  }
  return parsed as HttpTranscript;
}
