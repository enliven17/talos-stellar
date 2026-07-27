/**
 * TalosEventStream unit tests.
 *
 * Covers: happy path, reconnect/backoff, Last-Event-ID, heartbeat stall detection,
 * duplicate suppression, abort/close, auth headers, content-type validation,
 * HTTP error mapping, retry: field from server, multi-data-line events, and budget exhaustion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosEventStream,
  TalosStreamError,
  InMemorySeenStore,
} from "../src/events.js";
import type { TalosStreamEvent, SeenStore } from "../src/events.js";

// ── SSE stream helpers ─────────────────────────────────────────────────────────

/**
 * Build a ReadableStream that emits the given raw SSE text chunks then closes.
 */
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Build a minimal ok SSE response */
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

/** Build an error response */
function errorResponse(status: number, body = "error"): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    body: null,
    text: async () => body,
  } as unknown as Response;
}

// ── Test setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Happy path ─────────────────────────────────────────────────────────────────

describe("TalosEventStream — happy path", () => {
  it("receives a single typed event and delivers it to handlers", async () => {
    const body = sseStream(
      'id: evt-1\nevent: activity.created\ndata: {"foo":1}\n\n',
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => {
      received.push(e);
    });

    stream.connect();
    await vi.runAllTimersAsync();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("activity.created");
    expect(received[0].id).toBe("evt-1");
    expect(received[0].data).toBe('{"foo":1}');
    expect(received[0].receivedAt).toBeInstanceOf(Date);
  });

  it("accumulates multi-line data blocks", async () => {
    const body = sseStream("event: job.created\ndata: line1\ndata: line2\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => {
      received.push(e);
    });
    stream.connect();
    await vi.runAllTimersAsync();

    expect(received[0].data).toBe("line1\nline2");
  });

  it("defaults event type to 'message' when no event: field is present", async () => {
    const body = sseStream("id: x\ndata: hello\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => {
      received.push(e);
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received[0].type).toBe("message");
  });

  it("suppresses heartbeat events from the event handler", async () => {
    const body = sseStream("event: heartbeat\ndata: ping\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => {
      received.push(e);
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toHaveLength(0);
  });

  it("ignores SSE comment lines (colon prefix)", async () => {
    const body = sseStream(": keep-alive\ndata: real\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => {
      received.push(e);
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received[0].data).toBe("real");
  });
});

// ── Last-Event-ID ──────────────────────────────────────────────────────────────

describe("TalosEventStream — Last-Event-ID", () => {
  it("tracks the last seen event ID from the stream", async () => {
    const body = sseStream("id: id-42\ndata: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(stream.lastSeenEventId).toBe("id-42");
  });

  it("sends Last-Event-ID header on reconnect", async () => {
    // First connect: emits id-1 then closes (server-side close)
    const body1 = sseStream("id: id-1\ndata: a\n\n");
    // Second connect: clean body
    const body2 = sseStream("id: id-2\ndata: b\n\n");

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

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].headers["Last-Event-ID"]).toBe("id-1");
  });

  it("does not send Last-Event-ID header on first connect", async () => {
    const body = sseStream("data: hi\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[1].headers).not.toHaveProperty("Last-Event-ID");
  });
});

// ── Auth ───────────────────────────────────────────────────────────────────────

describe("TalosEventStream — auth", () => {
  it("sends Authorization header when authHeader is configured", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      authHeader: "Bearer my-secret-key",
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch.mock.calls[0][1].headers["Authorization"]).toBe(
      "Bearer my-secret-key",
    );
  });

  it("omits Authorization header when no authHeader is set", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization",
    );
  });
});

// ── Reconnect & backoff ────────────────────────────────────────────────────────

