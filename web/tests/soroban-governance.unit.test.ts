import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@stellar/stellar-sdk";
import {
  VOTES_PAGE_SIZE,
  explorerTxUrl,
  getGovernanceContractId,
  getProposalOnChain,
  getProposalQuorumStateOnChain,
  getProposalVotesOnChain,
  parseOnChainProposal,
  parseOnChainQuorumState,
  parseOnChainVoteEvent,
} from "../src/lib/soroban";
import {
  TX_A,
  VOTER_A,
  VOTER_B,
  nativeProposal,
  nativeQuorum,
} from "./fixtures/governance/proposals";

// A fake Soroban RPC server. Everything else in the SDK is real, so the
// transactions, topics and decoded values are the ones the page really builds.
const rpcState = vi.hoisted(() => ({
  simulate: null as null | ((tx: unknown) => unknown),
  getEvents: null as null | ((request: Record<string, unknown>) => unknown),
  latestLedger: 200_000,
  simulateCalls: [] as unknown[],
  eventCalls: [] as Record<string, unknown>[],
  latestCalls: 0,
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    async simulateTransaction(tx: unknown) {
      rpcState.simulateCalls.push(tx);
      if (!rpcState.simulate) throw new Error("no simulate handler");
      return rpcState.simulate(tx);
    }
    async getLatestLedger() {
      rpcState.latestCalls += 1;
      return { sequence: rpcState.latestLedger };
    }
    async getEvents(request: Record<string, unknown>) {
      rpcState.eventCalls.push(request);
      if (!rpcState.getEvents) throw new Error("no getEvents handler");
      return rpcState.getEvents(request);
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } };
});

const { xdr, nativeToScVal, Address, StrKey } = sdk;
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

function sym(name: string) {
  return xdr.ScVal.scvSymbol(name);
}

/** A `#[contracttype]` struct as the ledger stores it: a map keyed by symbols, in key order. */
function struct(fields: Record<string, ReturnType<typeof xdr.ScVal.scvVoid>>) {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] })),
  );
}

const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u64 = (n: number) => nativeToScVal(n, { type: "u64" });
const i128 = (n: number) => nativeToScVal(BigInt(n), { type: "i128" });
const variant = (name: string) => xdr.ScVal.scvVec([sym(name)]);
const address = (key: string) => new Address(key).toScVal();

function proposalScVal(status = "Active") {
  return struct({
    id: u32(7),
    talos_id: u32(3),
    proposer: address(VOTER_A),
    title: xdr.ScVal.scvString("Fund the Q3 growth experiment"),
    description: xdr.ScVal.scvString("Spend 500 USDC."),
    snapshot_ledger: u32(1_000),
    start_ledger: u32(1_010),
    end_ledger: u32(18_290),
    status: variant(status),
    yes_votes: i128(600),
    no_votes: i128(100),
    total_voters: u32(4),
    created_at: u64(1_760_000_000),
  });
}

function quorumScVal() {
  return struct({
    votes_cast: i128(700),
    quorum_threshold: i128(1_000),
    quorum_met: xdr.ScVal.scvBool(false),
    yes_votes: i128(600),
    no_votes: i128(100),
    approval_bps: u32(8_571),
    consensus_threshold: u32(6_000),
    quorum_fraction_bps: u32(7_000),
  });
}

function simulated(retval: ReturnType<typeof xdr.ScVal.scvVoid>) {
  return { result: { retval } };
}

function voteEvent(voter: string, choice: string, weight: number, ledger: number, txHash = TX_A) {
  return {
    ledger,
    ledgerClosedAt: "2026-10-01T10:00:00Z",
    txHash,
    value: struct({
      proposal_id: u32(7),
      voter: address(voter),
      choice: variant(choice),
      weight: i128(weight),
    }),
  };
}

function eventsResponse(events: unknown[], extra: Record<string, unknown> = {}) {
  return { events, cursor: "0000000000000099-0000000001", oldestLedger: 100_000, latestLedger: 200_000, ...extra };
}

