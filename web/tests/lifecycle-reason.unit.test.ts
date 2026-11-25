// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import {
  LIFECYCLE_REASON_MAX_LENGTH,
  LifecycleError,
  RETIREMENT_REASON_MAX_LENGTH,
  assertLifecycleReason,
  checkLifecycleReason,
  countReasonCharacters,
} from "@/lib/governance/lifecycle";
import { parseLifecyclePayload } from "@/lib/governance/payloads";
import { emitLifecycleEvent, LIFECYCLE_EVENTS } from "@/lib/governance/events";
import { retireAgentSchema } from "@/lib/schemas";

const AGENT_ID = "cm3x9agentreplacement0001";
const JOB_ID = "0b6f7c9e-3f2a-4f6e-9a51-6c1d2e3f4a5b";
const PROPOSAL_ID = "prop_7f3c2a91";

describe("checkLifecycleReason", () => {
  it("accepts a useful short reason and returns it unmodified, identifiers intact", () => {
    const reason = `  Superseded by ${AGENT_ID} per proposal ${PROPOSAL_ID}\n`;
    expect(checkLifecycleReason(reason)).toEqual({
      ok: true,
      reason, // not trimmed, not truncated
      length: countReasonCharacters(reason),
    });
  });

  it("accepts exactly the maximum and rejects one character more (boundary)", () => {
    const atMax = `${AGENT_ID} `.padEnd(LIFECYCLE_REASON_MAX_LENGTH, "x");
    expect(checkLifecycleReason(atMax)).toMatchObject({ ok: true, length: 500 });

    const over = `${atMax}x`;
    expect(checkLifecycleReason(over)).toEqual({
      ok: false,
      issue: "too_long",
      message: "reason must be at most 500 characters (got 501)",
      maxLength: 500,
      length: 501,
    });
  });

  it("counts characters as code points, so emoji are not double-counted", () => {
    const emoji = "🚀".repeat(RETIREMENT_REASON_MAX_LENGTH); // 2,000 UTF-16 units
    expect(emoji.length).toBe(2 * RETIREMENT_REASON_MAX_LENGTH);
    expect(checkLifecycleReason(emoji, RETIREMENT_REASON_MAX_LENGTH)).toMatchObject({
      ok: true,
      length: RETIREMENT_REASON_MAX_LENGTH,
    });
    expect(checkLifecycleReason(`${emoji}🚀`, RETIREMENT_REASON_MAX_LENGTH)).toMatchObject({
      ok: false,
      issue: "too_long",
    });
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["whitespace mix", " \t\n\r "],
  ])("rejects a blank reason (%s)", (_name, value) => {
    expect(checkLifecycleReason(value)).toMatchObject({ ok: false, issue: "blank" });
  });

  it.each([
    ["NUL (rejected by Postgres text)", "Obsolete\u0000"],
    ["escape", "Obsolete\u001b[31m"],
    ["DEL", "Obsolete\u007f"],
    ["lone high surrogate", "Obsolete \ud83d"],
    ["lone low surrogate", "Obsolete \ude80"],
  ])("rejects invalid characters: %s", (_name, value) => {
    expect(checkLifecycleReason(value)).toMatchObject({ ok: false, issue: "invalid_characters" });
  });

  it("allows tab, newline, and carriage return inside a reason", () => {
    expect(checkLifecycleReason("Line one\r\n\tLine two").ok).toBe(true);
  });

  it("rejects non-strings", () => {
    for (const value of [undefined, null, 42, ["Obsolete"], { reason: "x" }]) {
      expect(checkLifecycleReason(value)).toMatchObject({
        ok: false,
        issue: "not_a_string",
        length: null,
      });
    }
  });

  it("never echoes the submitted value in the error message", () => {
    const secretish = `${"S".repeat(600)}GSECRETVALUE`;
    const result = checkLifecycleReason(secretish);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("GSECRETVALUE");
  });
});

