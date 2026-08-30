/**
 * Focused tests for the typed API error parsing surface (issue #468).
 *
 * Consumers should be able to handle API failures through stable typed fields
 * (`status`, `code`, `message`, `requestId`, validation `issues`, safe headers)
 * instead of parsing arbitrary response bodies.
 *
 * Acceptance criteria covered here:
 *   - JSON envelopes parse into the documented type.
 *   - Non-JSON responses produce a safe fallback error.
 *   - Sensitive response fields are not copied into messages.
 *   - Successful response behavior is unchanged.
 */

import { describe, it, expect } from "vitest";
import {
  TalosAPIError,
  TalosValidationError,
  TalosAuthenticationError,
  TalosForbiddenError,
  TalosNotFoundError,
  TalosConflictError,
  TalosPaymentError,
  TalosRateLimitError,
  TalosServerError,
  TalosServerRetryableError,
  TalosTransportError,
  TalosTimeoutError,
  errorFromResponse,
  classifyTransportError,
  sanitizeBody,
  redactSecrets,
  snapshotHeaders,
  parseRetryAfter,
  MAX_BODY_BYTES,
} from "../src/index.js";

describe("errorFromResponse — JSON envelope → documented type", () => {
  it("maps every common status code to the correct typed subclass", () => {
    const cases: Array<[number, new (...args: never[]) => TalosAPIError]> = [
      [400, TalosValidationError],
      [401, TalosAuthenticationError],
      [402, TalosPaymentError],
      [403, TalosForbiddenError],
      [404, TalosNotFoundError],
      [409, TalosConflictError],
      [429, TalosRateLimitError],
      [500, TalosServerError],
      [502, TalosServerRetryableError],
      [503, TalosServerRetryableError],
      [504, TalosServerRetryableError],
    ];
    for (const [status, klass] of cases) {
      const err = errorFromResponse(status, "/x", "{}", new Headers());
      expect(err, `status ${status}`).toBeInstanceOf(klass);
      expect(err).toBeInstanceOf(TalosAPIError);
    }
  });

  it("surfaces request id, headers, and parsed data on the error", () => {
    const headers = new Headers({
      "x-request-id": "req-123",
      "retry-after": "2",
    });
    const err = errorFromResponse(
      429,
      "/api/talos",
      JSON.stringify({ error: "slow down" }),
      headers,
    );
    expect(err.requestId).toBe("req-123");
    expect(err.headers["x-request-id"]).toBe("req-123");
    expect(err.headers["retry-after"]).toBe("2");
    expect(err.retryAfterMs).toBe(2000);
    expect(err).toMatchObject({ code: "rate_limit_error", status: 429 });
  });

  it("parses validation details into a stable `issues` array", () => {
    const err = errorFromResponse(
      400,
      "/api/talos",
      JSON.stringify({ error: "bad", issues: ["name: required", "category: invalid"] }),
      new Headers(),
    );
    expect(err).toBeInstanceOf(TalosValidationError);
    expect((err as TalosValidationError).issues).toEqual([
      "name: required",
      "category: invalid",
    ]);
    expect(err.code).toBe("validation_error");
  });

  it("preserves the legacy message format for compatibility", () => {
    const err = errorFromResponse(400, "/api/talos/1", "Bad Request", new Headers());
    expect(err.message).toBe("Talos API error 400 on /api/talos/1: Bad Request");
    expect(err.message).toContain(String(err.status));
    expect(err.message).toContain(err.path);
  });
});

describe("errorFromResponse — non-JSON / malformed responses", () => {
  it("produces a safe fallback error for HTML / plain-text bodies", () => {
    const html = "<html><body>503 Service Temporarily Unavailable</body></html>";
    const err = errorFromResponse(503, "/x", html, new Headers());
    expect(err).toBeInstanceOf(TalosServerRetryableError);
    expect(err.isRetryable).toBe(true);
    // Body is collapsed to a single line and bounded.
    expect(err.body).not.toContain("\n");
    expect(err.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES + 20);
  });

  it("returns a generic API error for unknown statuses", () => {
    const err = errorFromResponse(418, "/x", "teapot", new Headers());
    expect(err).toBeInstanceOf(TalosAPIError);
    expect(err.code).toBe("api_error");
    expect(err.status).toBe(418);
  });
});

describe("sensitive-field redaction", () => {
  it("never copies secret fields into the message or body", () => {
    const raw = JSON.stringify({
      error: "boom",
      token: "sekret-token",
      authorization: "Bearer xyz",
      apiKey: "k-1234",
      signature: "sig-x",
    });
    const { body, data } = sanitizeBody(raw);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("sekret-token");
    expect(body).not.toContain("Bearer xyz");
    expect(body).not.toContain("k-1234");
    expect(body).not.toContain("sig-x");
    expect((data as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((data as Record<string, unknown>).authorization).toBe("[REDACTED]");
  });

  it("redacts nested and array-sensitive fields", () => {
    const redacted = redactSecrets({
      outer: { inner: { password: "hunter2", safe: "keep" } },
      list: [{ apiKey: "a" }, { note: "ok" }],
    }) as {
      outer: { inner: { password: string; safe: string } };
      list: Array<Record<string, unknown>>;
    };
    expect(redacted.outer.inner.password).toBe("[REDACTED]");
    expect(redacted.outer.inner.safe).toBe("keep");
    expect(redacted.list[0].apiKey).toBe("[REDACTED]");
    expect(redacted.list[1].note).toBe("ok");
  });

  it("handles circular references without hanging", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const r = redactSecrets(a) as { name: string; self: unknown };
    expect(r.name).toBe("a");
    expect(r.self).toBe("[Circular]");
  });
});

describe("classifyTransportError", () => {
  it("classifies DNS / connection failures as retryable transport errors", () => {
    const err = classifyTransportError(new Error("ECONNREFUSED"), "/x");
    expect(err).toBeInstanceOf(TalosTransportError);
    expect(err.isRetryable).toBe(true);
  });

  it("classifies aborts and timeouts as TalosTimeoutError", () => {
    const aborted = classifyTransportError(new DOMException("Aborted", "AbortError"), "/x");
    expect(aborted).toBeInstanceOf(TalosTimeoutError);
    expect(aborted.code).toBe("timeout_error");
    const timedOut = classifyTransportError(new Error("Request timeout"), "/x");
    expect(timedOut).toBeInstanceOf(TalosTimeoutError);
  });
});

describe("snapshotHeaders", () => {
  it("keeps only the safe, retry-relevant header set", () => {
    const snap = snapshotHeaders(
      new Headers({
        "x-request-id": "r1",
        "retry-after": "5",
        "x-ratelimit-limit": "60",
        "set-cookie": "secret=1",
        authorization: "Bearer nope",
      }),
    );
    expect(snap).toEqual({
      "x-request-id": "r1",
      "retry-after": "5",
      "x-ratelimit-limit": "60",
    });
    expect(snap.authorization).toBeUndefined();
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates, and rejects garbage", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(9_000);
    expect(ms).toBeLessThanOrEqual(10_000);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
