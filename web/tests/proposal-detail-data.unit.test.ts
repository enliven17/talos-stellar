import { beforeEach, describe, expect, it, vi } from "vitest";

// The database answers from a queue, one entry per query the loader makes.
const state = vi.hoisted(() => ({
  queue: [] as Array<unknown[] | Error>,
  queries: 0,
  proposal: null as unknown,
  quorum: null as unknown,
  votes: null as unknown,
  voteArgs: [] as unknown[][],
}));

vi.mock("@/db", () => {
  const chain: Record<string, unknown> = {};
  for (const name of ["from", "innerJoin", "where"]) chain[name] = () => chain;
  chain.limit = async () => {
    state.queries += 1;
    const next = state.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  };
  return { db: { select: () => chain } };
});

vi.mock("@/lib/soroban", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/soroban")>();
  return {
    ...actual,
    getProposalOnChain: async () => state.proposal,
    getProposalQuorumStateOnChain: async () => state.quorum,
    getProposalVotesOnChain: async (...args: unknown[]) => {
      state.voteArgs.push(args);
      return state.votes;
    },
  };
});

import { loadProposalPage, sanitizeCursor } from "../src/lib/proposal-detail-data";
import { databaseRows, proposals, quorums, votes } from "./fixtures/governance/proposals";

const onChain = { kind: "on-chain", proposalId: 7 } as const;
const page = (overrides: Record<string, unknown> = {}) => ({
  votes,
  nextCursor: null,
  oldestLedger: 100,
  latestLedger: 5_000,
  ...overrides,
});

beforeEach(() => {
  state.queue = [];
  state.queries = 0;
  state.voteArgs = [];
  state.proposal = { status: "ok", data: proposals.Active };
  state.quorum = { status: "ok", data: quorums.Active };
  state.votes = { status: "ok", data: page() };
});

describe("sanitizeCursor", () => {
  it("keeps a cursor shaped like the RPC's and drops anything else", () => {
    expect(sanitizeCursor("0000000000000099-0000000001")).toBe("0000000000000099-0000000001");
    expect(sanitizeCursor(["abc-1", "second"])).toBe("abc-1");
    expect(sanitizeCursor(undefined)).toBeUndefined();
    expect(sanitizeCursor("")).toBeUndefined();
    expect(sanitizeCursor("a b")).toBeUndefined();
    expect(sanitizeCursor("a/b?c=d")).toBeUndefined();
    expect(sanitizeCursor("<script>")).toBeUndefined();
    expect(sanitizeCursor("a".repeat(201))).toBeUndefined();
  });
});

describe("loadProposalPage: database proposals", () => {
  const route = { kind: "database", id: "clx9pending0001" } as const;

  it("is not-found when no row matches", async () => {
    state.queue = [[]];
    expect(await loadProposalPage(route)).toEqual({ kind: "not-found" });
  });

  it("builds the view, timeline and a not-applicable vote section from the row", async () => {
    state.queue = [[databaseRows.pending]];
    const data = await loadProposalPage(route);

    expect(data.kind).toBe("ready");
    if (data.kind === "ready") {
      expect(data.view).toMatchObject({ source: "database", state: "active", title: "Buy a newsletter slot" });
      expect(data.timeline.map((s) => s.key)).toEqual(["submitted", "decision"]);
      expect(data.votes).toEqual({ kind: "not-applicable" });
      expect(data.notices).toEqual([]);
    }
  });

  it("never reads the chain for a database proposal", async () => {
    state.queue = [[databaseRows.approved]];
    state.proposal = { status: "unavailable" };
    const data = await loadProposalPage(route);
    expect(data.kind).toBe("ready");
    expect(state.voteArgs).toHaveLength(0);
  });

  it("lets a database failure through so the route's error page handles it", async () => {
    state.queue = [new Error("connection refused")];
    await expect(loadProposalPage(route)).rejects.toThrow("connection refused");
  });
});

