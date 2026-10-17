/**
 * Tests for issue #590 — credential redaction in SDK logger hooks (onError).
 *
 * Covers:
 *   - redactEventPath() utility (unit tests)
 *   - TalosClient.notifyError() path sanitisation integration
 *   - Boundary and negative cases for the query-string scrubber
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TalosClient } from "../src/client.js";
import { redactEventPath } from "../src/errors.js";

// ── redactEventPath unit tests ─────────────────────────────────────────────

describe("redactEventPath", () => {
  // Paths with no query string are returned unchanged
  it("returns a path with no query string unchanged", () => {
    expect(redactEventPath("/api/talos/abc123")).toBe("/api/talos/abc123");
    expect(redactEventPath("/api/admin/jobs")).toBe("/api/admin/jobs");
  });

  it("returns an empty string unchanged", () => {
    expect(redactEventPath("")).toBe("");
  });

  // Innocent query params are kept as-is
  it("keeps non-sensitive query params intact", () => {
    expect(redactEventPath("/api/talos?cursor=abc&limit=20")).toBe(
      "/api/talos?cursor=abc&limit=20",
    );
  });

  it("keeps status and queue params intact (used by admin jobs list)", () => {
    expect(
      redactEventPath("/api/admin/jobs?status=dead_letter&queue=audit_log_write"),
    ).toBe("/api/admin/jobs?status=dead_letter&queue=audit_log_write");
  });

  // Sensitive query params are redacted
  it("redacts 'token' query param", () => {
    const result = redactEventPath("/api/talos?token=supersecrettoken");
    // URLSearchParams.toString() percent-encodes [ and ], so accept both forms
    const hasRedacted = result.includes("[REDACTED]") || result.includes("%5BREDACTED%5D");
    expect(hasRedacted).toBe(true);
    expect(result).not.toContain("supersecrettoken");
  });

  it("redacts 'apiKey' query param (camelCase)", () => {
    const result = redactEventPath("/api/endpoint?apiKey=tak_abcdef1234");
    expect(result).not.toContain("tak_abcdef1234");
  });

  it("redacts 'api_key' query param (snake_case)", () => {
    const result = redactEventPath("/api/endpoint?api_key=tak_abcdef1234");
    expect(result).not.toContain("tak_abcdef1234");
  });

  it("redacts 'api-key' query param (kebab-case)", () => {
    const result = redactEventPath("/api/endpoint?api-key=tak_abcdef1234");
    expect(result).not.toContain("tak_abcdef1234");
  });

  it("redacts 'authorization' query param", () => {
    const result = redactEventPath("/api/endpoint?authorization=Bearer+abc123");
    expect(result).not.toContain("abc123");
  });

  it("redacts 'secret' query param", () => {
    const result = redactEventPath("/api/endpoint?secret=mysecret");
    expect(result).not.toContain("mysecret");
  });

  it("redacts 'access_token' query param", () => {
    const result = redactEventPath("/api/endpoint?access_token=oauth_token_here");
    expect(result).not.toContain("oauth_token_here");
  });

  it("redacts 'password' query param", () => {
    const result = redactEventPath("/api/endpoint?password=hunter2");
    expect(result).not.toContain("hunter2");
  });

  it("redacts 'signature' query param", () => {
    const result = redactEventPath("/api/endpoint?signature=sig_abc123");
    expect(result).not.toContain("sig_abc123");
  });

  it("redacts 'sig' query param (abbreviated)", () => {
    const result = redactEventPath("/api/endpoint?sig=abc123");
    expect(result).not.toContain("abc123");
  });

  it("redacts 'nonce' query param", () => {
    const result = redactEventPath("/api/endpoint?nonce=random_nonce");
    expect(result).not.toContain("random_nonce");
  });

  it("redacts 'seed' query param", () => {
    const result = redactEventPath("/api/endpoint?seed=stellar_seed");
    expect(result).not.toContain("stellar_seed");
  });

  it("redacts 'proof' query param (payment proof)", () => {
    const result = redactEventPath("/api/endpoint?proof=payment_proof_here");
    expect(result).not.toContain("payment_proof_here");
  });

  it("redacts case-insensitively (TOKEN)", () => {
    const result = redactEventPath("/api/endpoint?TOKEN=supersecrettoken");
    expect(result).not.toContain("supersecrettoken");
  });

  // Mixed: redact sensitive, keep innocent
  it("redacts only sensitive params in a mixed query string", () => {
    const result = redactEventPath(
      "/api/talos?cursor=abc&apiKey=secretkey&limit=20&token=tok123",
    );
    expect(result).toContain("cursor=abc");
    expect(result).toContain("limit=20");
    expect(result).not.toContain("secretkey");
    expect(result).not.toContain("tok123");
  });

  // Boundary: empty query string
  it("handles a path with empty query string gracefully", () => {
    const result = redactEventPath("/api/talos?");
    expect(result).toBe("/api/talos?");
  });

  // Boundary: full URL (not just path)
  it("handles a full URL string (with scheme and host)", () => {
    const result = redactEventPath(
      "https://example.com/api/talos?apiKey=secretkey&limit=10",
    );
    expect(result).not.toContain("secretkey");
    expect(result).toContain("limit=10");
    expect(result).toContain("https://example.com/api/talos");
  });

  // Regression: path without trailing slash
  it("preserves path exactly when no redaction needed", () => {
    const input = "/api/admin/jobs/{id}/retry";
    expect(redactEventPath(input)).toBe(input);
  });
});

// ── TalosClient.notifyError() integration ─────────────────────────────────

describe("TalosClient onError hook – credential redaction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers onError events without credential-bearing query params", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ "x-request-id": "req-001" }),
      text: async () => JSON.stringify({ error: "Unauthorized" }),
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    // Simulate a path that accidentally carries an apiKey query param.
    // Internal `buildUrl` would embed this in the URL sent to fetch, but
    // `notifyError` should strip it from the emitted event.
    await expect(
      // @ts-expect-error — exercising internal request helper indirectly via listActivities
      client["request"]("/api/talos?apiKey=tak_supersecret&limit=5"),
    ).rejects.toBeDefined();

    expect(onError).toHaveBeenCalledTimes(1);
    const event = onError.mock.calls[0]?.[0];
    expect(event.path).not.toContain("tak_supersecret");
    // URLSearchParams encodes brackets, so we accept either the raw or URL-encoded form
    const hasRedacted =
      event.path.includes("[REDACTED]") || event.path.includes("%5BREDACTED%5D");
    expect(hasRedacted).toBe(true);
  });

  it("preserves safe query params in the onError path field", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "{}",
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    await expect(
      // @ts-expect-error — exercising internal request helper directly
      client["request"]("/api/admin/jobs?status=dead_letter&queue=audit_log_write"),
    ).rejects.toBeDefined();

    expect(onError).toHaveBeenCalledTimes(1);
    const event = onError.mock.calls[0]?.[0];
    expect(event.path).toContain("status=dead_letter");
    expect(event.path).toContain("queue=audit_log_write");
  });

  it("delivers onError for clean paths (no query string) unchanged", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => "{}",
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    await expect(client.getTalos("agent_001")).rejects.toBeDefined();

    expect(onError).toHaveBeenCalledTimes(1);
    const event = onError.mock.calls[0]?.[0];
    expect(event.path).toBe("/api/talos/agent_001");
  });

  it("does NOT fire onError when no hook is configured", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => "Server error",
    } as Response);

    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
    });

    // Should reject but NOT throw from the undefined onError path
    await expect(client.getTalos("agent_001")).rejects.toBeDefined();
  });

  it("event path field is never the full URL (no baseUrl prefix)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => "{}",
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "https://talos-stellar.vercel.app",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    await expect(client.getTalos("agent_abc")).rejects.toBeDefined();

    const event = onError.mock.calls[0]?.[0];
    // path should be the API path template, not the full URL
    expect(event.path).toBe("/api/talos/agent_abc");
    expect(event.path).not.toContain("talos-stellar.vercel.app");
  });

  it("silently swallows exceptions thrown by the onError hook", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => "{}",
    } as Response);

    const onError = vi.fn().mockImplementation(() => {
      throw new Error("Logger crashed!");
    });

    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    // Even though onError throws, the client error should still propagate cleanly
    await expect(client.getTalos("agent_001")).rejects.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // Boundary: multiple retry attempts — onError fires exactly once (after exhaustion)
  it("fires onError exactly once after all retry attempts are exhausted", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers(),
      text: async () => "Service unavailable",
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
      onError,
    });

    await expect(client.getTalos("agent_001")).rejects.toBeDefined();
    // onError fires once after all retries are exhausted, not per-attempt
    expect(onError).toHaveBeenCalledTimes(1);
    // Attempt count reflects the number of actual attempts (3)
    expect(onError.mock.calls[0]?.[0].attempt).toBe(3);
  });

  it("redacts multiple credential params in a single path", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "{}",
    } as Response);

    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: "http://localhost:3000",
      retryPolicy: { maxAttempts: 1 },
      onError,
    });

    await expect(
      // @ts-expect-error — exercising internal request helper directly
      client["request"]("/api/endpoint?token=tok123&apiKey=key456&limit=5"),
    ).rejects.toBeDefined();

    const event = onError.mock.calls[0]?.[0];
    expect(event.path).not.toContain("tok123");
    expect(event.path).not.toContain("key456");
    expect(event.path).toContain("limit=5");
  });
});