beforeEach(() => {
  rpcState.simulate = null;
  rpcState.getEvents = null;
  rpcState.latestLedger = 200_000;
  rpcState.simulateCalls = [];
  rpcState.eventCalls = [];
  rpcState.latestCalls = 0;
  vi.stubEnv("NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT", CONTRACT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getGovernanceContractId", () => {
  it("reads the configured contract and is empty when unset", () => {
    expect(getGovernanceContractId()).toBe(CONTRACT);
    vi.stubEnv("NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT", "");
    expect(getGovernanceContractId()).toBe("");
  });
});

describe("parseOnChainProposal", () => {
  it("parses what the SDK decodes, turning i128 into strings", () => {
    expect(parseOnChainProposal(nativeProposal("Active"))).toEqual({
      id: 7,
      talosId: 3,
      proposer: expect.any(String),
      title: "Fund the Q3 growth experiment",
      description: "Spend 500 USDC on a referral campaign.",
      snapshotLedger: 1_000,
      startLedger: 1_010,
      endLedger: 18_290,
      status: "Active",
      yesVotes: "600",
      noVotes: "100",
      totalVoters: 4,
      createdAt: 1_760_000_000,
    });
  });

  it("accepts every status, as an array variant or a plain string", () => {
    for (const status of ["Active", "Approved", "Rejected", "Executed"] as const) {
      expect(parseOnChainProposal(nativeProposal(status))?.status).toBe(status);
    }
    expect(parseOnChainProposal(nativeProposal("Active", { status: "Approved" }))?.status).toBe("Approved");
  });

  it("accepts u64 timestamps decoded as bigint", () => {
    expect(parseOnChainProposal(nativeProposal("Active", { created_at: BigInt(1_760_000_000) }))?.createdAt).toBe(
      1_760_000_000,
    );
  });

  it("rejects anything that is not a complete proposal", () => {
    expect(parseOnChainProposal(null)).toBeNull();
    expect(parseOnChainProposal("proposal")).toBeNull();
    expect(parseOnChainProposal([])).toBeNull();
    expect(parseOnChainProposal({})).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { status: ["Cancelled"] }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { status: undefined }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { title: 5 }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { yes_votes: "many" }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { end_ledger: -1 }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { total_voters: 2 ** 33 }))).toBeNull();
    expect(parseOnChainProposal(nativeProposal("Active", { proposer: undefined }))).toBeNull();
  });
});

describe("parseOnChainQuorumState", () => {
  it("parses the contract's quorum state", () => {
    expect(parseOnChainQuorumState(nativeQuorum())).toEqual({
      votesCast: "700",
      quorumThreshold: "1000",
      quorumMet: false,
      yesVotes: "600",
      noVotes: "100",
      approvalBps: 8_571,
      consensusThreshold: 6_000,
      quorumFractionBps: 7_000,
    });
  });

  it("rejects missing fields, wrong types and basis points above 10 000", () => {
    expect(parseOnChainQuorumState(null)).toBeNull();
    expect(parseOnChainQuorumState(nativeQuorum({ quorum_met: "yes" }))).toBeNull();
    expect(parseOnChainQuorumState(nativeQuorum({ votes_cast: undefined }))).toBeNull();
    expect(parseOnChainQuorumState(nativeQuorum({ approval_bps: 10_001 }))).toBeNull();
    expect(parseOnChainQuorumState(nativeQuorum({ quorum_fraction_bps: -1 }))).toBeNull();
    expect(parseOnChainQuorumState(nativeQuorum({ consensus_threshold: 1.5 }))).toBeNull();
  });

  it("keeps i128 values beyond Number precision exact", () => {
    const big = BigInt("170141183460469231731687303715884105727");
    expect(parseOnChainQuorumState(nativeQuorum({ votes_cast: big }))?.votesCast).toBe(big.toString());
  });
});

describe("parseOnChainVoteEvent", () => {
  const good = {
    txHash: TX_A,
    ledger: 1_200,
    ledgerClosedAt: "2026-10-01T10:00:00Z",
    value: { proposal_id: 7, voter: VOTER_A, choice: ["Approve"], weight: BigInt(400) },
  };

  it("parses an EventVoteCast", () => {
    expect(parseOnChainVoteEvent(good)).toEqual({
      voter: VOTER_A,
      choice: "Approve",
      weight: "400",
      txHash: TX_A,
      ledger: 1_200,
      closedAt: "2026-10-01T10:00:00Z",
    });
  });

  it("rejects an unknown choice, a missing voter, a bad weight or a missing transaction", () => {
    expect(parseOnChainVoteEvent({ ...good, value: { ...good.value, choice: ["Abstain"] } })).toBeNull();
    expect(parseOnChainVoteEvent({ ...good, value: { ...good.value, voter: undefined } })).toBeNull();
    expect(parseOnChainVoteEvent({ ...good, value: { ...good.value, weight: "lots" } })).toBeNull();
    expect(parseOnChainVoteEvent({ ...good, txHash: undefined })).toBeNull();
    expect(parseOnChainVoteEvent({ ...good, ledgerClosedAt: 5 })).toBeNull();
    expect(parseOnChainVoteEvent({ ...good, value: null })).toBeNull();
  });
});

