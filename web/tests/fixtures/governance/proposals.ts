/**
 * Governance fixtures for the proposal detail page tests.
 *
 * `native*` objects have the shape `scValToNative` gives for the contract's
 * `Proposal` and `ProposalQuorumState` structs (unit enum variants as
 * `["Active"]`, i128 as bigint, u32 as number), so the parsers are exercised on
 * what the SDK really hands them. The ones named after a status carry the
 * tallies the contract would hold in that state.
 */
import type {
  OnChainProposal,
  OnChainQuorumState,
  OnChainVote,
} from "../../../src/lib/soroban";
import type { DatabaseProposalRow } from "../../../src/lib/proposal-detail";

export const PROPOSER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
export const VOTER_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
export const VOTER_B = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
export const TX_A = "a".repeat(64);
export const TX_B = "b".repeat(64);

type Status = "Active" | "Approved" | "Rejected" | "Executed";

export function nativeProposal(
  status: Status,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 7,
    talos_id: 3,
    proposer: PROPOSER,
    title: "Fund the Q3 growth experiment",
    description: "Spend 500 USDC on a referral campaign.",
    snapshot_ledger: 1_000,
    start_ledger: 1_010,
    end_ledger: 18_290,
    status: [status],
    yes_votes: BigInt(600),
    no_votes: BigInt(100),
    total_voters: 4,
    created_at: 1_760_000_000,
    ...overrides,
  };
}

export function nativeQuorum(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    votes_cast: BigInt(700),
    quorum_threshold: BigInt(1_000),
    quorum_met: false,
    yes_votes: BigInt(600),
    no_votes: BigInt(100),
    approval_bps: 8_571,
    consensus_threshold: 6_000,
    quorum_fraction_bps: 7_000,
    ...overrides,
  };
}

export const proposals: Record<Status, OnChainProposal> = {
  Active: {
    id: 7,
    talosId: 3,
    proposer: PROPOSER,
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
  },
  Approved: {
    id: 8,
    talosId: 3,
    proposer: PROPOSER,
    title: "Raise the daily post limit",
    description: "Allow ten posts a day.",
    snapshotLedger: 900,
    startLedger: 910,
    endLedger: 18_190,
    status: "Approved",
    yesVotes: "1500",
    noVotes: "200",
    totalVoters: 6,
    createdAt: 1_759_000_000,
  },
  Rejected: {
    id: 9,
    talosId: 3,
    proposer: PROPOSER,
    title: "Pause all outreach",
    description: "",
    snapshotLedger: 800,
    startLedger: 810,
    endLedger: 18_090,
    status: "Rejected",
    yesVotes: "200",
    noVotes: "1300",
    totalVoters: 5,
    createdAt: 1_758_000_000,
  },
  Executed: {
    id: 10,
    talosId: 3,
    proposer: PROPOSER,
    title: "Pay the design contractor",
    description: "One-off payment.",
    snapshotLedger: 700,
    startLedger: 710,
    endLedger: 17_990,
    status: "Executed",
    yesVotes: "2000",
    noVotes: "0",
    totalVoters: 3,
    createdAt: 1_757_000_000,
  },
};

export const quorums: Record<Status, OnChainQuorumState> = {
  Active: {
    votesCast: "700",
    quorumThreshold: "1000",
    quorumMet: false,
    yesVotes: "600",
    noVotes: "100",
    approvalBps: 8_571,
    consensusThreshold: 6_000,
    quorumFractionBps: 7_000,
  },
  Approved: {
    votesCast: "1700",
    quorumThreshold: "1000",
    quorumMet: true,
    yesVotes: "1500",
    noVotes: "200",
    approvalBps: 8_823,
    consensusThreshold: 6_000,
    quorumFractionBps: 10_000,
  },
  Rejected: {
    votesCast: "1500",
    quorumThreshold: "1000",
    quorumMet: true,
    yesVotes: "200",
    noVotes: "1300",
    approvalBps: 1_333,
    consensusThreshold: 6_000,
    quorumFractionBps: 10_000,
  },
  Executed: {
    votesCast: "2000",
    quorumThreshold: "1000",
    quorumMet: true,
    yesVotes: "2000",
    noVotes: "0",
    approvalBps: 10_000,
    consensusThreshold: 6_000,
    quorumFractionBps: 10_000,
  },
};

export const votes: OnChainVote[] = [
  {
    voter: VOTER_A,
    choice: "Approve",
    weight: "400",
    txHash: TX_A,
    ledger: 1_200,
    closedAt: "2026-10-01T10:00:00Z",
  },
  {
    voter: VOTER_B,
    choice: "Reject",
    weight: "100",
    txHash: TX_B,
    ledger: 1_300,
    closedAt: "2026-10-01T12:30:00Z",
  },
];

export const databaseRows: Record<"pending" | "approved" | "rejected", DatabaseProposalRow> = {
  pending: {
    id: "clx9pending0001",
    talosId: "talos-1",
    talosName: "Growth Agent",
    type: "gtm",
    title: "Buy a newsletter slot",
    description: "A one-off sponsored slot.",
    amount: "120.00",
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    txHash: null,
    createdAt: "2026-10-01T09:00:00.000Z",
  },
  approved: {
    id: "clx9approved001",
    talosId: "talos-1",
    talosName: "Growth Agent",
    type: "gtm",
    title: "Run a launch thread",
    description: null,
    amount: "40.00",
    status: "approved",
    decidedBy: VOTER_A,
    decidedAt: "2026-10-02T09:00:00.000Z",
    txHash: TX_A,
    createdAt: "2026-10-01T09:00:00.000Z",
  },
  rejected: {
    id: "clx9rejected001",
    talosId: "talos-1",
    talosName: "Growth Agent",
    type: "spend",
    title: "Rent a billboard",
    description: "Too expensive.",
    amount: "9000.00",
    status: "rejected",
    decidedBy: VOTER_B,
    decidedAt: "2026-10-03T09:00:00.000Z",
    txHash: null,
    createdAt: "2026-10-01T09:00:00.000Z",
  },
};