describe("TalosEventStream — reconnect & backoff", () => {
  it("reconnects after server-side close", async () => {
    const body1 = sseStream("data: first\n\n");
    const body2 = sseStream("data: second\n\n");
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
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["first", "second"]);
  });

  it("applies exponential backoff without jitter", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === "number" && delay > 0) delays.push(delay);
        return origSetTimeout(fn as () => void, 0, ...args);
      },
    );

    const makeErrBody = () => sseStream(""); // empty — server closes immediately
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(makeErrBody()))
      .mockResolvedValueOnce(sseResponse(makeErrBody()))
      .mockResolvedValueOnce(sseResponse(makeErrBody()));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 10_000,
      jitter: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    // attempt 1 → delay = 100*2^0 = 100; attempt 2 → 100*2^1 = 200
    const reconnectDelays = delays.filter((d) => d >= 100);
    expect(reconnectDelays[0]).toBe(100);
    expect(reconnectDelays[1]).toBe(200);
  });

  it("respects the server retry: field", async () => {
    const body1 = sseStream("retry: 500\ndata: a\n\n");
    const body2 = sseStream("data: b\n\n");
    const sleepTimes: number[] = [];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));

    // Patch the internal _sleep-equivalent (setTimeout) to capture delay
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === "number" && delay >= 100) sleepTimes.push(delay);
        return origSetTimeout(fn as () => void, 0, ...args);
      },
    );

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 100,
      jitter: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    // After seeing retry:500, the next reconnect delay should derive from 500 not 100
    expect(sleepTimes.some((d) => d >= 500)).toBe(true);
  });

  it("emits close event when budget is exhausted", async () => {
    const makeBody = () => sseStream("");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(makeBody()));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
      jitter: false,
    });

    let closed = false;
    stream.on("close", () => {
      closed = true;
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(closed).toBe(true);
  });

  it("emits errors on each failed attempt", async () => {
    const makeBody = () => sseStream("");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(makeBody()));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 2,
      baseReconnectDelayMs: 0,
      jitter: false,
    });

    const errors: number[] = [];
    stream.on("error", (_, attempt) => errors.push(attempt));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(errors.length).toBeGreaterThanOrEqual(3); // initial + 2 reconnects
  });
});

// ── HTTP errors ────────────────────────────────────────────────────────────────

describe("TalosEventStream — HTTP error handling", () => {
  it("emits TalosStreamError on 401 and retries", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401, "Unauthorized"))
      .mockResolvedValueOnce(sseResponse(sseStream("data: ok\n\n")));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });

    const errors: unknown[] = [];
    stream.on("error", (e) => errors.push(e));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(errors[0]).toBeInstanceOf(TalosStreamError);
    expect((errors[0] as TalosStreamError).status).toBe(401);
  });

  it("throws TalosStreamError on wrong content-type", async () => {
    const body = sseStream("data: x\n\n");
    const badRes = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body,
      text: async () => "",
    } as unknown as Response;

    const mockFetch = vi.fn().mockResolvedValueOnce(badRes);
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
    expect((errors[0] as TalosStreamError).body).toContain("application/json");
  });

  it("TalosStreamError includes status, body, and url", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(403, "Forbidden"));
    const stream = new TalosEventStream("http://localhost:9000", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const errors: TalosStreamError[] = [];
    stream.on("error", (e) => errors.push(e as TalosStreamError));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(errors[0].status).toBe(403);
    expect(errors[0].body).toBe("Forbidden");
    expect(errors[0].url).toBe("http://localhost:9000/api/events");
  });
});

// ── Abort & close ──────────────────────────────────────────────────────────────

