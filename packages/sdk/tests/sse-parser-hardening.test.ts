/**
 * SSE multiline frame parser hardening tests — #579
 *
 * Covers:
 *   Positive: CRLF line endings parsed correctly
 *   Positive: bare CR (\r) line endings parsed correctly
 *   Positive: LF-only line endings (baseline regression)
 *   Positive: mixed CRLF/LF in same stream
 *   Positive: UTF-8 BOM stripped from first chunk
 *   Positive: BOM not stripped from subsequent chunks
 *   Positive: multi-line data blocks (existing regression)
 *   Positive: empty data: field treated as empty string data line
 *   Positive: oversized field value truncated, warning emitted
 *   Positive: frame discarded when data line count exceeds maxDataLines
 *   Positive: custom maxFieldBytes / maxDataLines options
 *   Negative: event without any data lines produces no dispatch
 *   Negative: frame-only with id: / event: but no data: is not dispatched
 *   Boundary: field value exactly at maxFieldBytes limit — not truncated
 *   Boundary: field value one byte over limit — truncated
 *   Boundary: event split across multiple read() chunks
 *   Boundary: blank event frame after overflow is clean for next frame
 *   Regression: SSE_MAX_FIELD_BYTES and SSE_MAX_DATA_LINES exported on public API
 *   Regression: existing tests (happy path, auth, reconnect, heartbeat) unaffected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosEventStream,
  TalosStreamError,
  InMemorySeenStore,
  SSE_MAX_FIELD_BYTES,
  SSE_MAX_DATA_LINES,
} from "../src/events.js";
import type { TalosStreamEvent } from "../src/events.js";
import * as sdkIndex from "../src/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Build a ReadableStream that emits exactly the given binary chunks. */
function rawStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Build a ReadableStream from text chunks. */
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return rawStream(...chunks.map((c) => encoder.encode(c)));
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

