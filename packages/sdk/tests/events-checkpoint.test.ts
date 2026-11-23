/**
 * Resumable event subscription checkpoint interface — focused suite for #1408.
 *
 * Covers:
 *   - Persist the last acknowledged event identity through a caller-supplied
 *     store (auto + manual ack modes, load side seeds Last-Event-ID).
 *   - Distinguish server history gaps from ordinary reconnects, via both the
 *     response-header signal and the mid-stream `event: history.gap` signal.
 *   - Boundary: events without an id never anchor a checkpoint.
 *   - Failure: a misbehaving store (load/save throwing) is swallowed and never
 *     wedges the stream.
 *   - Compatibility: omitting the checkpoint store preserves prior behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosEventStream,
  InMemoryCheckpointStore,
} from "../src/index.js";
import type {
  CheckpointStore,
  EventStreamCheckpoint,
  HistoryGapInfo,
} from "../src/index.js";

// ── SSE stream helpers (mirrors events.test.ts) ────────────────────────────────

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
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

// ── Test setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Checkpoint persistence ─────────────────────────────────────────────────────

describe("TalosEventStream — checkpoint persistence (#1408)", () => {
  it("seeds Last-Event-ID from a caller-supplied checkpoint on connect", async () => {
    const store = new InMemoryCheckpointStore();
    await store.save({
      eventId: "cp-1",
      recordedAt: "2024-01-01T00:00:00.000Z",
    });

    const body = sseStream("data: hi\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    stream.connect();
    await vi.runAllTimersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers["Last-Event-ID"]).toBe("cp-1");
  });

  it("auto-acks: persists the last acknowledged event identity after delivery", async () => {
    const store = new InMemoryCheckpointStore();
    const body = sseStream('id: evt-9\nevent: activity.created\ndata: {"x":1}\n\n');
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    const received: (string | undefined)[] = [];
    stream.on("event", (e) => {
      received.push(e.id);
    });
    stream.connect();
    await vi.runAllTimersAsync();

    expect(received).toEqual(["evt-9"]);
    const cp = await store.load();
    expect(cp).toBeDefined();
    expect(cp?.eventId).toBe("evt-9");
    expect(cp?.hadHistoryGap).toBe(false);
    expect(typeof cp?.recordedAt).toBe("string");
  });

  it("manual-acks: persists only when the caller acknowledges", async () => {
    const store = new InMemoryCheckpointStore();
    const body = sseStream('id: evt-9\ndata: hi\n\n');
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      ackMode: "manual",
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    stream.on("event", () => undefined);
    stream.connect();
    await vi.runAllTimersAsync();

    // Delivery alone must not persist in manual mode.
    expect(await store.load()).toBeUndefined();

    await stream.acknowledge("evt-9");
    const cp = await store.load();
    expect(cp?.eventId).toBe("evt-9");
  });

  it("boundary: events without an id never anchor a checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const body = sseStream("data: no-id\n\n");
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    stream.on("event", () => undefined);
    stream.connect();
    await vi.runAllTimersAsync();

    expect(await store.load()).toBeUndefined();
  });

  it("compatibility: omitting the checkpoint store preserves prior behavior", async () => {
    const body = sseStream('id: evt-1\ndata: hi\n\n');
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    const received: string[] = [];
    stream.on("event", (e) => {
      received.push(e.data);
    });
    stream.connect();
    await vi.runAllTimersAsync();

    // No checkpoint store → no Last-Event-ID on first connect, event delivered.
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty("Last-Event-ID");
    expect(received).toEqual(["hi"]);
    expect(stream.hadHistoryGapOnLastResume).toBe(false);
  });
});

// ── History gap detection ──────────────────────────────────────────────────────

describe("TalosEventStream — history gap detection (#1408)", () => {
  it("surfaces a history gap via the response header on reconnect", async () => {
    const body1 = sseStream('id: id-1\ndata: a\n\n');
    const body2 = sseStream('id: id-2\ndata: b\n\n');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2, { "x-talos-stream-gap": "true", "x-talos-stream-gap-reason": "rotated" }));

    const gaps: HistoryGapInfo[] = [];
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      onHistoryGap: (info) => gaps.push(info),
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });

    stream.connect();
    await vi.runAllTimersAsync();

    expect(gaps).toHaveLength(1);
    expect(gaps[0].signal).toBe("response-header");
    expect(gaps[0].requestedAfterEventId).toBe("id-1");
    expect(gaps[0].reason).toBe("rotated");
    expect(stream.hadHistoryGapOnLastResume).toBe(true);
  });

  it("ordinary reconnect does not signal a gap (the distinction)", async () => {
    const body1 = sseStream('id: id-1\ndata: a\n\n');
    const body2 = sseStream('id: id-2\ndata: b\n\n');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));

    const gaps: HistoryGapInfo[] = [];
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      onHistoryGap: (info) => gaps.push(info),
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });

    stream.connect();
    await vi.runAllTimersAsync();

    expect(gaps).toHaveLength(0);
    expect(stream.hadHistoryGapOnLastResume).toBe(false);
  });

  it("surfaces a history gap via an in-stream `event: history.gap` control event", async () => {
    const body = sseStream(
      'event: history.gap\ndata: {"reason":"rotated","firstAvailableEventId":"id-50"}\n\n',
      'id: id-60\nevent: activity.created\ndata: ok\n\n',
    );
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));

    const gaps: HistoryGapInfo[] = [];
    const received: { id?: string; type: string }[] = [];
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      onHistoryGap: (info) => gaps.push(info),
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    stream.on("event", (e) => {
      received.push({ id: e.id, type: e.type });
    });

    stream.connect();
    await vi.runAllTimersAsync();

    // The gap control event is surfaced, not dispatched, and never advances
    // the resume cursor.
    expect(gaps).toHaveLength(1);
    expect(gaps[0].signal).toBe("event");
    expect(gaps[0].reason).toBe("rotated");
    expect(gaps[0].firstAvailableEventId).toBe("id-50");
    expect(received).toEqual([{ id: "id-60", type: "activity.created" }]);
    expect(stream.lastSeenEventId).toBe("id-60");
    expect(stream.hadHistoryGapOnLastResume).toBe(true);
  });

  it("records the gap distinction on the persisted checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const body1 = sseStream('id: id-1\ndata: a\n\n');
    const body2 = sseStream('id: id-2\ndata: b\n\n');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2, { "x-talos-stream-gap": "true" }));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    stream.on("event", () => undefined);

    stream.connect();
    await vi.runAllTimersAsync();

    const cp = await store.load();
    // Last acknowledged identity is id-2, and it carries the gap flag.
    expect(cp?.eventId).toBe("id-2");
    expect(cp?.hadHistoryGap).toBe(true);
  });

  it("ordinary reconnect records a clean (non-gap) checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const body1 = sseStream('id: id-1\ndata: a\n\n');
    const body2 = sseStream('id: id-2\ndata: b\n\n');
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(body1))
      .mockResolvedValueOnce(sseResponse(body2));

    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: store,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 1,
      baseReconnectDelayMs: 0,
      jitter: false,
    });
    stream.on("event", () => undefined);

    stream.connect();
    await vi.runAllTimersAsync();

    const cp = await store.load();
    expect(cp?.eventId).toBe("id-2");
    expect(cp?.hadHistoryGap).toBe(false);
  });
});

// ── Failure: misbehaving store ─────────────────────────────────────────────────

describe("TalosEventStream — misbehaving checkpoint store (#1408)", () => {
  it("swallows a throwing load() and still connects", async () => {
    const brokenStore: CheckpointStore = {
      load: async () => {
        throw new Error("disk gone");
      },
      save: async () => undefined,
      clear: async () => undefined,
    };
    const body = sseStream('id: evt-1\ndata: hi\n\n');
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: brokenStore,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    const received: string[] = [];
    stream.on("event", (e) => {
      received.push(e.data);
    });
    stream.connect();
    await vi.runAllTimersAsync();

    // load() threw → no Last-Event-ID seeded, event still delivered, no throw.
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty("Last-Event-ID");
    expect(received).toEqual(["hi"]);
  });

  it("swallows a throwing save() and keeps delivering events", async () => {
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const brokenStore: CheckpointStore = {
      load: async () => undefined,
      save,
      clear: async () => undefined,
    };
    const body = sseStream('id: evt-1\ndata: hi\n\n');
    const mockFetch = vi.fn().mockResolvedValue(sseResponse(body));
    const stream = new TalosEventStream("http://localhost", {
      fetch: mockFetch,
      checkpointStore: brokenStore,
      heartbeatIntervalMs: 0,
      maxReconnectAttempts: 0,
    });

    const received: string[] = [];
    stream.on("event", (e) => {
      received.push(e.data);
    });
    stream.connect();
    await vi.runAllTimersAsync();

    expect(save).toHaveBeenCalledTimes(1);
    // The failing save never wedged delivery.
    expect(received).toEqual(["hi"]);
  });
});

// ── InMemoryCheckpointStore ────────────────────────────────────────────────────

describe("InMemoryCheckpointStore (#1408)", () => {
  it("returns undefined before any save", async () => {
    const s = new InMemoryCheckpointStore();
    expect(await s.load()).toBeUndefined();
  });

  it("round-trips a saved checkpoint", async () => {
    const s = new InMemoryCheckpointStore();
    const cp: EventStreamCheckpoint = {
      eventId: "e-1",
      recordedAt: "2024-01-01T00:00:00.000Z",
      hadHistoryGap: false,
    };
    await s.save(cp);
    expect(await s.load()).toEqual(cp);
  });

  it("clear() drops the checkpoint", async () => {
    const s = new InMemoryCheckpointStore();
    await s.save({ eventId: "e-1", recordedAt: "2024-01-01T00:00:00.000Z" });
    await s.clear();
    expect(await s.load()).toBeUndefined();
  });
});
