/**
 * Abortable request timeouts — focused test suite for #569
 *
 * Covers:
 *   - Client-level timeoutMs fires for slow fetch (positive)
 *   - Per-call WriteOptions.timeoutMs overrides client-level (positive)
 *   - Per-call ReadOptions.timeoutMs overrides client-level (positive)
 *   - timeoutMs: 0 disables the timeout even when a client-level is set (boundary)
 *   - TalosTimeoutError is thrown, not a generic error (type check)
 *   - AbortSignal cancellation still works independent of timeoutMs (regression)
 *   - Per-call timeoutMs on CursorRequestOptions (list methods) (positive)
 *   - Secrets / sensitive fields are never surfaced through TalosTimeoutError (privacy)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosTimeoutError,
  TalosAPIError,
} from "../src/index.js";
import type { WriteOptions, ReadOptions } from "../src/index.js";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * A fetch mock that never settles (simulates a hung connection). The
 * AbortSignal is wired so the Promise rejects with an AbortError when
 * the timeout controller fires.
 */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) {
        const err = new DOMException("The operation was aborted.", "AbortError");
        reject(err);
        return;
      }
      signal?.addEventListener("abort", () => {
        const err = new DOMException("The operation was aborted.", "AbortError");
        reject(err);
      });
    }),
  ) as unknown as typeof fetch;
}

/**
 * A fetch mock that resolves quickly with a successful response.
 */
function quickFetch(body: unknown = { ok: true }): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response) as unknown as typeof fetch;
}

// ── suite ──────────────────────────────────────────────────────────────────

describe("Abortable request timeouts (#569)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Positive: client-level timeout ────────────────────────────────────

  it("client-level timeoutMs fires TalosTimeoutError for a hanging GET", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 100,
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("abc");
    // Advance clock past the timeout.
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("client-level timeoutMs fires TalosTimeoutError for a hanging POST", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 100,
      fetch: hangingFetch(),
    });

    const promise = client.reportActivity("talos-1", {
      type: "post",
      content: "hello",
      channel: "twitter",
    });
    await vi.advanceTimersByTimeAsync(200);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  // ── Positive: per-call WriteOptions.timeoutMs override ────────────────

  it("WriteOptions.timeoutMs shorter than client default fires sooner", async () => {
    // Client has a long (10 s) timeout — call-level overrides to 50 ms.
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 10_000,
      fetch: hangingFetch(),
    });

    const options: WriteOptions = { timeoutMs: 50 };
    const promise = client.reportActivity(
      "talos-1",
      { type: "post", content: "test", channel: "twitter" },
      options,
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("WriteOptions.timeoutMs overrides client default for submitJobResult", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 10_000,
      fetch: hangingFetch(),
    });

    const promise = client.submitJobResult("job-1", { done: true }, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  // ── Positive: per-call ReadOptions.timeoutMs override ─────────────────

  it("ReadOptions.timeoutMs fires TalosTimeoutError for getTalos", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      // No client-level timeout — per-call only.
      fetch: hangingFetch(),
    });

    const options: ReadOptions = { timeoutMs: 50 };
    const promise = client.getTalos("talos-1", options);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("ReadOptions.timeoutMs on getTalosMe fires TalosTimeoutError", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.getTalosMe({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("ReadOptions.timeoutMs on getPendingJobs fires TalosTimeoutError", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.getPendingJobs({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  // ── Per-call on CursorRequestOptions (list methods) ───────────────────

  it("CursorRequestOptions.timeoutMs on listTaloses fires TalosTimeoutError", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.listTaloses({ limit: 10, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("CursorRequestOptions.timeoutMs on getLeaderboard fires TalosTimeoutError", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const promise = client.getLeaderboard({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  // ── Boundary: timeoutMs: 0 disables the timeout ────────────────────────

  it("WriteOptions.timeoutMs: 0 disables per-call timeout; call succeeds", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 50,         // Client has a default...
      fetch: quickFetch({ id: "job-1", status: "done" }),
    });

    // ...but calling with 0 disables it for this call.
    const result = await client.submitJobResult("job-1", { done: true }, { timeoutMs: 0 });
    expect(result).toBeTruthy();
  });

  it("ReadOptions.timeoutMs: 0 disables per-call timeout; call succeeds", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 50,
      fetch: quickFetch({ id: "talos-1", name: "Test" }),
    });

    const result = await client.getTalos("talos-1", { timeoutMs: 0 });
    expect(result).toBeTruthy();
  });

  // ── Type checks: TalosTimeoutError is a TalosAPIError subclass ─────────

  it("TalosTimeoutError is instanceof TalosAPIError (subclass check)", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 50,
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("talos-1");
    await vi.advanceTimersByTimeAsync(100);

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TalosAPIError);
    expect(err).toBeInstanceOf(TalosTimeoutError);
  });

  it("TalosTimeoutError exposes code = 'timeout_error'", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 50,
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("talos-1");
    await vi.advanceTimersByTimeAsync(100);

    const err = await promise.catch((e: unknown) => e);
    expect((err as TalosTimeoutError).code).toBe("timeout_error");
  });

  it("TalosTimeoutError.isRetryable is true", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 50,
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("talos-1");
    await vi.advanceTimersByTimeAsync(100);

    const err = await promise.catch((e: unknown) => e);
    expect((err as TalosTimeoutError).isRetryable).toBe(true);
  });

  // ── Privacy: no secrets surfaced through error ─────────────────────────

  it("TalosTimeoutError does not expose API key in toJSON()", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      apiKey: "super-secret-key",
      timeoutMs: 50,
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("talos-1");
    await vi.advanceTimersByTimeAsync(100);

    const err = await promise.catch((e: unknown) => e);
    const json = JSON.stringify((err as TalosTimeoutError).toJSON());
    expect(json).not.toContain("super-secret-key");
  });

  // ── Regression: AbortSignal cancellation works independently ───────────

  it("caller AbortSignal abort throws TalosTimeoutError (regression)", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      // No client-level timeout.
      fetch: hangingFetch(),
    });

    const controller = new AbortController();
    const promise = client.getTalos("talos-1", { signal: controller.signal });

    // Immediately abort.
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  it("caller AbortSignal abort + per-call timeoutMs: abort fires first", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      fetch: hangingFetch(),
    });

    const controller = new AbortController();
    const promise = client.getTalos("talos-1", {
      signal: controller.signal,
      timeoutMs: 1000,
    });

    // Abort before the 1 s timeout.
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });

  // ── Positive: successful call does not time out ────────────────────────

  it("fast fetch completes within timeoutMs without throwing", async () => {
    vi.useRealTimers();

    const client = new TalosClient({
      baseUrl: "http://example.test",
      timeoutMs: 5000,
      fetch: quickFetch({ id: "talos-1", name: "Fast" }),
    });

    const result = await client.getTalos("talos-1");
    expect(result).toEqual({ id: "talos-1", name: "Fast" });
  });

  // ── Boundary: per-call overrides a zero/unset client timeout ──────────

  it("per-call timeoutMs fires even when client has no timeoutMs", async () => {
    const client = new TalosClient({
      baseUrl: "http://example.test",
      // No client-level timeout.
      fetch: hangingFetch(),
    });

    const promise = client.getTalos("talos-1", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(TalosTimeoutError);
  });
});
