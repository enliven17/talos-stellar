import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tlsApprovals, tlsTalos } from "@/db/schema";
import type { VotesSection } from "@/components/proposals/vote-list";
import {
  buildTimeline,
  viewFromChain,
  viewFromDatabase,
  type ProposalRoute,
  type ProposalView,
  type TimelineStep,
} from "@/lib/proposal-detail";
import {
  getProposalOnChain,
  getProposalQuorumStateOnChain,
  getProposalVotesOnChain,
} from "@/lib/soroban";

/** What `/proposals/[id]` renders. The page turns `not-found` into a 404. */
export type ProposalPageData =
  | { kind: "not-found" }
  | { kind: "notice"; title: string; message: string }
  | {
      kind: "ready";
      view: ProposalView;
      timeline: TimelineStep[];
      votes: VotesSection;
      notices: string[];
    };

/**
 * The RPC's event cursor, which is opaque. Only its shape is checked (ledger and
 * event numbers, as the RPC writes them), so a mangled `?cursor=` is ignored and
 * the first page shown instead of a request being sent with junk.
 */
export function sanitizeCursor(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[0-9A-Za-z_-]{1,200}$/.test(value) ? value : undefined;
}

export async function loadProposalPage(
  route: ProposalRoute,
  cursor?: string,
): Promise<ProposalPageData> {
  return route.kind === "database"
    ? loadDatabaseProposal(route.id)
    : loadOnChainProposal(route.proposalId, cursor);
}

async function loadDatabaseProposal(id: string): Promise<ProposalPageData> {
  const [row] = await db
    .select({
      id: tlsApprovals.id,
      talosId: tlsApprovals.talosId,
      talosName: tlsTalos.name,
      type: tlsApprovals.type,
      title: tlsApprovals.title,
      description: tlsApprovals.description,
      amount: tlsApprovals.amount,
      status: tlsApprovals.status,
      decidedBy: tlsApprovals.decidedBy,
      decidedAt: tlsApprovals.decidedAt,
      txHash: tlsApprovals.txHash,
      createdAt: tlsApprovals.createdAt,
    })
    .from(tlsApprovals)
    .innerJoin(tlsTalos, eq(tlsApprovals.talosId, tlsTalos.id))
    .where(eq(tlsApprovals.id, id))
    .limit(1);

  if (!row) return { kind: "not-found" };

  const view = viewFromDatabase(row);
  return {
    kind: "ready",
    view,
    timeline: buildTimeline(view),
    votes: { kind: "not-applicable" },
    notices: [],
  };
}

/** The agent an on-chain proposal belongs to, by its registry id. A database failure only costs the name. */
async function lookupAgent(onChainTalosId: number): Promise<{ name: string; id: string | null }> {
  try {
    const [agent] = await db
      .select({ id: tlsTalos.id, name: tlsTalos.name })
      .from(tlsTalos)
      .where(eq(tlsTalos.onChainId, onChainTalosId))
      .limit(1);
    if (agent) return { name: agent.name, id: agent.id };
  } catch {
    // The proposal is still shown; only the agent's name falls back.
  }
  return { name: `Agent #${onChainTalosId}`, id: null };
}

async function loadOnChainProposal(
  proposalId: number,
  cursor: string | undefined,
): Promise<ProposalPageData> {
  const proposalRead = await getProposalOnChain(proposalId);

  if (proposalRead.status === "not-found") return { kind: "not-found" };
  if (proposalRead.status === "not-configured") {
    return {
      kind: "notice",
      title: "On-chain proposals are not set up here",
      message:
        "This deployment has no governance contract configured, so on-chain proposals cannot be shown.",
    };
  }
  if (proposalRead.status === "unavailable") {
    return {
      kind: "notice",
      title: "Could not read this proposal",
      message:
        "The network did not answer, or sent something unexpected. Reload the page to try again.",
    };
  }

  const proposal = proposalRead.data;
  const [quorumRead, votesRead, agent] = await Promise.all([
    getProposalQuorumStateOnChain(proposalId),
    getProposalVotesOnChain(proposalId, { cursor }),
    lookupAgent(proposal.talosId),
  ]);

  const notices: string[] = [];
  const quorum = quorumRead.status === "ok" ? quorumRead.data : null;
  if (!quorum) notices.push("Quorum details could not be read from the network right now.");

  const view = viewFromChain(proposal, quorum, agent);

  let votes: VotesSection = { kind: "unavailable" };
  let latestLedger: number | null = null;
  if (votesRead.status === "ok") {
    const page = votesRead.data;
    latestLedger = page.latestLedger;
    const base = `/proposals/${proposalId}`;
    votes = {
      kind: "ok",
      votes: page.votes,
      nextHref: page.nextCursor ? `${base}?cursor=${encodeURIComponent(page.nextCursor)}` : null,
      firstHref: cursor ? base : null,
      incomplete: proposal.startLedger < page.oldestLedger,
    };
  }

  return {
    kind: "ready",
    view,
    timeline: buildTimeline(view, latestLedger),
    votes,
    notices,
  };
}