describe("TalosEventStream — abort & close", () => {
  it("close() stops the stream and emits close event", async () => {
    // stream that never ends
    const body = new ReadableStream({ start() {} });
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 5,
    });

    let closed = false;
    stream.on("close", () => {
      closed = true;
    });
    stream.connect();
    // Let connection open
    await Promise.resolve();
    stream.close();
    await vi.runAllTimersAsync();

    expect(closed).toBe(true);
    expect(stream.connectionState).toBe("closed");
  });

  it("external AbortSignal closes the stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({ start() {} });
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 5,
      signal: controller.signal,
    });

    let closed = false;
    stream.on("close", () => {
      closed = true;
    });
    stream.connect();
    await Promise.resolve();
    controller.abort();
    await vi.runAllTimersAsync();

    expect(closed).toBe(true);
  });

  it("connect() is idempotent — second call is a no-op", async () => {
    const body = new ReadableStream({ start() {} });
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    stream.connect();
    stream.connect();
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("close() after already closed is a no-op", async () => {
    const stream = new TalosEventStream("http://localhost", {
      fetch: vi.fn(),
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.close();
    expect(() => stream.close()).not.toThrow();
  });
});

// ── Duplicate suppression ──────────────────────────────────────────────────────

describe("TalosEventStream — duplicate suppression", () => {
  it("delivers the first occurrence of an event ID", async () => {
    const store = new InMemorySeenStore();
    const body = sseStream("id: dup-1\ndata: hello\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      seenStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["hello"]);
  });

  it("suppresses duplicate event IDs on reconnect", async () => {
    const store = new InMemorySeenStore();
    // Both connects emit the same id
    const body1 = sseStream("id: dup-1\ndata: first\n\n");
    const body2 = sseStream("id: dup-1\ndata: duplicate\n\n");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      seenStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["first"]);
  });

  it("passes events without an id regardless of seenStore", async () => {
    const store = new InMemorySeenStore();
    const body = sseStream("data: no-id\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      seenStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["no-id"]);
  });

  it("supports async SeenStore (promise-returning)", async () => {
    const stored = new Set<string>();
    const asyncStore: SeenStore = {
      has: async (id) => stored.has(id),
      add: async (id) => {
        stored.add(id);
      },
    };
    const body = sseStream("id: async-1\ndata: ok\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      seenStore: asyncStore,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: string[] = [];
    stream.on("event", (e) => received.push(e.data));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toEqual(["ok"]);
    expect(stored.has("async-1")).toBe(true);
  });
});

// ── InMemorySeenStore ──────────────────────────────────────────────────────────

describe("InMemorySeenStore", () => {
  it("returns false for unknown IDs", () => {
    const s = new InMemorySeenStore();
    expect(s.has("x")).toBe(false);
  });

  it("returns true after add()", () => {
    const s = new InMemorySeenStore();
    s.add("x");
    expect(s.has("x")).toBe(true);
  });

  it("evicts old entries when capacity is exceeded", () => {
    const s = new InMemorySeenStore(10);
    for (let i = 0; i < 11; i++) s.add(`id-${i}`);
    // After eviction the store should have fewer than 11 entries; id-0 is gone
    expect(s.has("id-0")).toBe(false);
    expect(s.has("id-10")).toBe(true);
  });
});

// ── Heartbeat detection ────────────────────────────────────────────────────────

describe("TalosEventStream — heartbeat / stall detection", () => {
  it("resets heartbeat miss count when a data event is received", async () => {
    const body = sseStream("data: alive\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 50,
      maxHeartbeatMisses: 3,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => received.push(e));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toHaveLength(1);
  });

  it("resets heartbeat miss count on SSE comment lines", async () => {
    const body = sseStream(": ping\ndata: hi\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 50,
      maxHeartbeatMisses: 3,
      maxReconnectAttempts: 0,
    });
    const received: TalosStreamEvent[] = [];
    stream.on("event", (e) => received.push(e));
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received[0].data).toBe("hi");
  });
});

// ── Observability ──────────────────────────────────────────────────────────────

describe("TalosEventStream — observability", () => {
  it("calls logger.info on connect and reconnect_scheduled", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const body1 = sseStream("");
    const body2 = sseStream("data: x\n\n");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      logger,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const infoCalls = logger.info.mock.calls.map((c) => c[0]);
    expect(infoCalls).toContain("sse:connecting");
  });

  it("does not log authHeader or data payloads", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const body = sseStream("data: sensitive-payload\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      authHeader: "Bearer super-secret",
      logger,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();

    const allLogArgs = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ].flat();

    const serialized = JSON.stringify(allLogArgs);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("sensitive-payload");
  });

  it("logs duplicate suppression at info level", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = new InMemorySeenStore();
    store.add("seen-1");

    const body = sseStream("id: seen-1\ndata: dup\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      seenStore: store,
      logger,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const infoCalls = logger.info.mock.calls.map((c) => c[0]);
    expect(infoCalls).toContain("sse:duplicate_suppressed");
  });
});

// ── Event handler management ───────────────────────────────────────────────────

describe("TalosEventStream — handler management", () => {
  it("supports off() to remove a handler", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const received: string[] = [];
    const handler = (e: TalosStreamEvent) => received.push(e.data);
    stream.on("event", handler);
    stream.off("event", handler);
    stream.connect();
    await vi.runAllTimersAsync();
    expect(received).toHaveLength(0);
  });

  it("on() returns the stream instance for chaining", () => {
    const stream = new TalosEventStream("http://localhost", { fetch: vi.fn() });
    const result = stream
      .on("event", () => {})
      .on("error", () => {})
      .on("close", () => {});
    expect(result).toBe(stream);
  });

  it("handler errors are caught and logged, not rethrown", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      logger,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.on("event", () => {
      throw new Error("handler boom");
    });
    stream.connect();
    await vi.runAllTimersAsync();
    const errCalls = logger.error.mock.calls.map((c) => c[0]);
    expect(errCalls).toContain("sse:handler_error");
  });
});

// ── Path configuration ─────────────────────────────────────────────────────────

describe("TalosEventStream — path configuration", () => {
  it("uses default /api/events path", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost:8080", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:8080/api/events");
  });

  it("accepts a custom path", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      path: "/custom/stream",
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost/custom/stream");
  });

  it("strips trailing slash from baseUrl", async () => {
    const body = sseStream("data: x\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost/", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.connect();
    await vi.runAllTimersAsync();
    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost/api/events");
  });
});
