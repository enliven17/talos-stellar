import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  formatTimestamp,
  formatWeight,
  parseProposalRoute,
  quorumViewFromChain,
  shortAddress,
  viewFromChain,
  viewFromDatabase,
} from "../src/lib/proposal-detail";
import { databaseRows, proposals, quorums, PROPOSER, TX_A } from "./fixtures/governance/proposals";

describe("parseProposalRoute", () => {
  it("reads a plain number as an on-chain proposal id", () => {
    expect(parseProposalRoute("7")).toEqual({ kind: "on-chain", proposalId: 7 });
    expect(parseProposalRoute("0")).toEqual({ kind: "on-chain", proposalId: 0 });
    expect(parseProposalRoute("4294967295")).toEqual({ kind: "on-chain", proposalId: 4294967295 });
  });

  it("reads anything else shaped like an id as a database id", () => {
    expect(parseProposalRoute("clx9pending0001")).toEqual({ kind: "database", id: "clx9pending0001" });
    expect(parseProposalRoute("a-b_c")).toEqual({ kind: "database", id: "a-b_c" });
  });

  it("rejects numbers that are not a u32 or not canonical", () => {
    expect(parseProposalRoute("4294967296")).toBeNull();
    expect(parseProposalRoute("07")).toBeNull();
    expect(parseProposalRoute("12345678901")).toBeNull();
  });

  it("rejects empty, over-long and unsafe segments", () => {
    expect(parseProposalRoute("")).toBeNull();
    expect(parseProposalRoute("   ")).toBeNull();
    expect(parseProposalRoute("a".repeat(65))).toBeNull();
    expect(parseProposalRoute("a/b")).toBeNull();
    expect(parseProposalRoute("a b")).toBeNull();
    expect(parseProposalRoute("..%2f")).toBeNull();
    expect(parseProposalRoute("-1")).toEqual({ kind: "database", id: "-1" });
  });
});