describe("loadProposalPage: on-chain proposals", () => {
  it("is not-found when the contract has no such proposal", async () => {
    state.proposal = { status: "not-found" };
    expect(await loadProposalPage(onChain)).toEqual({ kind: "not-found" });
  });

  it("shows a notice when no governance contract is configured", async () => {
    state.proposal = { status: "not-configured" };
    const data = await loadProposalPage(onChain);
    expect(data).toMatchObject({ kind: "notice", title: expect.stringMatching(/not set up/i) });
    expect(state.queries).toBe(0);
  });

  it("shows a retry notice, not a 404, when the network cannot be read", async () => {
    state.proposal = { status: "unavailable" };
    const data = await loadProposalPage(onChain);
    expect(data).toMatchObject({ kind: "notice", title: expect.stringMatching(/could not read/i) });
  });

  it("combines the proposal, quorum, votes and the agent found by registry id", async () => {
    state.queue = [[{ id: "talos-1", name: "Growth Agent" }]];
    const data = await loadProposalPage(onChain);

    expect(data.kind).toBe("ready");
    if (data.kind === "ready") {
      expect(data.view.agent).toEqual({ name: "Growth Agent", id: "talos-1" });
      expect(data.view.quorum?.quorumPercent).toBe(70);
      expect(data.votes).toMatchObject({ kind: "ok", nextHref: null, firstHref: null, incomplete: false });
      expect(data.notices).toEqual([]);
      // 5 000 is before the window closes at ledger 18 290.
      expect(data.timeline[1].label).toBe("Voting open");
    }
  });

  it("falls back to 'Agent #<id>' when the agent is unknown or the database is down", async () => {
    state.queue = [[]];
    let data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.view.agent).toEqual({ name: "Agent #3", id: null });

    state.queue = [new Error("db down")];
    data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.view.agent).toEqual({ name: "Agent #3", id: null });
  });

  it("keeps the page when quorum cannot be read and says so", async () => {
    state.quorum = { status: "unavailable" };
    const data = await loadProposalPage(onChain);
    expect(data.kind).toBe("ready");
    if (data.kind === "ready") {
      expect(data.view.quorum).toBeNull();
      expect(data.notices).toEqual(["Quorum details could not be read from the network right now."]);
    }
  });

  it("keeps the page when the vote list cannot be read", async () => {
    state.votes = { status: "unavailable" };
    const data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.votes).toEqual({ kind: "unavailable" });
    // Without a latest ledger the stored status decides, so a still-active proposal reads as open.
    expect(data.kind === "ready" && data.timeline[1].label).toBe("Voting open");
  });

  it("links to the next page with an encoded cursor, and back to the first page when paging", async () => {
    state.votes = { status: "ok", data: page({ nextCursor: "0001-0002" }) };
    const first = await loadProposalPage(onChain);
    expect(first.kind === "ready" && first.votes).toMatchObject({
      nextHref: "/proposals/7?cursor=0001-0002",
      firstHref: null,
    });

    const second = await loadProposalPage(onChain, "0001-0002");
    expect(second.kind === "ready" && second.votes).toMatchObject({ firstHref: "/proposals/7" });
    expect(state.voteArgs.at(-1)).toEqual([7, { cursor: "0001-0002" }]);
  });

  it("flags the list as incomplete when voting began before the RPC's oldest ledger", async () => {
    // The proposal's voting began at ledger 1 010.
    state.votes = { status: "ok", data: page({ oldestLedger: 1_011 }) };
    let data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.votes).toMatchObject({ incomplete: true });

    state.votes = { status: "ok", data: page({ oldestLedger: 1_010 }) };
    data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.votes).toMatchObject({ incomplete: false });
  });

  it("closes the voting step once the latest ledger is past the end ledger", async () => {
    state.votes = { status: "ok", data: page({ latestLedger: 20_000 }) };
    const data = await loadProposalPage(onChain);
    expect(data.kind === "ready" && data.timeline[1].label).toBe("Voting closed");
  });
});
