import type {
  OnChainProposal,
  OnChainQuorumState,
} from "@/lib/soroban";

/**
 * The proposal detail page (`/proposals/[id]`) shows two kinds of proposal
 * through one view model:
 *
 * - **Database proposals** are approval requests an agent raised
 *   (`tls_approvals`). They have a string id and a single decision.
 * - **On-chain proposals** live in the TalosGovernance contract. They have a
 *   numeric id, a voting window, a quorum and a tally.
 *
 * Nothing in the database links the two, so the id alone decides which one a
 * URL means: a plain number is an on-chain proposal, anything else is a
 * database id. Database ids are cuid2 strings, which always start with a
 * letter, so the two spaces never collide.
 *
 * Everything in this file is pure so it can be tested without a database or an
 * RPC.
 */

export type ProposalRoute =
  | { kind: "on-chain"; proposalId: number }
  | { kind: "database"; id: string };

const U32_MAX = 0xffff_ffff;

/** Interprets the `[id]` segment of the URL. `null` means it cannot be a proposal id. */
export function parseProposalRoute(raw: string): ProposalRoute | null {
  const id = raw.trim();
  if (!id) return null;

  // Canonical decimal only: "7" is proposal 7, "07" is not an id. A segment of
  // nothing but digits is never a database id, so a malformed number is a 404
  // rather than a lookup that cannot match.
  if (/^\d+$/.test(id)) {
    if (!/^(0|[1-9]\d{0,9})$/.test(id)) return null;
    const proposalId = Number(id);
    return proposalId <= U32_MAX ? { kind: "on-chain", proposalId } : null;
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { kind: "database", id } : null;
}

export type ProposalState = "active" | "approved" | "rejected" | "executed";

export interface DatabaseProposalRow {
  id: string;
  talosId: string;
  talosName: string;
  type: string;
  title: string;
  description: string | null;
  amount: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | string | null;
  txHash: string | null;
  createdAt: Date | string;
}

export interface QuorumView {
  votesCast: string;
  quorumThreshold: string;
  quorumMet: boolean;
  yesVotes: string;
  noVotes: string;
  /** Progress toward quorum, 0 to 100 (two decimals). The contract caps it at 100. */
  quorumPercent: number;
  /** Yes share of the votes cast, 0 to 100. */
  approvalPercent: number;
  /** The approval share needed to pass, 0 to 100. */
  consensusPercent: number;
  /** Quorum is met and the approval share is at or above the threshold. */
  consensusMet: boolean;
  totalVoters: number | null;
}

export interface ProposalView {
  source: "database" | "on-chain";
  id: string;
  title: string;
  description: string | null;
  state: ProposalState;
  /** How the source names the state: "Pending", "Active", "Executed", ... */
  stateLabel: string;
  /** The agent the proposal belongs to, when known. */
  agent: { name: string; id: string | null } | null;
  /** Database proposals: the kind of action and its amount. */
  type: string | null;
  amount: string | null;
  /** On-chain proposals: who proposed it. */
  proposer: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  txHash: string | null;
  voting: { snapshotLedger: number; startLedger: number; endLedger: number } | null;
  quorum: QuorumView | null;
}

const DB_STATE: Record<string, { state: ProposalState; label: string }> = {
  pending: { state: "active", label: "Pending" },
  approved: { state: "approved", label: "Approved" },
  rejected: { state: "rejected", label: "Rejected" },
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A database approval as a proposal view. An unknown status is shown as active, never hidden. */
export function viewFromDatabase(row: DatabaseProposalRow): ProposalView {
  const known = DB_STATE[row.status.toLowerCase()];
  return {
    source: "database",
    id: row.id,
    title: row.title,
    description: row.description,
    state: known?.state ?? "active",
    stateLabel: known?.label ?? row.status,
    agent: { name: row.talosName, id: row.talosId },
    type: row.type,
    amount: row.amount,
    proposer: null,
    createdAt: iso(row.createdAt),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    txHash: row.txHash,
    voting: null,
    quorum: null,
  };
}

function percentFromBps(bps: number): number {
  return Math.min(100, Math.max(0, Math.round(bps) / 100));
}

/** The contract's quorum state as the progress figures the bars show. */
export function quorumViewFromChain(
  state: OnChainQuorumState,
  totalVoters: number | null,
): QuorumView {
  const approvalPercent = percentFromBps(state.approvalBps);
  const consensusPercent = percentFromBps(state.consensusThreshold);
  return {
    votesCast: state.votesCast,
    quorumThreshold: state.quorumThreshold,
    quorumMet: state.quorumMet,
    yesVotes: state.yesVotes,
    noVotes: state.noVotes,
    quorumPercent: percentFromBps(state.quorumFractionBps),
    approvalPercent,
    consensusPercent,
    consensusMet:
      state.quorumMet && BigInt(state.votesCast) > BigInt(0) && state.approvalBps >= state.consensusThreshold,
    totalVoters,
  };
}

const CHAIN_STATE: Record<OnChainProposal["status"], ProposalState> = {
  Active: "active",
  Approved: "approved",
  Rejected: "rejected",
  Executed: "executed",
};

/** An on-chain proposal, optionally with the agent it belongs to (looked up from the database). */
export function viewFromChain(
  proposal: OnChainProposal,
  quorum: OnChainQuorumState | null,
  agent: { name: string; id: string | null } | null,
): ProposalView {
  return {
    source: "on-chain",
    id: String(proposal.id),
    title: proposal.title,
    description: proposal.description || null,
    state: CHAIN_STATE[proposal.status],
    stateLabel: proposal.status,
    agent,
    type: null,
    amount: null,
    proposer: proposal.proposer,
    createdAt: iso(new Date(proposal.createdAt * 1000)),
    decidedAt: null,
    decidedBy: null,
    txHash: null,
    voting: {
      snapshotLedger: proposal.snapshotLedger,
      startLedger: proposal.startLedger,
      endLedger: proposal.endLedger,
    },
    quorum: quorum ? quorumViewFromChain(quorum, proposal.totalVoters) : null,
  };
}

export type TimelineStepState = "done" | "current" | "upcoming";

export interface TimelineStep {
  key: string;
  label: string;
  detail: string;
  state: TimelineStepState;
  /** ISO 8601, when the source records when the step happened. */
  at: string | null;
  /** A transaction the step produced, if any. */
  txHash: string | null;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

/**
 * The proposal's steps in order, each marked done, current or upcoming.
 *
 * `latestLedger` (when the RPC reported one) tells an on-chain proposal whether
 * its voting window is still open; without it, the stored status decides.
 */
export function buildTimeline(view: ProposalView, latestLedger: number | null = null): TimelineStep[] {
  const steps: TimelineStep[] =
    view.source === "database" ? databaseSteps(view) : onChainSteps(view, latestLedger);

  // Exactly one step is "current" while the proposal is still moving.
  if (view.state === "active") {
    const firstOpen = steps.findIndex((s) => s.state !== "done");
    if (firstOpen !== -1) steps[firstOpen] = { ...steps[firstOpen], state: "current" };
  }
  return steps;
}

function databaseSteps(view: ProposalView): TimelineStep[] {
  const decided = view.state !== "active";
  const steps: TimelineStep[] = [
    {
      key: "submitted",
      label: "Submitted",
      detail: view.agent ? `Raised by ${view.agent.name}` : "Raised by an agent",
      state: "done",
      at: view.createdAt,
      txHash: null,
    },
    {
      key: "decision",
      label: decided ? view.stateLabel : "Decision",
      detail: decided
        ? view.decidedBy
          ? `Decided by ${shortAddress(view.decidedBy)}`
          : "Decided"
        : "Waiting for a patron to approve or reject",
      state: decided ? "done" : "upcoming",
      at: decided ? view.decidedAt : null,
      txHash: null,
    },
  ];
  if (view.txHash) {
    steps.push({
      key: "transaction",
      label: "Recorded on Stellar",
      detail: "Transaction",
      state: "done",
      at: null,
      txHash: view.txHash,
    });
  }
  return steps;
}

function onChainSteps(view: ProposalView, latestLedger: number | null): TimelineStep[] {
  const voting = view.voting;
  const closed =
    view.state !== "active" || (voting !== null && latestLedger !== null && latestLedger > voting.endLedger);
  const quorumMet = view.quorum?.quorumMet ?? false;

  const steps: TimelineStep[] = [
    {
      key: "proposed",
      label: "Proposed",
      detail: view.proposer ? `By ${shortAddress(view.proposer)}` : "On-chain",
      state: "done",
      at: view.createdAt,
      txHash: null,
    },
    {
      key: "voting",
      label: closed ? "Voting closed" : "Voting open",
      detail: voting
        ? closed
          ? `Ended at ledger ${voting.endLedger.toLocaleString("en-US")}`
          : `Open until ledger ${voting.endLedger.toLocaleString("en-US")}`
        : "",
      state: closed ? "done" : "upcoming",
      at: null,
      txHash: null,
    },
    {
      key: "quorum",
      label: quorumMet ? "Quorum reached" : "Quorum",
      detail: quorumMet
        ? "Enough voting weight has been cast"
        : closed
          ? "Quorum was not reached"
          : "More voting weight is needed",
      state: quorumMet ? "done" : "upcoming",
      at: null,
      txHash: null,
    },
  ];

  if (view.state === "active") {
    steps.push({
      key: "outcome",
      label: "Outcome",
      detail: "Decided when the voting window closes or consensus is reached",
      state: "upcoming",
      at: null,
      txHash: null,
    });
  } else {
    steps.push({
      key: "outcome",
      label: view.state === "rejected" ? "Rejected" : "Approved",
      detail: view.state === "rejected" ? "The proposal did not pass" : "The proposal passed",
      state: "done",
      at: null,
      txHash: null,
    });
    if (view.state !== "rejected") {
      steps.push({
        key: "execution",
        label: view.state === "executed" ? "Executed" : "Execution",
        detail: view.state === "executed" ? "The proposal was carried out" : "Not executed yet",
        state: view.state === "executed" ? "done" : "upcoming",
        at: null,
        txHash: null,
      });
    }
  }
  return steps;
}

/** Formats an integer amount held as a string (an i128 voting weight) with thousands separators. */
export function formatWeight(value: string): string {
  try {
    return BigInt(value).toLocaleString("en-US");
  } catch {
    return value;
  }
}

/** A UTC timestamp for display, or an empty string when there is none. */
export function formatTimestamp(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  })} UTC`;
}