describe("viewFromDatabase", () => {
  it("maps each stored status to a state", () => {
    expect(viewFromDatabase(databaseRows.pending)).toMatchObject({ state: "active", stateLabel: "Pending" });
    expect(viewFromDatabase(databaseRows.approved)).toMatchObject({ state: "approved", stateLabel: "Approved" });
    expect(viewFromDatabase(databaseRows.rejected)).toMatchObject({ state: "rejected", stateLabel: "Rejected" });
  });

  it("shows an unknown status as active with its own label instead of hiding it", () => {
    const view = viewFromDatabase({ ...databaseRows.pending, status: "escalated" });
    expect(view.state).toBe("active");
    expect(view.stateLabel).toBe("escalated");
  });

  it("normalises dates and drops unparseable ones", () => {
    const view = viewFromDatabase({ ...databaseRows.approved, decidedAt: new Date("2026-10-02T09:00:00Z") });
    expect(view.decidedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(viewFromDatabase({ ...databaseRows.approved, decidedAt: "not a date" }).decidedAt).toBeNull();
  });

  it("carries the agent, the amount and no quorum", () => {
    const view = viewFromDatabase(databaseRows.pending);
    expect(view.agent).toEqual({ name: "Growth Agent", id: "talos-1" });
    expect(view.amount).toBe("120.00");
    expect(view.quorum).toBeNull();
    expect(view.source).toBe("database");
  });
});

describe("quorumViewFromChain", () => {
  it("converts the contract's basis points to percentages without recomputing them", () => {
    const view = quorumViewFromChain(quorums.Active, 4);
    expect(view.quorumPercent).toBe(70);
    expect(view.approvalPercent).toBe(85.71);
    expect(view.consensusPercent).toBe(60);
    expect(view.totalVoters).toBe(4);
  });

  it("is not consensus when quorum is not met, even with high approval", () => {
    expect(quorumViewFromChain(quorums.Active, 4).consensusMet).toBe(false);
  });

  it("is consensus only when quorum is met and approval reaches the threshold", () => {
    expect(quorumViewFromChain(quorums.Approved, 6).consensusMet).toBe(true);
    expect(quorumViewFromChain(quorums.Rejected, 5).consensusMet).toBe(false);
    // exactly at the threshold passes
    expect(
      quorumViewFromChain({ ...quorums.Approved, approvalBps: 6_000 }, 6).consensusMet,
    ).toBe(true);
    expect(
      quorumViewFromChain({ ...quorums.Approved, approvalBps: 5_999 }, 6).consensusMet,
    ).toBe(false);
  });

  it("is never consensus with no votes cast", () => {
    const empty = {
      ...quorums.Active,
      votesCast: "0",
      yesVotes: "0",
      noVotes: "0",
      approvalBps: 0,
      quorumFractionBps: 0,
      consensusThreshold: 0,
      quorumMet: true,
    };
    expect(quorumViewFromChain(empty, 0).consensusMet).toBe(false);
  });

  it("clamps out-of-range basis points to 0 to 100", () => {
    const view = quorumViewFromChain({ ...quorums.Approved, quorumFractionBps: 12_000, approvalBps: -5 }, 1);
    expect(view.quorumPercent).toBe(100);
    expect(view.approvalPercent).toBe(0);
  });
});

describe("viewFromChain", () => {
  it("maps every on-chain status", () => {
    expect(viewFromChain(proposals.Active, null, null).state).toBe("active");
    expect(viewFromChain(proposals.Approved, null, null).state).toBe("approved");
    expect(viewFromChain(proposals.Rejected, null, null).state).toBe("rejected");
    expect(viewFromChain(proposals.Executed, null, null).state).toBe("executed");
  });

  it("converts the unix creation time and keeps the voting window", () => {
    const view = viewFromChain(proposals.Active, quorums.Active, { name: "Growth Agent", id: "t1" });
    expect(view.createdAt).toBe("2025-10-09T08:53:20.000Z");
    expect(view.voting).toEqual({ snapshotLedger: 1_000, startLedger: 1_010, endLedger: 18_290 });
    expect(view.proposer).toBe(PROPOSER);
    expect(view.quorum?.quorumPercent).toBe(70);
  });

  it("treats an empty description as none and a missing quorum as null", () => {
    const view = viewFromChain(proposals.Rejected, null, null);
    expect(view.description).toBeNull();
    expect(view.quorum).toBeNull();
  });
});

function states(steps: ReturnType<typeof buildTimeline>) {
  return steps.map((s) => `${s.key}:${s.state}`);
}

describe("buildTimeline: database proposals", () => {
  it("pending: submitted is done, the decision is the current step", () => {
    const steps = buildTimeline(viewFromDatabase(databaseRows.pending));
    expect(states(steps)).toEqual(["submitted:done", "decision:current"]);
  });

  it("approved with a transaction: decision and record are done, nothing is current", () => {
    const steps = buildTimeline(viewFromDatabase(databaseRows.approved));
    expect(states(steps)).toEqual(["submitted:done", "decision:done", "transaction:done"]);
    expect(steps[1].label).toBe("Approved");
    expect(steps[1].at).toBe("2026-10-02T09:00:00.000Z");
    expect(steps[2].txHash).toBe(TX_A);
  });

  it("rejected without a transaction has no record step", () => {
    const steps = buildTimeline(viewFromDatabase(databaseRows.rejected));
    expect(states(steps)).toEqual(["submitted:done", "decision:done"]);
    expect(steps[1].label).toBe("Rejected");
  });
});

describe("buildTimeline: on-chain proposals", () => {
  const view = (status: keyof typeof proposals) =>
    viewFromChain(proposals[status], quorums[status], null);

  it("active and open: voting is the current step", () => {
    const steps = buildTimeline(view("Active"), 5_000);
    expect(states(steps)).toEqual([
      "proposed:done",
      "voting:current",
      "quorum:upcoming",
      "outcome:upcoming",
    ]);
    expect(steps[1].label).toBe("Voting open");
  });

  it("active but past the end ledger: voting is closed and the outcome is awaited", () => {
    const steps = buildTimeline(view("Active"), 20_000);
    expect(steps[1].label).toBe("Voting closed");
    expect(steps[1].state).toBe("done");
    expect(steps[2].detail).toBe("Quorum was not reached");
    expect(states(steps).filter((s) => s.endsWith(":current"))).toEqual(["quorum:current"]);
  });

  it("active with quorum met shows quorum done while voting stays the current step", () => {
    const steps = buildTimeline(
      viewFromChain(proposals.Active, { ...quorums.Active, quorumMet: true, quorumFractionBps: 10_000 }, null),
      5_000,
    );
    expect(states(steps)).toEqual([
      "proposed:done",
      "voting:current",
      "quorum:done",
      "outcome:upcoming",
    ]);
  });

  it("approved: ends with a not-yet-executed step and no current step", () => {
    const steps = buildTimeline(view("Approved"));
    expect(states(steps)).toEqual([
      "proposed:done",
      "voting:done",
      "quorum:done",
      "outcome:done",
      "execution:upcoming",
    ]);
    expect(steps[3].label).toBe("Approved");
    expect(steps[4].label).toBe("Execution");
  });

  it("rejected: ends at the outcome", () => {
    const steps = buildTimeline(view("Rejected"));
    expect(states(steps)).toEqual(["proposed:done", "voting:done", "quorum:done", "outcome:done"]);
    expect(steps[3].label).toBe("Rejected");
  });

  it("executed: every step is done", () => {
    const steps = buildTimeline(view("Executed"));
    expect(steps.every((s) => s.state === "done")).toBe(true);
    expect(steps.at(-1)?.label).toBe("Executed");
  });

  it("without a latest ledger the stored status decides whether voting is open", () => {
    expect(buildTimeline(view("Active"))[1].label).toBe("Voting open");
  });

  it("has at most one current step for every status", () => {
    for (const status of ["Active", "Approved", "Rejected", "Executed"] as const) {
      const current = buildTimeline(view(status), 5_000).filter((s) => s.state === "current");
      expect(current.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("formatting helpers", () => {
  it("shortens long addresses only", () => {
    expect(shortAddress(PROPOSER)).toBe("GBZXN7...MADI");
    expect(shortAddress("GABC")).toBe("GABC");
  });

  it("formats weights with separators, including values beyond Number precision", () => {
    expect(formatWeight("1234567")).toBe("1,234,567");
    expect(formatWeight("170141183460469231731687303715884105727")).toBe(
      "170,141,183,460,469,231,731,687,303,715,884,105,727",
    );
    expect(formatWeight("not a number")).toBe("not a number");
  });

  it("formats timestamps in UTC and returns nothing for missing or bad input", () => {
    // ICU may put a narrow no-break space before "AM", so match loosely.
    expect(formatTimestamp("2026-10-01T10:00:00Z")).toMatch(/^Oct 1, 2026,? 10:00\s+AM UTC$/);
    expect(formatTimestamp("2026-10-01T22:05:00Z")).toMatch(/10:05\s+PM UTC$/);
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp("garbage")).toBe("");
  });
});
