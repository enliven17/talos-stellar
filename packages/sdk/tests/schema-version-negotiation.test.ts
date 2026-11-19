/**
 * Event schema version negotiation tests — #576
 *
 * Covers:
 *   Positive: schema version header sent on every request (first + reconnect)
 *   Positive: server acknowledges matching version → compatible negotiation
 *   Positive: server does not return ack header → treated as compatible
 *   Positive: schemaVersionInfo getter reflects negotiation result
 *   Positive: custom schemaVersion option is honoured
 *   Negative: strict mode + mismatch → SchemaVersionMismatchError thrown
 *   Negative: non-strict mode + mismatch → warning, stream opens
 *   Boundary: empty string version is sent as-is
 *   Boundary: schemaVersionInfo is undefined before first connect
 *   Regression: existing callers without schemaVersion option unaffected
 *   Regression: Authorization and Last-Event-ID still sent alongside version header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosEventStream,
  TalosStreamError,
  SchemaVersionMismatchError,
  TALOS_EVENT_SCHEMA_VERSION,
  SCHEMA_VERSION_REQUEST_HEADER,
  SCHEMA_VERSION_RESPONSE_HEADER,
  negotiateSchemaVersion,
} from "../src/events.js";
import type { SchemaVersionNegotiationResult } from "../src/events.js";
import * as sdkIndex from "../src/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(
  body: ReadableStream<Uint8Array>,
  extraHeaders?: Record<string, string>,
): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream",
      ...extraHeaders,
    }),
    body,
    text: async () => "",
  } as unknown as Response;
}

function errorResponse(status: number, body = "error"): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: null,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Public API surface (regression) ──────────────────────────────────────────

describe("Schema version negotiation — SDK exports (#576)", () => {
  it("exports TALOS_EVENT_SCHEMA_VERSION constant", () => {
    expect(sdkIndex.TALOS_EVENT_SCHEMA_VERSION).toBe("1");
  });

  it("exports SCHEMA_VERSION_REQUEST_HEADER constant", () => {
    expect(sdkIndex.SCHEMA_VERSION_REQUEST_HEADER).toBe(
      "X-Talos-Event-Schema-Version",
    );
  });

  it("exports SCHEMA_VERSION_RESPONSE_HEADER constant", () => {
    expect(sdkIndex.SCHEMA_VERSION_RESPONSE_HEADER).toBe(
      "X-Talos-Event-Schema-Version-Ack",
    );
  });

  it("exports SchemaVersionMismatchError class", () => {
    expect(typeof sdkIndex.SchemaVersionMismatchError).toBe("function");
  });

  it("exports negotiateSchemaVersion function", () => {
    expect(typeof sdkIndex.negotiateSchemaVersion).toBe("function");
  });
});

// ── negotiateSchemaVersion unit tests ─────────────────────────────────────────

describe("negotiateSchemaVersion()", () => {
  it("returns compatible when server acks the same version", () => {
    const headers = new Headers({
      [SCHEMA_VERSION_RESPONSE_HEADER]: "1",
    });
    const result = negotiateSchemaVersion("1", headers, false);
    expect(result.compatible).toBe(true);
    expect(result.negotiated).toBe("1");
    expect(result.requested).toBe("1");
    expect(result.serverAcknowledged).toBe("1");
  });

  it("returns compatible when server sends no ack header", () => {
    const headers = new Headers();
    const result = negotiateSchemaVersion("1", headers, false);
    expect(result.compatible).toBe(true);
    expect(result.serverAcknowledged).toBeUndefined();
    expect(result.negotiated).toBe("1");
  });

  it("returns incompatible when server acks a different version (non-strict)", () => {
    const headers = new Headers({
      [SCHEMA_VERSION_RESPONSE_HEADER]: "2",
    });
    const result = negotiateSchemaVersion("1", headers, false);
    expect(result.compatible).toBe(false);
    expect(result.negotiated).toBe("2");
    expect(result.serverAcknowledged).toBe("2");
  });

  it("throws SchemaVersionMismatchError when server acks a different version (strict)", () => {
    const headers = new Headers({
      [SCHEMA_VERSION_RESPONSE_HEADER]: "2",
    });
    expect(() => negotiateSchemaVersion("1", headers, true)).toThrow(
      SchemaVersionMismatchError,
    );
  });

  it("SchemaVersionMismatchError carries requested and serverAcknowledged", () => {
    const headers = new Headers({
      [SCHEMA_VERSION_RESPONSE_HEADER]: "3",
    });
    let caught: SchemaVersionMismatchError | undefined;
    try {
      negotiateSchemaVersion("1", headers, true);
    } catch (e) {
      caught = e as SchemaVersionMismatchError;
    }
    expect(caught).toBeInstanceOf(SchemaVersionMismatchError);
    expect(caught?.requested).toBe("1");
    expect(caught?.serverAcknowledged).toBe("3");
    // Privacy-safe: error message must not contain the word "secret" or credentials
    expect(caught?.message).not.toMatch(/secret|token|key|password/i);
  });

  it("SchemaVersionMismatchError name is 'SchemaVersionMismatchError'", () => {
    const err = new SchemaVersionMismatchError("1", "2");
    expect(err.name).toBe("SchemaVersionMismatchError");
    expect(err).toBeInstanceOf(Error);
  });

  it("logs a warning on mismatch in non-strict mode", () => {
    const warn = vi.fn();
    const headers = new Headers({ [SCHEMA_VERSION_RESPONSE_HEADER]: "99" });
    negotiateSchemaVersion("1", headers, false, { info: vi.fn(), warn, error: vi.fn() });
    expect(warn).toHaveBeenCalledWith("sse:schema_version_mismatch", {
      requested: "1",
      serverAcknowledged: "99",
    });
  });

  it("boundary: empty string version is passed through without throwing (non-strict)", () => {
    const headers = new Headers({ [SCHEMA_VERSION_RESPONSE_HEADER]: "" });
    const result = negotiateSchemaVersion("", headers, false);
    expect(result.compatible).toBe(true);
    expect(result.negotiated).toBe("");
  });
});

// ── TalosEventStream integration tests ────────────────────────────────────────

describe("TalosEventStream — schema version header sent (#576)", () => {
  it("sends X-Talos-Event-Schema-Version header with default version", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const sentHeaders = mockFetch.mock.calls[0][1].headers;
    expect(sentHeaders[SCHEMA_VERSION_REQUEST_HEADER]).toBe(
      TALOS_EVENT_SCHEMA_VERSION,
    );
  });

  it("sends custom schemaVersion when provided", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      schemaVersion: "2",
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const sentHeaders = mockFetch.mock.calls[0][1].headers;
    expect(sentHeaders[SCHEMA_VERSION_REQUEST_HEADER]).toBe("2");
  });

  it("sends version header on every reconnect attempt", async () => {
    const body1 = sseStream("data: a\n\n");
    const body2 = sseStream("data: b\n\n");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers[SCHEMA_VERSION_REQUEST_HEADER]).toBe(
        TALOS_EVENT_SCHEMA_VERSION,
      );
    }
  });

  it("Authorization and Last-Event-ID still sent alongside version header", async () => {
    const body1 = sseStream("id: evt-1\ndata: a\n\n");
    const body2 = sseStream("data: b\n\n");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      authHeader: "Bearer test-token",
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].headers["Authorization"]).toBe("Bearer test-token");
    expect(secondCall[1].headers["Last-Event-ID"]).toBe("evt-1");
    expect(secondCall[1].headers[SCHEMA_VERSION_REQUEST_HEADER]).toBe(
      TALOS_EVENT_SCHEMA_VERSION,
    );
  });
});

describe("TalosEventStream — schemaVersionInfo getter (#576)", () => {
  it("schemaVersionInfo is undefined before connect", () => {
    const stream = new TalosEventStream("http://localhost");
    expect(stream.schemaVersionInfo).toBeUndefined();
  });

  it("schemaVersionInfo is populated after a successful connection", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(body, {
        [SCHEMA_VERSION_RESPONSE_HEADER]: TALOS_EVENT_SCHEMA_VERSION,
      }),
    );
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const info = stream.schemaVersionInfo;
    expect(info).toBeDefined();
    expect(info!.compatible).toBe(true);
    expect(info!.negotiated).toBe(TALOS_EVENT_SCHEMA_VERSION);
    expect(info!.requested).toBe(TALOS_EVENT_SCHEMA_VERSION);
    expect(info!.serverAcknowledged).toBe(TALOS_EVENT_SCHEMA_VERSION);
  });

  it("schemaVersionInfo.compatible is true when server sends no ack header", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(stream.schemaVersionInfo?.compatible).toBe(true);
    expect(stream.schemaVersionInfo?.serverAcknowledged).toBeUndefined();
  });

  it("schemaVersionInfo.compatible is false on mismatch (non-strict)", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(body, { [SCHEMA_VERSION_RESPONSE_HEADER]: "99" }),
    );
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      strictSchemaVersionCheck: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(stream.schemaVersionInfo?.compatible).toBe(false);
    expect(stream.schemaVersionInfo?.serverAcknowledged).toBe("99");
  });
});

describe("TalosEventStream — strict schema version check (#576)", () => {
  it("strict mode: stream emits error and does not deliver events on mismatch", async () => {
    const body = sseStream("data: should-not-arrive\n\n");
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(body, { [SCHEMA_VERSION_RESPONSE_HEADER]: "99" }),
    );
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      strictSchemaVersionCheck: true,
    });
    const received: string[] = [];
    const errors: unknown[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.on("error", (err) => errors.push(err));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SchemaVersionMismatchError);
  });

  it("strict mode: stream proceeds normally when server acks matching version", async () => {
    const body = sseStream("data: hello\n\n");
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(body, {
        [SCHEMA_VERSION_RESPONSE_HEADER]: TALOS_EVENT_SCHEMA_VERSION,
      }),
    );
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      strictSchemaVersionCheck: true,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["hello"]);
  });

  it("non-strict mode: stream delivers events even on version mismatch", async () => {
    const body = sseStream("data: delivered\n\n");
    const mockFetch = vi.fn().mockResolvedValue(
      sseResponse(body, { [SCHEMA_VERSION_RESPONSE_HEADER]: "99" }),
    );
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      strictSchemaVersionCheck: false,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["delivered"]);
  });
});

// ── Regression: existing callers ──────────────────────────────────────────────

describe("TalosEventStream — regression: existing callers unaffected (#576)", () => {
  it("stream without schemaVersion option works exactly as before", async () => {
    const body = sseStream(
      'id: e1\nevent: activity.created\ndata: {"ok":true}\n\n',
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.type));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["activity.created"]);
  });

  it("TalosStreamError is still thrown for non-2xx responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue(errorResponse(401, "Unauthorized"));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const errors: unknown[] = [];
    stream.on("error", (e) => errors.push(e));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(errors[0]).toBeInstanceOf(TalosStreamError);
  });
});