describe("assertLifecycleReason", () => {
  it("throws a 400 LIFECYCLE_INVALID_PAYLOAD with field-level details", () => {
    let caught: unknown;
    try {
      assertLifecycleReason("x".repeat(501));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LifecycleError);
    const err = caught as LifecycleError;
    expect(err.code).toBe("LIFECYCLE_INVALID_PAYLOAD");
    expect(err.status).toBe(400);
    expect(err.details).toEqual({ field: "reason", issue: "too_long", maxLength: 500, length: 501 });
  });

  it("returns the reason unchanged when valid", () => {
    expect(assertLifecycleReason("Obsolete ")).toBe("Obsolete ");
  });
});

describe("parseLifecyclePayload (governed transitions)", () => {
  function pause(reason: unknown) {
    return () => parseLifecyclePayload({ action: "pause", payload: { reason } });
  }

  it("accepts a reason at the 500-character bound", () => {
    const parsed = parseLifecyclePayload({
      action: "pause",
      payload: { reason: "r".repeat(LIFECYCLE_REASON_MAX_LENGTH) },
    });
    expect(parsed.action).toBe("pause");
  });

  it.each([
    ["over the bound", "r".repeat(501), "reason: reason must be at most 500 characters (got 501)"],
    // Before #1364 a whitespace-only reason passed `.min(1)`.
    ["whitespace only", "   ", "reason: reason must not be blank"],
    ["NUL byte", "pause\u0000", "reason: reason must not contain control characters or malformed Unicode"],
  ])("rejects a reason %s with LIFECYCLE_INVALID_PAYLOAD", (_name, reason, issue) => {
    expect(pause(reason)).toThrowError(LifecycleError);
    try {
      pause(reason)();
    } catch (err) {
      expect((err as LifecycleError).code).toBe("LIFECYCLE_INVALID_PAYLOAD");
      expect((err as LifecycleError).details.issues).toEqual([issue]);
    }
  });

  it("applies the same rule to retire and recover payloads", () => {
    for (const action of ["retire", "recover"] as const) {
      const payload =
        action === "retire"
          ? { reason: "   ", proposalId: PROPOSAL_ID, confirmed: true }
          : { reason: "   ", confirmed: true };
      expect(() => parseLifecyclePayload({ action, payload })).toThrowError(LifecycleError);
    }
  });
});

describe("retireAgentSchema (POST /api/talos/:id/retire)", () => {
  const base = { stellarPublicKey: "GABC", signature: "sig", message: `Retire ${AGENT_ID}` };

  it("keeps the 1,000-character bound: accepts 1,000, rejects 1,001", () => {
    expect(retireAgentSchema.safeParse({ ...base, reason: "r".repeat(1000) }).success).toBe(true);
    const over = retireAgentSchema.safeParse({ ...base, reason: "r".repeat(1001) });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]).toMatchObject({
      path: ["reason"],
      message: "reason must be at most 1000 characters (got 1001)",
    });
  });

  it.each([["   "], ["Obsolete\u0000"]])("rejects %j", (reason) => {
    expect(retireAgentSchema.safeParse({ ...base, reason }).success).toBe(false);
  });
});

describe("audit detail keeps identifiers at the maximum reason size", () => {
  it("does not collapse the retire event detail to { truncated: true }", async () => {
    // Worst case for the JSON-encoded size: every character needs escaping.
    const reason = '"'.repeat(RETIREMENT_REASON_MAX_LENGTH);
    expect(checkLifecycleReason(reason, RETIREMENT_REASON_MAX_LENGTH).ok).toBe(true);

    const inserted: Record<string, unknown>[] = [];
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      orderBy: () => selectChain,
      limit: () => Promise.resolve([]),
    };
    const executor = {
      select: () => selectChain,
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: "evt_1", sequence: 1 }]) };
        },
      }),
    };

    const detail = { reason, supersededBy: AGENT_ID, reconciliationJobId: JOB_ID };
    await emitLifecycleEvent(
      {
        talosId: "agent_1",
        eventType: LIFECYCLE_EVENTS.RETIRED,
        fromState: "active",
        toState: "retired",
        actorId: "GCREATOR",
        actorRole: "creator",
        detail,
      },
      executor as never,
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0].detail).toEqual(detail);
  });
});
