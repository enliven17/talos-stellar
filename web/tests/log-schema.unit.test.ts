/**
 * Focused coverage for the structured logging schema (issue #641).
 *
 * Local command (run from repo root):
 *   pnpm --dir web exec vitest run tests/log-schema.unit.test.ts
 *
 * Fail-closed contract: ambiguous event/field/locale input never throws and
 * never echoes raw input; secrets, seeds, payment proofs, and sensitive
 * media are redacted via the canonical policy in `src/lib/redact.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LOG_SCHEMA_VERSION,
  MAX_EVENT_NAME_LENGTH,
  MAX_FIELD_KEY_LENGTH,
  MAX_STRING_VALUE_LENGTH,
  MAX_LOG_FIELDS,
  INVALID_LOG_EVENT,
  buildLogEvent,
  sanitizeLogFields,
  sanitizeLogValue,
  isValidEventName,
  isValidFieldKey,
  resolveLogLevel,
} from "../src/lib/log-schema";
import { logOutboxEvent, truncateError } from "../src/lib/outbox/metrics";
import { logJobEvent } from "../src/lib/jobs/metrics";
import { logger } from "../src/lib/logger";
import fixture from "./fixtures/log-schema.fixture.json";

vi.mock("../src/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Positive ────────────────────────────────────────────────────────────────

describe("buildLogEvent (positive)", () => {
  it("builds the canonical shape for a valid event", () => {
    expect(
      buildLogEvent(
        "outbox_event_dispatched",
        { eventId: "evt-123", eventType: "job.completed", attempts: 2 },
        { requestId: "req-abc" },
      ),
    ).toEqual(fixture.expected);
  });

  it("keeps scalar field values and drops nothing well-formed", () => {
    expect(
      buildLogEvent("job_completed", {
        jobId: "j-1",
        attempts: 0,
        replayed: true,
        ratio: 1.5,
        empty: null,
      }),
    ).toMatchObject({
      event: "job_completed",
      schemaVersion: 1,
      jobId: "j-1",
      attempts: 0,
      replayed: true,
      ratio: 1.5,
      empty: null,
    });
  });

  it("accepts boundary-length event names and string values", () => {
    const name = `e${"v".repeat(MAX_EVENT_NAME_LENGTH - 1)}`;
    expect(isValidEventName(name)).toBe(true);
    const value = "x".repeat(MAX_STRING_VALUE_LENGTH);
    expect(buildLogEvent(name, { detail: value }).detail).toBe(value);
  });

  it("resolves supported log levels case-insensitively", () => {
    expect(resolveLogLevel("info")).toBe("info");
    expect(resolveLogLevel(" ERROR ")).toBe("error");
    expect(resolveLogLevel("Debug")).toBe("debug");
  });
});

// ─── Negative (secrets / nesting / invalid names) ────────────────────────────

describe("log schema (negative)", () => {
  it("redacts sensitive keys via the canonical policy, never the values", () => {
    const built = buildLogEvent("handler_failed", {
      seed: "abandon abandon abandon",
      paymentProof: "proof-bytes",
      token: "tok_secret",
      apiKey: "tak_secret",
      mediaUrl: "https://cdn.test/secret.mp4",
      content: "sensitive body",
      password: "hunter2",
      operation: "buy-token",
    });
    expect(built.seed).toBe("[REDACTED]");
    expect(built.paymentProof).toBe("[REDACTED]");
    expect(built.token).toBe("[REDACTED]");
    expect(built.apiKey).toBe("[REDACTED]");
    expect(built.mediaUrl).toBe("[REDACTED]");
    expect(built.content).toBe("[REDACTED]");
    expect(built.password).toBe("[REDACTED]");
    expect(built.operation).toBe("buy-token");
    expect(JSON.stringify(built)).not.toContain("abandon");
    expect(JSON.stringify(built)).not.toContain("hunter2");
  });

  it("drops nested objects, arrays, and functions instead of serializing them", () => {
    expect(
      sanitizeLogFields({
        nested: { a: 1 },
        list: [1, 2],
        fn: () => {},
        ok: "kept",
      }),
    ).toEqual({ ok: "kept" });
    expect(sanitizeLogValue(NaN)).toBeUndefined();
    expect(sanitizeLogValue(Infinity)).toBeUndefined();
    expect(sanitizeLogValue(undefined)).toBeUndefined();
  });

  it("fails closed on invalid event names without echoing input", () => {
    const hostile = "api_key=ghp_supersecret";
    for (const bad of [hostile, "Has Spaces", "SCREAMING", "with-dash", "0abc"]) {
      const built = buildLogEvent(bad, { operation: "x" });
      expect(built.event).toBe(INVALID_LOG_EVENT);
      expect(JSON.stringify(built)).not.toContain(hostile);
      expect(built.reason).toMatch(/missing|malformed|oversized/);
    }
    expect(isValidEventName("Has Spaces")).toBe(false);
    expect(isValidFieldKey("has space")).toBe(false);
  });

  it("fails closed on invalid log levels", () => {
    expect(resolveLogLevel("verbose")).toBe("warn");
    expect(resolveLogLevel(123)).toBe("warn");
    expect(resolveLogLevel(undefined)).toBe("warn");
  });
});

// ─── Boundary (missing / malformed / oversized) ──────────────────────────────

describe("log schema (boundary)", () => {
  it("fails closed on missing event input with a reason code", () => {
    for (const missing of [undefined, null, "", "   "]) {
      const built = buildLogEvent(missing);
      expect(built).toMatchObject({
        event: INVALID_LOG_EVENT,
        schemaVersion: 1,
        reason: "missing",
      });
    }
  });

  it("fails closed on malformed event types", () => {
    for (const malformed of [123, true, {}, [], ["x"]]) {
      expect(buildLogEvent(malformed).reason).toBe("malformed");
    }
    expect(buildLogEvent(123, "not-an-object")).toEqual({
      event: INVALID_LOG_EVENT,
      schemaVersion: 1,
      reason: "malformed",
    });
  });

  it("rejects oversized event names and truncates oversized values", () => {
    const tooLong = `e${"v".repeat(MAX_EVENT_NAME_LENGTH)}`;
    expect(buildLogEvent(tooLong).reason).toBe("oversized");
    const long = "y".repeat(MAX_STRING_VALUE_LENGTH + 50);
    const built = buildLogEvent("handler_failed", { detail: long });
    expect((built.detail as string).length).toBeLessThanOrEqual(
      MAX_STRING_VALUE_LENGTH + 1,
    );
    expect(built.detail).not.toBe(long);
  });

  it("caps field count and drops invalid keys", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < MAX_LOG_FIELDS + 5; i++) many[`f${i}`] = i;
    const built = buildLogEvent("job_completed", {
      ...many,
      "bad key": 1,
      "": 2,
    });
    const keys = Object.keys(built).filter(
      (k) => k !== "event" && k !== "schemaVersion",
    );
    expect(keys.length).toBeLessThanOrEqual(MAX_LOG_FIELDS);
    expect(built).not.toHaveProperty("bad key");
  });

  it("reuses the shared requestId sanitizer (never echoes raw input)", () => {
    // The shared sanitizer cleans recoverable input instead of dropping it.
    expect(
      buildLogEvent("job_completed", {}, { requestId: "bad id\nx" }),
    ).toMatchObject({ event: "job_completed", requestId: "bad-id-x" });
    // Unrecoverable input is omitted, never echoed.
    const withBad = buildLogEvent("job_completed", {}, { requestId: "!!!" });
    expect(withBad).not.toHaveProperty("requestId");
    expect(
      buildLogEvent("job_completed", {}, { requestId: 123 }),
    ).not.toHaveProperty("requestId");
  });
});

// ─── Regression (existing interfaces unchanged) ──────────────────────────────

describe("log schema (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches the checked-in fixture (fail closed on drift)", () => {
    expect({
      schemaVersion: LOG_SCHEMA_VERSION,
      maxEventNameLength: MAX_EVENT_NAME_LENGTH,
      maxFieldKeyLength: MAX_FIELD_KEY_LENGTH,
      maxStringValueLength: MAX_STRING_VALUE_LENGTH,
      maxLogFields: MAX_LOG_FIELDS,
    }).toEqual(fixture.bounds);
  });

  it("logOutboxEvent keeps its signature and emits schema-stamped lines", () => {
    logOutboxEvent("outbox_event_written", {
      eventId: "evt-1",
      eventType: "job.created",
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [obj, msg] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toBe("outbox_event_written");
    expect(obj).toMatchObject({
      event: "outbox_event_written",
      schemaVersion: 1,
      eventId: "evt-1",
    });
  });

  it("logJobEvent keeps its signature and emits schema-stamped lines", () => {
    logJobEvent("job_enqueued", { jobId: "j-1", queue: "default" });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [obj, msg] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toBe("job_enqueued");
    expect(obj).toMatchObject({
      event: "job_enqueued",
      schemaVersion: 1,
      jobId: "j-1",
    });
  });

  it("truncateError behavior is unchanged (500-char cap, message only)", () => {
    expect(truncateError(new Error("boom"))).toBe("boom");
    const long = "z".repeat(600);
    const out = truncateError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out).not.toBe(long);
  });

  it("builders are pure and retry-safe (no throw on hostile input)", () => {
    const hostile = { seed: "s", nested: { x: 1 }, [Symbol("k")]: 1 };
    expect(() => buildLogEvent(hostile, hostile)).not.toThrow();
    expect(() => sanitizeLogFields(null)).not.toThrow();
    expect(buildLogEvent("a", { b: 1 })).toEqual(buildLogEvent("a", { b: 1 }));
  });
});
