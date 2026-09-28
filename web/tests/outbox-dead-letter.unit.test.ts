import { describe, it, expect } from "vitest";
import {
  DEAD_LETTER_DEFAULT_LIMIT,
  DEAD_LETTER_MAX_LIMIT,
  parseDeadLetterQuery,
  sanitizeOutboxError,
  toDeadLetterView,
} from "@/lib/outbox/dead-letter";
import type { OutboxEvent } from "@/lib/outbox";

function event(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "evt_1",
    aggregateType: "commerce_job",
    aggregateId: "job_1",
    eventType: "commerce_job.completed",
    payload: { paymentProof: "AAAA-secret-proof", buyer: "GBUYER" },
    status: "dead_letter",
    runAt: new Date("2026-09-01T00:00:00.000Z"),
    leaseId: "lease-token",
    leaseOwner: "worker-1",
    leaseExpiresAt: null,
    attempts: 8,
    maxAttempts: 8,
    dedupeKey: "a".repeat(64),
    lastError: "consumer exploded",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:05:00.000Z"),
    dispatchedAt: null,
    ...overrides,
  };
}

const q = (s: string) => parseDeadLetterQuery(new URLSearchParams(s));

describe("toDeadLetterView", () => {
  it("projects the triage fields with ISO timestamps (positive)", () => {
    expect(toDeadLetterView(event())).toEqual({
      id: "evt_1",
      eventType: "commerce_job.completed",
      aggregateType: "commerce_job",
      aggregateId: "job_1",
      attempts: 8,
      maxAttempts: 8,
      lastError: "consumer exploded",
      createdAt: "2026-09-01T00:00:00.000Z",
      deadLetteredAt: "2026-09-01T00:05:00.000Z",
    });
  });

  it("never exposes payload, dedupeKey or lease fields (privacy)", () => {
    const view = toDeadLetterView(event()) as unknown as Record<string, unknown>;
    for (const key of ["payload", "dedupeKey", "leaseId", "leaseOwner", "leaseExpiresAt", "runAt", "status"]) {
      expect(view).not.toHaveProperty(key);
    }
    const text = JSON.stringify(view);
    expect(text).not.toContain("secret-proof");
    expect(text).not.toContain("lease-token");
  });

  it("accepts string timestamps (rows that went through JSON)", () => {
    const view = toDeadLetterView(
      event({ createdAt: "2026-09-02T00:00:00.000Z" as unknown as Date, updatedAt: "2026-09-02T01:00:00.000Z" as unknown as Date }),
    );
    expect(view.createdAt).toBe("2026-09-02T00:00:00.000Z");
    expect(view.deadLetteredAt).toBe("2026-09-02T01:00:00.000Z");
  });

  it("keeps a null lastError as null", () => {
    expect(toDeadLetterView(event({ lastError: null })).lastError).toBeNull();
  });
});

describe("sanitizeOutboxError", () => {
  it("passes through ordinary messages", () => {
    expect(sanitizeOutboxError("No consumer registered for eventType")).toBe("No consumer registered for eventType");
  });

  it.each([
    ["Stellar secret seed", "S" + "A".repeat(55)],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"],
    ["TALOS API key", "tak_0123456789abcdef"],
    ["bearer credential", "Bearer abc.def-ghi"],
    ["long hex", "f".repeat(64)],
    ["base64 XDR blob", "AAAAAgAAAAB".repeat(10)],
  ])("redacts a %s (negative)", (_label, secret) => {
    const out = sanitizeOutboxError(`consumer failed with ${secret} attached`);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(secret);
  });

  it("keeps only the first line (drops stack traces)", () => {
    expect(sanitizeOutboxError("boom\n    at handler (/app/src/consumer.ts:1:1)")).toBe("boom");
  });

  it("bounds the length (boundary)", () => {
    // Ordinary prose (a single long token would be redacted as a blob).
    const out = sanitizeOutboxError("consumer failed ".repeat(60))!;
    expect(out.length).toBe(301);
    expect(out.endsWith("…")).toBe(true);
  });

  it("maps null, undefined and blank to null", () => {
    expect(sanitizeOutboxError(null)).toBeNull();
    expect(sanitizeOutboxError(undefined)).toBeNull();
    expect(sanitizeOutboxError("   ")).toBeNull();
  });
});

describe("parseDeadLetterQuery", () => {
  it("defaults when nothing is supplied", () => {
    expect(q("")).toEqual({ ok: true, query: { limit: DEAD_LETTER_DEFAULT_LIMIT } });
  });

  it("accepts a full valid query", () => {
    const cursor = "2026-09-01T00:00:00.000Z";
    expect(q(`limit=10&cursor=${cursor}&eventType=commerce_job.completed`)).toEqual({
      ok: true,
      query: { limit: 10, cursor, eventType: "commerce_job.completed" },
    });
  });

  it("accepts limit at both bounds (boundary)", () => {
    expect(q("limit=1")).toMatchObject({ ok: true, query: { limit: 1 } });
    expect(q(`limit=${DEAD_LETTER_MAX_LIMIT}`)).toMatchObject({ ok: true, query: { limit: DEAD_LETTER_MAX_LIMIT } });
  });

  it.each(["0", String(DEAD_LETTER_MAX_LIMIT + 1), "-1", "1.5", "abc", "", "10abc"])(
    "rejects limit=%j instead of coercing (negative)",
    (limit) => {
      expect(q(`limit=${encodeURIComponent(limit)}`).ok).toBe(false);
    },
  );

  it.each(["not-a-date", "2026-09-01", "1717200000000", "2026-13-01T00:00:00.000Z"])(
    "rejects cursor=%j that is not a nextCursor value",
    (cursor) => {
      expect(q(`cursor=${encodeURIComponent(cursor)}`).ok).toBe(false);
    },
  );

  it("treats an empty cursor as absent", () => {
    expect(q("cursor=")).toEqual({ ok: true, query: { limit: DEAD_LETTER_DEFAULT_LIMIT } });
  });

  it("trims eventType and ignores a blank one", () => {
    expect(q("eventType=%20job.done%20")).toMatchObject({ ok: true, query: { eventType: "job.done" } });
    expect(q("eventType=%20%20")).toEqual({ ok: true, query: { limit: DEAD_LETTER_DEFAULT_LIMIT } });
  });

  it("rejects an eventType that is too long or has unsafe characters", () => {
    expect(q(`eventType=${"a".repeat(129)}`).ok).toBe(false);
    expect(q(`eventType=${"a".repeat(128)}`).ok).toBe(true);
    expect(q("eventType=job'%20OR%201=1").ok).toBe(false);
    expect(q("eventType=%3Cscript%3E").ok).toBe(false);
  });
});