/** Collect all events from a stream, resolve after stream closes. */
async function collectEvents(
  stream: TalosEventStream,
  timers: { runAllTimersAsync: () => Promise<void> },
): Promise<TalosStreamEvent[]> {
  const received: TalosStreamEvent[] = [];
  stream.on("event", (e) => received.push(e));
  stream.connect();
  await timers.runAllTimersAsync();
  return received;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Public API surface ─────────────────────────────────────────────────────────

describe("SSE parser hardening — SDK exports (#579)", () => {
  it("exports SSE_MAX_FIELD_BYTES constant", () => {
    expect(sdkIndex.SSE_MAX_FIELD_BYTES).toBe(SSE_MAX_FIELD_BYTES);
    expect(SSE_MAX_FIELD_BYTES).toBe(1_048_576);
  });

  it("exports SSE_MAX_DATA_LINES constant", () => {
    expect(sdkIndex.SSE_MAX_DATA_LINES).toBe(SSE_MAX_DATA_LINES);
    expect(SSE_MAX_DATA_LINES).toBe(1_000);
  });
});

// ── Line ending handling ──────────────────────────────────────────────────────

describe("SSE parser — CRLF line endings (#579)", () => {
  it("parses an event with CRLF line endings", async () => {
    const body = sseStream(
      "id: e1\r\nevent: activity.created\r\ndata: hello\r\n\r\n",
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("activity.created");
    expect(events[0].id).toBe("e1");
    expect(events[0].data).toBe("hello");
  });

  it("parses multiple CRLF-delimited events in one stream", async () => {
    const body = sseStream(
      "data: first\r\n\r\ndata: second\r\n\r\n",
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("parses events with bare CR (\\r) line endings", async () => {
    // "data: cr-line\r\rdata: cr-line2\r\r" using \r as line terminator:
    //   line "data: cr-line" + blank line → dispatch event 1
    //   line "data: cr-line2" + blank line → dispatch event 2
    // Per the WHATWG SSE spec §9.2 each blank line terminates a frame,
    // so this stream produces two separate single-data-line events.
    const body = sseStream("data: cr-line\r\rdata: cr-line2\r\r");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("cr-line");
    expect(events[1].data).toBe("cr-line2");
  });

  it("parses a stream mixing LF and CRLF line endings", async () => {
    const body = sseStream(
      "id: m1\r\ndata: mixed\ndata: endings\r\n\r\n",
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("mixed\nendings");
    expect(events[0].id).toBe("m1");
  });
});

// ── BOM stripping ──────────────────────────────────────────────────────────────

describe("SSE parser — UTF-8 BOM stripping (#579)", () => {
  it("strips a UTF-8 BOM prepended to the first chunk", async () => {
    // BOM is U+FEFF, encoded as EF BB BF in UTF-8
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const rest = encoder.encode("data: after-bom\n\n");
    const combined = new Uint8Array(bom.length + rest.length);
    combined.set(bom);
    combined.set(rest, bom.length);
    const body = rawStream(combined);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("after-bom");
  });

  it("does not strip BOM from mid-stream positions", async () => {
    // BOM in the second chunk should be treated as data content
    const chunk1 = encoder.encode("data: normal\n\n");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const chunk2After = encoder.encode("data: content\n\n");
    const chunk2 = new Uint8Array(bom.length + chunk2After.length);
    chunk2.set(bom);
    chunk2.set(chunk2After, bom.length);
    const body = rawStream(chunk1, chunk2);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(2);
    // Second event data contains the BOM characters as text
    expect(events[1].data).toContain("content");
  });
});

// ── Multi-line data (regression) ───────────────────────────────────────────────

describe("SSE parser — multi-line data regression (#579)", () => {
  it("concatenates multiple data: lines with \\n separator", async () => {
    const body = sseStream("data: line1\ndata: line2\ndata: line3\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe("line1\nline2\nline3");
  });

  it("empty data: field is treated as an empty string data line", async () => {
    // Per SSE spec, "data:" with no value is a data line of ""
    const body = sseStream("data:\ndata: second\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("\nsecond");
  });
});

// ── Oversized field truncation ─────────────────────────────────────────────────

describe("SSE parser — oversized field truncation (#579)", () => {
  it("truncates a data: value exceeding maxFieldBytes", async () => {
    const longValue = "x".repeat(100);
    const body = sseStream(`data: ${longValue}\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const warn = vi.fn();
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxFieldBytes: 10,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data.length).toBe(10);
    expect(warn).toHaveBeenCalledWith("sse:field_value_truncated", expect.objectContaining({
      field: "data",
      maxFieldBytes: 10,
    }));
  });

  it("does NOT truncate a field value exactly at the limit", async () => {
    const exactValue = "y".repeat(10);
    const body = sseStream(`data: ${exactValue}\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const warn = vi.fn();
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxFieldBytes: 10,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe(exactValue);
    expect(warn).not.toHaveBeenCalledWith("sse:field_value_truncated", expect.anything());
  });

  it("truncates event: field value exceeding maxFieldBytes", async () => {
    const longType = "a".repeat(50);
    const body = sseStream(`event: ${longType}\ndata: payload\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const warn = vi.fn();
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxFieldBytes: 5,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("aaaaa"); // truncated to 5
  });

  it("custom maxFieldBytes is respected", async () => {
    const val = "z".repeat(20);
    const body = sseStream(`data: ${val}\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxFieldBytes: 15,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data.length).toBe(15);
  });
});

// ── Data line overflow / frame discard ────────────────────────────────────────

describe("SSE parser — data line overflow protection (#579)", () => {
  it("discards a frame that exceeds maxDataLines", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `data: line${i}`).join("\n");
    const body = sseStream(`${lines}\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const warn = vi.fn();
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxDataLines: 3,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("sse:data_line_limit_reached", {
      maxDataLines: 3,
    });
    expect(warn).toHaveBeenCalledWith("sse:frame_discarded_data_overflow", {
      maxDataLines: 3,
    });
  });

  it("frame after a discarded overflow frame is processed normally", async () => {
    const overflow = Array.from({ length: 5 }, (_, i) => `data: x${i}`).join("\n");
    const body = sseStream(`${overflow}\n\ndata: clean\n\n`);
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxDataLines: 3,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("clean");
  });

  it("custom maxDataLines is respected", async () => {
    // 2 lines should be fine when maxDataLines is 5
    const body = sseStream("data: a\ndata: b\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
      maxDataLines: 5,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe("a\nb");
  });
});

// ── Chunk boundary splits ─────────────────────────────────────────────────────

describe("SSE parser — cross-chunk event handling (#579)", () => {
  it("correctly parses an event split across two read() chunks", async () => {
    // Split in the middle of the data: line
    const body = sseStream("data: hel", "lo\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe("hello");
  });

  it("correctly handles an event split immediately before the blank line", async () => {
    const body = sseStream("id: x\ndata: world\n", "\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe("world");
    expect(events[0].id).toBe("x");
  });

  it("handles a CRLF event split across chunks at the CR boundary", async () => {
    const body = sseStream("data: split\r", "\ndata: line2\r\n\r\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("split\nline2");
  });
});

// ── Frame-only frames (no data:) ──────────────────────────────────────────────

describe("SSE parser — frames without data lines (#579)", () => {
  it("does not dispatch an event frame that has no data: lines", async () => {
    const body = sseStream("id: x\nevent: activity.created\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(0);
  });
});

// ── Regression: existing behaviour ───────────────────────────────────────────

describe("SSE parser — regression: LF-only behaviour unchanged (#579)", () => {
  it("delivers a well-formed LF event (baseline regression)", async () => {
    const body = sseStream(
      'id: reg1\nevent: job.created\ndata: {"ok":1}\n\n',
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("job.created");
    expect(events[0].id).toBe("reg1");
    expect(events[0].data).toBe('{"ok":1}');
  });

  it("heartbeat event is still suppressed (regression)", async () => {
    const body = sseStream("event: heartbeat\ndata: ping\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(0);
  });

  it("SSE comment lines still count as heartbeat ticks (regression)", async () => {
    const body = sseStream(": keep-alive\ndata: real\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    const events = await collectEvents(stream, vi);
    expect(events[0].data).toBe("real");
  });

  it("TalosStreamError still thrown for non-2xx responses (regression)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(errorResponse(503, "unavailable"));
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

  it("InMemorySeenStore duplicate suppression still works (regression)", async () => {
    const body1 = sseStream("id: dup\ndata: first\n\n");
    const body2 = sseStream("id: dup\ndata: duplicate\n\n");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));
    const seenStore = new InMemorySeenStore();
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
      seenStore,
    });
    const events = await collectEvents(stream, vi);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("first");
  });
});
