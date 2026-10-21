import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TAVILY_OUTPUT_MAX_CHARS,
  TAVILY_RESULT_CONTENT_MAX_CHARS,
  TAVILY_TIMEOUT_MS,
  searchWeb,
} from "../clients";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal successful Tavily API response body. */
function tavilyPayload(
  results: { title: string; url: string; content: string }[],
  answer?: string,
) {
  return JSON.stringify({ answer, results });
}

/** Return a fetch stub that resolves immediately with the given body. */
function fetchResolving(body: string): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Provide a dummy API key so the guard does not throw.
  process.env.TAVILY_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.TAVILY_API_KEY;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Timeout tests
// ---------------------------------------------------------------------------

describe("searchWeb – timeout", () => {
  it("rejects when fetch never resolves (AbortSignal.timeout fires)", async () => {
    // Replace fetch with a promise that never settles, and replace
    // AbortSignal.timeout so the signal fires synchronously in tests.
    const controller = new AbortController();

    // Stub AbortSignal.timeout to return an already-aborted signal.
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    controller.abort(new DOMException("Timeout", "TimeoutError"));

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, opts: RequestInit) => {
        // Simulate the browser/Node behaviour: if the signal is already
        // aborted, reject immediately with an AbortError.
        if (opts?.signal?.aborted) {
          return Promise.reject(opts.signal.reason);
        }
        // Otherwise hang forever.
        return new Promise<Response>(() => {});
      }),
    );

    await expect(searchWeb("test query")).rejects.toThrow();
  });

  it("passes the correct timeout value to AbortSignal.timeout", async () => {
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(new AbortController().signal);

    vi.stubGlobal(
      "fetch",
      fetchResolving(tavilyPayload([{ title: "T", url: "u", content: "c" }])),
    );

    await searchWeb("test query");

    expect(spy).toHaveBeenCalledWith(TAVILY_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Size-cap tests
// ---------------------------------------------------------------------------

describe("searchWeb – per-result content truncation", () => {
  it("truncates a single result's content that exceeds TAVILY_RESULT_CONTENT_MAX_CHARS", async () => {
    const longContent = "x".repeat(TAVILY_RESULT_CONTENT_MAX_CHARS + 500);

    vi.stubGlobal(
      "fetch",
      fetchResolving(
        tavilyPayload([{ title: "Big Result", url: "http://ex.com", content: longContent }]),
      ),
    );

    const output = await searchWeb("query");

    // The result line should not contain the full long content.
    expect(output).not.toContain(longContent);
    // It should end with the ellipsis appended by the truncation logic.
    expect(output).toContain("…");
    // The content portion must be at most the cap + some surrounding text.
    const contentPart = output.replace("[Big Result](http://ex.com): ", "");
    // Truncated content = cap chars + "…" (1 char)
    expect(contentPart.length).toBeLessThanOrEqual(
      TAVILY_RESULT_CONTENT_MAX_CHARS + 1,
    );
  });

  it("keeps short content intact", async () => {
    const shortContent = "Hello world";

    vi.stubGlobal(
      "fetch",
      fetchResolving(
        tavilyPayload([{ title: "Short", url: "http://ex.com", content: shortContent }]),
      ),
    );

    const output = await searchWeb("query");

    expect(output).toContain(shortContent);
  });
});

describe("searchWeb – total output cap", () => {
  it("caps the joined output at TAVILY_OUTPUT_MAX_CHARS", async () => {
    // Create 5 results each with content exactly at the per-result cap.
    const results = Array.from({ length: 5 }, (_, i) => ({
      title: `Result ${i}`,
      url: `http://example.com/${i}`,
      content: "y".repeat(TAVILY_RESULT_CONTENT_MAX_CHARS),
    }));

    vi.stubGlobal(
      "fetch",
      fetchResolving(tavilyPayload(results, "A long answer " + "z".repeat(500))),
    );

    const output = await searchWeb("query");

    // Total output length must not exceed the cap + 1 for the appended "…".
    expect(output.length).toBeLessThanOrEqual(TAVILY_OUTPUT_MAX_CHARS + 1);
  });

  it("does not truncate output that is within the cap", async () => {
    const results = [{ title: "T", url: "http://ex.com", content: "short" }];

    vi.stubGlobal("fetch", fetchResolving(tavilyPayload(results, "Brief answer")));

    const output = await searchWeb("query");

    expect(output.length).toBeLessThanOrEqual(TAVILY_OUTPUT_MAX_CHARS);
    // Should not end with the truncation ellipsis since we are within bounds.
    expect(output.endsWith("…")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exported constant sanity checks
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("TAVILY_TIMEOUT_MS is a positive number", () => {
    expect(TAVILY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("TAVILY_RESULT_CONTENT_MAX_CHARS is a positive number", () => {
    expect(TAVILY_RESULT_CONTENT_MAX_CHARS).toBeGreaterThan(0);
  });

  it("TAVILY_OUTPUT_MAX_CHARS is greater than TAVILY_RESULT_CONTENT_MAX_CHARS", () => {
    expect(TAVILY_OUTPUT_MAX_CHARS).toBeGreaterThan(TAVILY_RESULT_CONTENT_MAX_CHARS);
  });
});
