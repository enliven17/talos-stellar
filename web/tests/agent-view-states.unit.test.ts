import { describe, it, expect } from "vitest";
import {
  toPrivacySafeAgentError,
  emptyCopyFor,
} from "../src/lib/agent-view-errors";
import {
  AgentEmptyState,
  AgentErrorState,
} from "../src/components/agent-view-states";

describe("toPrivacySafeAgentError", () => {
  it("returns fallback for nullish / empty input (boundary)", () => {
    expect(toPrivacySafeAgentError(null)).toMatch(/try again/i);
    expect(toPrivacySafeAgentError(undefined)).toMatch(/try again/i);
    expect(toPrivacySafeAgentError("   ")).toMatch(/try again/i);
  });

  it("passes through short, non-sensitive messages (positive)", () => {
    expect(toPrivacySafeAgentError("Connection timed out")).toBe(
      "Connection timed out",
    );
  });

  it("redacts secret-bearing messages (negative)", () => {
    expect(toPrivacySafeAgentError("api_key=ghp_secretvaluehere")).toMatch(
      /try again/i,
    );
    expect(
      toPrivacySafeAgentError("seed phrase: abandon abandon abandon"),
    ).toMatch(/try again/i);
    expect(
      toPrivacySafeAgentError("Authorization: Bearer abc.def.ghi"),
    ).toMatch(/try again/i);
  });

  it("redacts JWTs, long hex, and Stellar secret keys (negative)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.signaturepart";
    expect(toPrivacySafeAgentError(`bad token ${jwt}`)).toContain("[redacted]");

    const hex = "a".repeat(40);
    expect(toPrivacySafeAgentError(`proof ${hex}`)).toContain("[redacted]");

    const secret = "S" + "A".repeat(55);
    expect(toPrivacySafeAgentError(`wallet ${secret}`)).toContain("[redacted]");
  });

  it("collapses multi-line stacks and truncates long strings (boundary)", () => {
    const stacked = "DB failed\n    at Object.query (/app/db.ts:12:3)";
    expect(toPrivacySafeAgentError(stacked)).toBe("DB failed");

    const long = "x".repeat(250);
    const out = toPrivacySafeAgentError(long);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.endsWith("...")).toBe(true);
  });

  it("accepts Error instances and custom fallback (regression)", () => {
    expect(toPrivacySafeAgentError(new Error("boom"), "safe")).toBe("boom");
    expect(toPrivacySafeAgentError({ message: "nope" })).toBe("nope");
  });
});

describe("emptyCopyFor", () => {
  it("returns distinct copy per empty kind (positive)", () => {
    expect(emptyCopyFor("catalog").title).toMatch(/no agents/i);
    expect(emptyCopyFor("filtered").title).toMatch(/match/i);
    expect(emptyCopyFor("service").description).toMatch(/commerce/i);
    expect(emptyCopyFor("activity").title).toMatch(/activity/i);
    expect(emptyCopyFor("patrons").title).toMatch(/patrons/i);
    expect(emptyCopyFor("revenue").title).toMatch(/revenue/i);
    expect(emptyCopyFor("proposals").title).toMatch(/proposals/i);
  });
});

describe("AgentEmptyState / AgentErrorState element contracts", () => {
  function findTestId(node: unknown, id: string): unknown {
    if (!node || typeof node !== "object") return null;
    const n = node as { props?: Record<string, unknown> };
    if (n.props?.["data-testid"] === id) return n;
    const kids = n.props?.children;
    if (Array.isArray(kids)) {
      for (const k of kids) {
        const hit = findTestId(k, id);
        if (hit) return hit;
      }
    } else if (kids) {
      return findTestId(kids, id);
    }
    return null;
  }

  it("empty state announces politely with role=status (positive)", () => {
    const el = AgentEmptyState({ kind: "filtered" });
    expect(el.props.role).toBe("status");
    expect(el.props["aria-live"]).toBe("polite");
    expect(el.props["data-testid"]).toBe("agent-empty-filtered");
  });

  it("error state uses assertive alert and privacy-safe message (negative)", () => {
    const el = AgentErrorState({
      error: "api_key=supersecret",
      onRetry: () => {},
    });
    expect(el.props.role).toBe("alert");
    expect(el.props["aria-live"]).toBe("assertive");
    expect(el.props["data-testid"]).toBe("agent-error-state");
    const flat = JSON.stringify(el);
    expect(flat).not.toMatch(/supersecret/);
    expect(flat).toMatch(/try again/i);
  });

  it("error state exposes retry control when provided (positive)", () => {
    const el = AgentErrorState({
      message: "Transient failure",
      onRetry: () => {},
      retryLabel: "Retry load",
    });
    const retry = findTestId(el, "agent-error-retry") as {
      props: { children: string; type: string };
    };
    expect(retry).toBeTruthy();
    expect(retry.props.type).toBe("button");
    expect(retry.props.children).toBe("Retry load");
  });
});