describe("getProposalOnChain", () => {
  it("is not-configured, without any network call, when no contract is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT", "");
    expect(await getProposalOnChain(7)).toEqual({ status: "not-configured" });
    expect(rpcState.simulateCalls).toHaveLength(0);
  });

  it("simulates get_proposal with the id as a u32 and decodes the proposal", async () => {
    rpcState.simulate = () => simulated(proposalScVal("Active"));
    const read = await getProposalOnChain(7);

    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.data).toMatchObject({
        id: 7,
        talosId: 3,
        title: "Fund the Q3 growth experiment",
        status: "Active",
        yesVotes: "600",
        totalVoters: 4,
        createdAt: 1_760_000_000,
        proposer: VOTER_A,
      });
    }

    const tx = rpcState.simulateCalls[0] as { operations: Array<{ func: sdk.xdr.HostFunction; type: string }> };
    const invoke = tx.operations[0].func.invokeContract();
    expect(invoke.functionName().toString()).toBe("get_proposal");
    expect(invoke.args()).toHaveLength(1);
    expect(invoke.args()[0].switch().name).toBe("scvU32");
    expect(invoke.args()[0].u32()).toBe(7);
    expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(CONTRACT);
  });

  it("is not-found when the contract returns None", async () => {
    rpcState.simulate = () => simulated(xdr.ScVal.scvVoid());
    expect(await getProposalOnChain(999)).toEqual({ status: "not-found" });
  });

  it("is unavailable when the simulation errors, the RPC throws, or the value is malformed", async () => {
    rpcState.simulate = () => ({ error: "HostError" });
    expect(await getProposalOnChain(7)).toEqual({ status: "unavailable" });

    rpcState.simulate = () => {
      throw new Error("connect ETIMEDOUT");
    };
    expect(await getProposalOnChain(7)).toEqual({ status: "unavailable" });

    rpcState.simulate = () => simulated(struct({ id: u32(7) }));
    expect(await getProposalOnChain(7)).toEqual({ status: "unavailable" });

    rpcState.simulate = () => ({ result: {} });
    expect(await getProposalOnChain(7)).toEqual({ status: "unavailable" });
  });
});

describe("getProposalQuorumStateOnChain", () => {
  it("simulates get_proposal_quorum_state and returns the contract's figures", async () => {
    rpcState.simulate = () => simulated(quorumScVal());
    const read = await getProposalQuorumStateOnChain(7);

    expect(read).toEqual({
      status: "ok",
      data: {
        votesCast: "700",
        quorumThreshold: "1000",
        quorumMet: false,
        yesVotes: "600",
        noVotes: "100",
        approvalBps: 8_571,
        consensusThreshold: 6_000,
        quorumFractionBps: 7_000,
      },
    });
    const tx = rpcState.simulateCalls[0] as { operations: Array<{ func: sdk.xdr.HostFunction }> };
    expect(tx.operations[0].func.invokeContract().functionName().toString()).toBe(
      "get_proposal_quorum_state",
    );
  });

  it("reports not-configured, not-found and unavailable like the proposal read", async () => {
    rpcState.simulate = () => simulated(xdr.ScVal.scvVoid());
    expect(await getProposalQuorumStateOnChain(7)).toEqual({ status: "not-found" });

    rpcState.simulate = () => simulated(struct({ votes_cast: i128(1) }));
    expect(await getProposalQuorumStateOnChain(7)).toEqual({ status: "unavailable" });

    vi.stubEnv("NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT", "");
    expect(await getProposalQuorumStateOnChain(7)).toEqual({ status: "not-configured" });
  });
});

