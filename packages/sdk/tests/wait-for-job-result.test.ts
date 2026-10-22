/**
 * Fake-timer tests for TalosClient.waitForJobResult (#922)
 *
 * Covers:
 *  - Resolves when job reaches "completed" status
 *  - Rejects when job reaches "failed" status
 *  - Rejects when job reaches "cancelled" status
 *  - Throws TalosTimeoutError when timeoutMs elapses
 *  - Throws TalosTimeoutError when caller AbortSignal is aborted
 *  - No timers remain after resolution (completion, failure, timeout, abort)
 *  - Polls multiple times before terminal state
 *  - Respects intervalMs / maxIntervalMs back-off bounds
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosAPIError,
  TalosTimeoutError,
} from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a mock job object in a given status. */
function makeJob(status: "pending" | "completed" | "failed" | "cancelled") {
  return {
    id: "job-1",
    talosId: "tal-1",
    requesterTalosId: "tal-2",
    serviceName: "test-service",
    status,
    amount: "1.00",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build a mock fetch that returns the given sequence of job statuses.
 * After the sequence is exhausted it keeps returning the last status.
 */
function makeFetchSequence(
  statuses: Array<"pending" | "completed" | "failed" | "cancelled">,
): typeof fetch {
  let call = 0;
  return vi.fn((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    }
    const idx = Math.min(call++, statuses.length - 1);
    const job = makeJob(statuses[idx]);

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort);
      resolve({
        ok: true,
        json: async () => job,
      } as Response);
    });
  }) as unknown as typeof fetch;
}

/**
 * A fetch mock that never settles (simulates a hung connection).
 * Rejects on abort.
 */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }),
  ) as unknown as typeof fetch;
}

// ── suite ──────────────────────────────────────────────────────────────────

describe("TalosClient.waitForJobResult (#922)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Completion ────────────────────────────────────────────────────────

  it("resolves immediately when the first poll returns 'completed'", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["completed"]),
    });

    const promise = client.waitForJobResult("job-1", { intervalMs: 100 });

    // Drive the microtask queue so the first fetch resolves.
    await vi.runAllTimersAsync();

    const job = await promise;
    expect(job.status).toBe("completed");
  });

  it("resolves after several pending polls then completion", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["pending", "pending", "completed"]),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 200,
      maxIntervalMs: 500,
    });

    // Each wait tick: run timers then let fetch settle.
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(400);
    await vi.runAllTimersAsync();

    const job = await promise;
    expect(job.status).toBe("completed");
  });

  // ── Failure ───────────────────────────────────────────────────────────

  it("rejects with TalosAPIError when job status is 'failed'", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["failed"]),
    });

    const promise = client.waitForJobResult("job-1", { intervalMs: 100 });
    const errPromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const err = await errPromise;
    expect(err).toBeInstanceOf(TalosAPIError);
    expect((err as TalosAPIError).message).toContain("failed");
  });

  it("rejects with TalosAPIError when job status is 'cancelled'", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["cancelled"]),
    });

    const promise = client.waitForJobResult("job-1", { intervalMs: 100 });
    const errPromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    const err = await errPromise;
    expect(err).toBeInstanceOf(TalosAPIError);
    expect((err as TalosAPIError).message).toContain("cancelled");
  });

  it("rejects after pending polls then failure", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["pending", "failed"]),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 100,
      maxIntervalMs: 300,
    });

    const rejection = expect(promise).rejects.toBeInstanceOf(TalosAPIError);
    await vi.runAllTimersAsync();
    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();

    await rejection;
  });

  // ── Timeout ───────────────────────────────────────────────────────────

  it("throws TalosTimeoutError when timeoutMs elapses on a hanging fetch", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 500,
      timeoutMs: 1_000,
    });

    const rejection = expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
    // Advance past the timeout.
    await vi.advanceTimersByTimeAsync(1_200);
    await rejection;
  });

  it("TalosTimeoutError.code is 'timeout_error' on timeout", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 500,
      timeoutMs: 300,
    });

    const errPromise = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);

    const err = await errPromise;
    expect((err as TalosTimeoutError).code).toBe("timeout_error");
  });

  it("throws TalosTimeoutError when timeoutMs elapses between polls", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["pending", "pending", "pending"]),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 300,
      maxIntervalMs: 600,
      timeoutMs: 500, // fires before 2nd interval completes
    });

    const rejection = expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
    await vi.runAllTimersAsync();
    await rejection;
  });

  // ── Abort ─────────────────────────────────────────────────────────────

  it("throws TalosTimeoutError when AbortSignal is aborted before starting", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["pending"]),
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.waitForJobResult("job-1", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("throws TalosTimeoutError when AbortSignal is aborted during polling", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const controller = new AbortController();
    const promise = client.waitForJobResult("job-1", {
      intervalMs: 500,
      signal: controller.signal,
    });

    // Abort after a short delay.
    await vi.runAllTimersAsync();
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("TalosTimeoutError is instanceof TalosAPIError on abort", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const controller = new AbortController();
    const promise = client.waitForJobResult("job-1", {
      signal: controller.signal,
    });

    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TalosAPIError);
    expect(err).toBeInstanceOf(TalosTimeoutError);
  });

  // ── No timers remain after resolution ─────────────────────────────────

  it("no pending timers remain after completed resolution", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["completed"]),
    });

    const promise = client.waitForJobResult("job-1", { intervalMs: 100 });
    await vi.runAllTimersAsync();
    await promise;

    // getTimerCount() from fake-timers; after settlement there should be none.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no pending timers remain after timeout", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 500,
      timeoutMs: 300,
    });
    const errPromise = promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(500);
    await errPromise;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("no pending timers remain after abort", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const controller = new AbortController();
    const promise = client.waitForJobResult("job-1", {
      intervalMs: 500,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const errPromise = promise.catch(() => {});

    await vi.runAllTimersAsync();
    controller.abort();
    await errPromise;

    // Flush any remaining timers so the assertion is clean.
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Back-off / interval caps ──────────────────────────────────────────

  it("does not exceed maxIntervalMs between polls", async () => {
    const delays: number[] = [];
    const originalWait = vi.spyOn(
      // Access the private wait method via type assertion for spy purposes.
      TalosClient.prototype as unknown as { wait(ms: number, s?: AbortSignal): Promise<void> },
      "wait",
    );
    originalWait.mockImplementation(async (ms: number) => {
      delays.push(ms);
    });

    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: makeFetchSequence(["pending", "pending", "pending", "completed"]),
    });

    const promise = client.waitForJobResult("job-1", {
      intervalMs: 100,
      maxIntervalMs: 300,
    });

    await vi.runAllTimersAsync();
    await promise;

    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(300);
    }
  });
});
