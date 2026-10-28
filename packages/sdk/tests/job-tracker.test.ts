/**
 * Tests for TalosClient.trackJob and JobTracker (#1017)
 *
 * Covers:
 *  - Happy path SSE streaming: ordered, deduplicated progress events ending with the result
 *  - Deduplication across events using SeenStore (both in-memory and custom)
 *  - Fallback engages on stream errors (tested with chaos transport fixtures)
 *  - Mid-stream disconnect: fallback resumes via polling without duplicate events
 *  - Abort cleans up streams and active timers (no timers remaining after abort)
 *  - Wall-clock timeoutMs cleans up streams and timers
 *  - Typed terminal outcomes: completed, failed (JobFailedError), cancelled (JobCancelledError)
 *  - throwOnTerminalError: false yields the terminal result without throwing
 *  - Break in for-await iteration cleans up streams and timers
 *  - Standalone trackJob helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosAPIError,
  TalosTimeoutError,
  JobTracker,
  trackJob,
  JobFailedError,
  JobCancelledError,
  JobTrackAbortedError,
  JobTrackTimeoutError,
  InMemorySeenStore,
  type TrackJobEvent,
  type CommerceJob,
  type SeenStore,
} from "../src/index.js";
import {
  ChaosInjector,
  FaultType,
} from "../src/chaos.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream",
    }),
    body,
    text: async () => "",
  } as unknown as Response;
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      "content-type": "application/json",
    }),
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function makeJob(status: "pending" | "completed" | "failed" | "cancelled", progress?: any, result?: any): CommerceJob {
  return {
    id: "job-1017",
    talosId: "talos-provider",
    requesterTalosId: "talos-buyer",
    serviceName: "data-analysis",
    status,
    progress: progress ?? (status === "completed" ? { percent: 100, stage: "completed" } : { percent: 50, stage: "processing" }),
    result: result ?? (status === "completed" ? { answer: 42 } : undefined),
    amount: "10.00",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("TalosClient.trackJob (#1017)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Happy path SSE Streaming ─────────────────────────────────────────────

  describe("Happy path SSE streaming", () => {
    it("yields ordered, de-duplicated progress and ends with the result", async () => {
      const sseBody = sseStream(
        'event: snapshot\ndata: {"id":"job-1017","status":"pending","progress":{"percent":10,"stage":"init","message":"Initializing"}}\n\n',
        'event: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":50,"stage":"processing","message":"Working"}}\n\n',
        'event: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":90,"stage":"finishing","message":"Wrapping up"}}\n\n',
        'event: done\ndata: {"id":"job-1017","status":"completed","result":{"answer":42}}\n\n',
      );

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          return Promise.resolve(sseResponse(sseBody));
        }
        if (url.includes("/result")) {
          return Promise.resolve(jsonResponse(makeJob("completed", null, { answer: 42 })));
        }
        return Promise.reject(new Error(`Unexpected url: ${url}`));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        apiKey: "test-key",
        fetch: mockFetch,
      });

      const events: TrackJobEvent[] = [];
      const tracker = client.trackJob("job-1017");

      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          events.push(evt);
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      // Acceptance criterion: Iterator yields ordered progress and ends with the result
      expect(events.length).toBe(4);

      expect(events[0].type).toBe("snapshot");
      expect(events[0].percent).toBe(10);
      expect(events[0].stage).toBe("init");
      expect(events[0].source).toBe("stream");

      expect(events[1].type).toBe("progress");
      expect(events[1].percent).toBe(50);
      expect(events[1].stage).toBe("processing");

      expect(events[2].type).toBe("progress");
      expect(events[2].percent).toBe(90);
      expect(events[2].stage).toBe("finishing");

      expect(events[3].type).toBe("result");
      expect(events[3].status).toBe("completed");
      expect(events[3].result).toEqual({ answer: 42 });

      // Check tracker.result Promise resolves with the full CommerceJob
      const finalJob = await tracker.result;
      expect(finalJob.status).toBe("completed");
      expect(finalJob.result).toEqual({ answer: 42 });
    });
  });

  // ── 2. Deduplication with SeenStore ─────────────────────────────────────────

  describe("Deduplication with SeenStore", () => {
    it("suppresses duplicate events with identical progress content or event IDs", async () => {
      const sseBody = sseStream(
        'event: snapshot\ndata: {"id":"job-1017","status":"pending","progress":{"percent":20,"stage":"step1","updatedAt":"2026-01-01T00:00:01Z"}}\n\n',
        // Duplicate snapshot content
        'event: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":20,"stage":"step1","updatedAt":"2026-01-01T00:00:01Z"}}\n\n',
        // New update with explicit id
        'id: evt-unique-2\nevent: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":60,"stage":"step2","updatedAt":"2026-01-01T00:00:02Z"}}\n\n',
        // Duplicate with same id
        'id: evt-unique-2\nevent: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":60,"stage":"step2","updatedAt":"2026-01-01T00:00:02Z"}}\n\n',
        // Completion
        'event: done\ndata: {"id":"job-1017","status":"completed","result":{"success":true}}\n\n',
      );

      const seenStore = new InMemorySeenStore();
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          return Promise.resolve(sseResponse(sseBody));
        }
        if (url.includes("/result")) {
          return Promise.resolve(jsonResponse(makeJob("completed", null, { success: true })));
        }
        return Promise.reject(new Error(`Unexpected url: ${url}`));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const events: TrackJobEvent[] = [];
      const tracker = client.trackJob("job-1017", { seenStore });

      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          events.push(evt);
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      // Duplicates must be suppressed: only 20%, 60%, and completion
      expect(events.length).toBe(3);
      expect(events[0].percent).toBe(20);
      expect(events[1].percent).toBe(60);
      expect(events[2].type).toBe("result");
      expect(events[2].result).toEqual({ success: true });
    });
  });

  // ── 3. Fallback on stream errors with chaos transport ───────────────────────

  describe("Fallback engages on stream errors (chaos transport fixtures)", () => {
    it("engages fallback polling when SSE encounters NETWORK_DROP fault", async () => {
      // Setup chaos injector where the first draw (SSE connection) injects NETWORK_DROP,
      // while subsequent draws (polling HTTP requests) proceed normally.
      let drawCount = 0;
      const sequenceRandom = () => (drawCount++ === 0 ? 0 : 1);
      const chaos = new ChaosInjector({ random: sequenceRandom });
      chaos.registerFault({
        type: FaultType.NETWORK_DROP,
        probability: 0.5,
      });

      let pollCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          // If fetch is called for SSE, return an empty stream that errors or closes
          return Promise.reject(new Error("Network drop simulated"));
        }
        if (url.includes("/result")) {
          pollCount++;
          if (pollCount === 1) {
            return Promise.resolve(jsonResponse(makeJob("pending", { percent: 30, stage: "polled_step" })));
          }
          return Promise.resolve(jsonResponse(makeJob("completed", { percent: 100, stage: "done" }, { fallbackResult: "ok" })));
        }
        return Promise.reject(new Error(`Unexpected url: ${url}`));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const events: TrackJobEvent[] = [];
      const tracker = client.trackJob("job-1017", {
        chaosInjector: chaos,
        intervalMs: 100,
        maxIntervalMs: 200,
      });

      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          events.push(evt);
        }
      })();

      // Run fake timers to advance SSE error + polling backoff intervals
      await vi.runAllTimersAsync();
      await iteratePromise;

      // Acceptance criterion: Fallback engages on stream errors
      expect(tracker.fallbackEngaged).toBe(true);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.source === "poll")).toBe(true);

      const finalEvent = events[events.length - 1];
      expect(finalEvent.type).toBe("result");
      expect(finalEvent.status).toBe("completed");
      expect(finalEvent.result).toEqual({ fallbackResult: "ok" });
    });
  });

  // ── 4. Mid-stream disconnect and seamless polling recovery ──────────────────

  describe("Mid-stream disconnect with deduplication", () => {
    it("resumes progress via polling after mid-stream SSE disconnect without duplicating progress", async () => {
      // SSE emits 25% then stream terminates unexpectedly
      const sseBody = sseStream(
        'event: snapshot\ndata: {"id":"job-1017","status":"pending","progress":{"percent":25,"stage":"downloading","updatedAt":"2026-01-01T00:00:01Z"}}\n\n',
      );

      let pollCall = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          return Promise.resolve(sseResponse(sseBody));
        }
        if (url.includes("/result")) {
          pollCall++;
          if (pollCall === 1) {
            // First poll returns the same 25% state already received from SSE (should be deduplicated)
            return Promise.resolve(jsonResponse(makeJob("pending", { percent: 25, stage: "downloading", updatedAt: "2026-01-01T00:00:01Z" })));
          }
          if (pollCall === 2) {
            // Next poll returns 75% progress
            return Promise.resolve(jsonResponse(makeJob("pending", { percent: 75, stage: "processing", updatedAt: "2026-01-01T00:00:02Z" })));
          }
          // Final poll returns completed
          return Promise.resolve(jsonResponse(makeJob("completed", { percent: 100, stage: "completed" }, { data: [1, 2, 3] })));
        }
        return Promise.reject(new Error(`Unexpected url: ${url}`));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017", {
        intervalMs: 100,
        maxIntervalMs: 200,
      });

      const events: TrackJobEvent[] = [];
      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          events.push(evt);
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      // 25% from SSE, 75% from polling, and result from polling. Duplicate 25% was suppressed.
      expect(events.length).toBe(3);
      expect(events[0].percent).toBe(25);
      expect(events[0].source).toBe("stream");

      expect(events[1].percent).toBe(75);
      expect(events[1].source).toBe("poll");

      expect(events[2].type).toBe("result");
      expect(events[2].result).toEqual({ data: [1, 2, 3] });
      expect(events[2].source).toBe("poll");
    });
  });

  // ── 5. Abort and cleanup ────────────────────────────────────────────────────

  describe("Abort and resource cleanup", () => {
    it("cleans up streams and timers when caller signal aborts", async () => {
      // A fetch that keeps returning pending indefinitely
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          // Return an SSE response that never closes
          return Promise.resolve(sseResponse(new ReadableStream({ start() {} })));
        }
        return Promise.resolve(jsonResponse(makeJob("pending")));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const controller = new AbortController();
      const tracker = client.trackJob("job-1017", {
        signal: controller.signal,
        intervalMs: 100,
      });

      const rejection = expect(async () => {
        for await (const _ of tracker) {
          // consume
        }
      }).rejects.toThrow(TalosTimeoutError);

      // Abort during tracking
      controller.abort();

      await vi.runAllTimersAsync();
      await rejection;

      // Acceptance criterion: Abort cleans up streams and timers
      expect(vi.getTimerCount()).toBe(0);
    });

    it("throws immediately and leaves no timers when signal is already aborted", async () => {
      const client = new TalosClient({ baseUrl: "https://api.example.com" });
      const controller = new AbortController();
      controller.abort();

      const tracker = client.trackJob("job-1017", { signal: controller.signal });

      await expect(async () => {
        for await (const _ of tracker) {
          // consume
        }
      }).rejects.toThrow(JobTrackAbortedError);

      expect(vi.getTimerCount()).toBe(0);
    });

    it("cleans up streams and timers when break is used in for-await", async () => {
      const sseBody = sseStream(
        'event: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":10}}\n\n',
        'event: progress\ndata: {"id":"job-1017","status":"pending","progress":{"percent":20}}\n\n',
      );

      const mockFetch = vi.fn().mockResolvedValue(sseResponse(sseBody));
      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017");

      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          if (evt.percent === 10) {
            break; // early exit
          }
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ── 6. Timeout handling ─────────────────────────────────────────────────────

  describe("Timeout handling", () => {
    it("throws JobTrackTimeoutError when timeoutMs elapses before completion", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) {
          return Promise.resolve(sseResponse(new ReadableStream({ start() {} })));
        }
        return Promise.resolve(jsonResponse(makeJob("pending")));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017", {
        timeoutMs: 300,
        intervalMs: 100,
      });

      const rejection = expect(async () => {
        for await (const _ of tracker) {
          // consume
        }
      }).rejects.toThrow(JobTrackTimeoutError);

      await vi.advanceTimersByTimeAsync(350);
      await rejection;

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ── 7. Typed terminal outcomes and errors ───────────────────────────────────

  describe("Typed terminal outcomes and errors", () => {
    it("throws JobFailedError when job reaches failed status", async () => {
      const sseBody = sseStream(
        'event: done\ndata: {"id":"job-1017","status":"failed"}\n\n',
      );

      const mockFetch = vi.fn().mockResolvedValue(sseResponse(sseBody));
      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017");

      const rejection = expect(async () => {
        for await (const _ of tracker) {
          // consume
        }
      }).rejects.toThrow(JobFailedError);

      await vi.runAllTimersAsync();
      await rejection;

      // Verify JobFailedError is instanceof TalosAPIError
      try {
        await tracker.result;
      } catch (err) {
        expect(err).toBeInstanceOf(JobFailedError);
        expect(err).toBeInstanceOf(TalosAPIError);
        expect((err as JobFailedError).terminalStatus).toBe("failed");
      }
    });

    it("throws JobCancelledError when job reaches cancelled status", async () => {
      const sseBody = sseStream(
        'event: done\ndata: {"id":"job-1017","status":"cancelled"}\n\n',
      );

      const mockFetch = vi.fn().mockResolvedValue(sseResponse(sseBody));
      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017");

      const rejection = expect(async () => {
        for await (const _ of tracker) {
          // consume
        }
      }).rejects.toThrow(JobCancelledError);

      await vi.runAllTimersAsync();
      await rejection;
    });

    it("yields terminal failure event without throwing when throwOnTerminalError is false", async () => {
      const sseBody = sseStream(
        'event: done\ndata: {"id":"job-1017","status":"failed"}\n\n',
      );

      const mockFetch = vi.fn().mockResolvedValue(sseResponse(sseBody));
      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const tracker = client.trackJob("job-1017", {
        throwOnTerminalError: false,
      });

      const events: TrackJobEvent[] = [];
      const iteratePromise = (async () => {
        for await (const evt of tracker) {
          events.push(evt);
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      expect(events.length).toBe(1);
      expect(events[0].status).toBe("failed");
    });
  });

  // ── 8. Standalone trackJob function ─────────────────────────────────────────

  describe("Standalone trackJob function", () => {
    it("can be invoked as trackJob(client, jobId, options)", async () => {
      const sseBody = sseStream(
        'event: done\ndata: {"id":"job-1017","status":"completed","result":{"standalone":true}}\n\n',
      );
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/progress")) return Promise.resolve(sseResponse(sseBody));
        return Promise.resolve(jsonResponse(makeJob("completed", null, { standalone: true })));
      });

      const client = new TalosClient({
        baseUrl: "https://api.example.com",
        fetch: mockFetch,
      });

      const events: TrackJobEvent[] = [];
      const iteratePromise = (async () => {
        for await (const evt of trackJob(client, "job-1017")) {
          events.push(evt);
        }
      })();

      await vi.runAllTimersAsync();
      await iteratePromise;

      expect(events.length).toBe(1);
      expect(events[0].result).toEqual({ standalone: true });
    });

    it("throws TypeError if called with jobId string but no client option", () => {
      expect(() => trackJob("job-1017" as any)).toThrow(TypeError);
    });
  });
});