describe("getProposalVotesOnChain", () => {
  it("is not-configured without a contract", async () => {
    vi.stubEnv("NEXT_PUBLIC_TALOS_GOVERNANCE_CONTRACT", "");
    expect(await getProposalVotesOnChain(7)).toEqual({ status: "not-configured" });
    expect(rpcState.eventCalls).toHaveLength(0);
  });

  it("filters on the contract and the topics [vote, proposal id], starting a week back", async () => {
    rpcState.getEvents = () => eventsResponse([]);
    await getProposalVotesOnChain(7);

    expect(rpcState.latestCalls).toBe(1);
    const request = rpcState.eventCalls[0] as {
      startLedger: number;
      limit: number;
      filters: Array<{ type: string; contractIds: string[]; topics: string[][] }>;
    };
    expect(request.startLedger).toBe(200_000 - 120_960);
    expect(request.limit).toBe(VOTES_PAGE_SIZE);
    expect(request.filters).toHaveLength(1);
    expect(request.filters[0].type).toBe("contract");
    expect(request.filters[0].contractIds).toEqual([CONTRACT]);
    expect(request.filters[0].topics).toEqual([
      [sym("vote").toXDR("base64"), u32(7).toXDR("base64")],
    ]);
  });

  it("decodes votes in the order the RPC returned them and skips events it cannot read", async () => {
    rpcState.getEvents = () =>
      eventsResponse([
        voteEvent(VOTER_A, "Approve", 400, 1_200, TX_A),
        { ...voteEvent(VOTER_A, "Approve", 1, 1_201), value: struct({ choice: variant("Maybe") }) },
        voteEvent(VOTER_B, "Reject", 100, 1_300, "b".repeat(64)),
      ]);
    const read = await getProposalVotesOnChain(7);

    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.data.votes.map((v) => [v.voter, v.choice, v.weight, v.ledger])).toEqual([
        [VOTER_A, "Approve", "400", 1_200],
        [VOTER_B, "Reject", "100", 1_300],
      ]);
      expect(read.data.oldestLedger).toBe(100_000);
      expect(read.data.latestLedger).toBe(200_000);
      expect(read.data.nextCursor).toBeNull();
    }
  });

  it("offers a next cursor only when the page is full, and uses it without a start ledger", async () => {
    const full = Array.from({ length: 2 }, (_, i) => voteEvent(VOTER_A, "Approve", 1, 1_200 + i));
    rpcState.getEvents = () => eventsResponse(full, { cursor: "next-cursor-1" });
    const first = await getProposalVotesOnChain(7, { limit: 2 });
    expect(first.status === "ok" && first.data.nextCursor).toBe("next-cursor-1");

    rpcState.getEvents = () => eventsResponse([full[0]], { cursor: "next-cursor-2" });
    rpcState.eventCalls = [];
    rpcState.latestCalls = 0;
    const second = await getProposalVotesOnChain(7, { cursor: "next-cursor-1", limit: 2 });
    expect(second.status === "ok" && second.data.nextCursor).toBeNull();

    expect(rpcState.latestCalls).toBe(0);
    const request = rpcState.eventCalls[0];
    expect(request.cursor).toBe("next-cursor-1");
    expect(request).not.toHaveProperty("startLedger");
  });

  it("clamps the page size to 1 to 100", async () => {
    rpcState.getEvents = () => eventsResponse([]);
    await getProposalVotesOnChain(7, { limit: 100_000 });
    await getProposalVotesOnChain(7, { limit: 0 });
    await getProposalVotesOnChain(7, { limit: -5 });
    expect(rpcState.eventCalls.map((c) => c.limit)).toEqual([100, VOTES_PAGE_SIZE, 1]);
  });

  it("retries from the oldest ledger when the RPC rejects the guessed start", async () => {
    let calls = 0;
    rpcState.getEvents = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("startLedger must be within the ledger range: 150000 - 200000");
      }
      return eventsResponse([voteEvent(VOTER_A, "Approve", 5, 150_001)]);
    };
    const read = await getProposalVotesOnChain(7);

    expect(read.status === "ok" && read.data.votes).toHaveLength(1);
    expect(rpcState.eventCalls.map((c) => c.startLedger)).toEqual([200_000 - 120_960, 150_000]);
  });

  it("is unavailable for any other failure, including a failed retry", async () => {
    rpcState.getEvents = () => {
      throw new Error("503 Service Unavailable");
    };
    expect(await getProposalVotesOnChain(7)).toEqual({ status: "unavailable" });

    rpcState.getEvents = () => {
      throw new Error("ledger range: 150000 - 200000");
    };
    expect(await getProposalVotesOnChain(7)).toEqual({ status: "unavailable" });
  });

  it("never starts below ledger 1", async () => {
    rpcState.latestLedger = 50;
    rpcState.getEvents = () => eventsResponse([]);
    await getProposalVotesOnChain(7);
    expect(rpcState.eventCalls[0].startLedger).toBe(1);
  });
});

describe("explorerTxUrl", () => {
  it("links a valid hash on the testnet explorer, lower-cased", () => {
    expect(explorerTxUrl("A".repeat(64))).toBe(
      `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`,
    );
  });

  it("returns null for anything that is not a 64-character hex hash", () => {
    expect(explorerTxUrl(null)).toBeNull();
    expect(explorerTxUrl(undefined)).toBeNull();
    expect(explorerTxUrl("")).toBeNull();
    expect(explorerTxUrl("abc")).toBeNull();
    expect(explorerTxUrl("g".repeat(64))).toBeNull();
    expect(explorerTxUrl(`${"a".repeat(64)}/../x`)).toBeNull();
    expect(explorerTxUrl("javascript:alert(1)")).toBeNull();
  });

  it("uses the public explorer on mainnet", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "mainnet");
    const mainnet = await import("../src/lib/soroban");
    expect(mainnet.explorerTxUrl("a".repeat(64))).toBe(
      `https://stellar.expert/explorer/public/tx/${"a".repeat(64)}`,
    );
  });
});
