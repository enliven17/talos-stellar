import Link from "next/link";
import {
  formatTimestamp,
  shortAddress,
  type ProposalState,
  type ProposalView,
  type TimelineStep,
} from "@/lib/proposal-detail";
import { QuorumProgress } from "./quorum-progress";
import { StatusTimeline } from "./status-timeline";
import { VoteList, type VotesSection } from "./vote-list";

const STATE_STYLE: Record<ProposalState, string> = {
  active: "text-yellow-400",
  approved: "text-green-400",
  rejected: "text-red-400",
  executed: "text-blue-400",
};

interface ProposalDetailProps {
  view: ProposalView;
  timeline: TimelineStep[];
  votes: VotesSection;
  /** Things the page could not read, shown above the sections so they are not mistaken for missing data. */
  notices?: string[];
}

/**
 * Everything a voter needs on one proposal: what it asks, where it stands, how
 * close it is to quorum and consensus, who voted and the transactions behind it.
 */
export function ProposalDetail({ view, timeline, votes, notices = [] }: ProposalDetailProps) {
  return (
    <article aria-labelledby="proposal-title" className="space-y-10">
      <header>
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <span className="border border-border px-2 py-0.5 text-muted">
            {view.source === "on-chain" ? `On-chain proposal #${view.id}` : "Agent approval request"}
          </span>
          {view.agent &&
            (view.agent.id ? (
              <Link
                href={`/agents/${view.agent.id}`}
                className="border border-border px-2 py-0.5 text-muted hover:text-accent transition-colors"
              >
                {view.agent.name}
              </Link>
            ) : (
              <span className="border border-border px-2 py-0.5 text-muted">{view.agent.name}</span>
            ))}
          {view.type && (
            <span className="border border-border px-2 py-0.5 text-muted uppercase">{view.type}</span>
          )}
          <span>
            <span className="text-muted">Status: </span>
            <strong className={STATE_STYLE[view.state]}>{view.stateLabel}</strong>
          </span>
        </div>

        <h1 id="proposal-title" className="text-2xl font-bold text-accent">
          {view.title}
        </h1>

        {view.description && (
          <p className="text-sm text-muted mt-3 leading-relaxed whitespace-pre-wrap">
            {view.description}
          </p>
        )}

        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-xs">
          {view.amount && (
            <div>
              <dt className="text-muted">Amount</dt>
              <dd className="text-accent font-medium">${Number(view.amount).toFixed(2)} USDC</dd>
            </div>
          )}
          {view.proposer && (
            <div>
              <dt className="text-muted">Proposed by</dt>
              <dd className="font-mono text-foreground" title={view.proposer}>
                {shortAddress(view.proposer)}
              </dd>
            </div>
          )}
          {view.createdAt && (
            <div>
              <dt className="text-muted">Created</dt>
              <dd className="text-foreground">
                <time dateTime={view.createdAt}>{formatTimestamp(view.createdAt)}</time>
              </dd>
            </div>
          )}
          {view.voting && (
            <div>
              <dt className="text-muted">Voting window</dt>
              <dd className="text-foreground">
                Ledgers {view.voting.startLedger.toLocaleString("en-US")} to{" "}
                {view.voting.endLedger.toLocaleString("en-US")}
              </dd>
            </div>
          )}
        </dl>

        {notices.map((notice) => (
          <p key={notice} role="status" className="mt-4 text-xs text-muted border border-border px-3 py-2">
            {notice}
          </p>
        ))}
      </header>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-lg font-bold text-foreground mb-4">
          Status timeline
        </h2>
        <StatusTimeline steps={timeline} />
      </section>

      <section aria-labelledby="quorum-heading">
        <h2 id="quorum-heading" className="text-lg font-bold text-foreground mb-4">
          Quorum and consensus
        </h2>
        {view.quorum ? (
          <QuorumProgress quorum={view.quorum} />
        ) : (
          <p className="text-sm text-muted">
            {view.source === "database"
              ? "Quorum and consensus apply to proposals voted on in the governance contract. This proposal is decided by a single patron decision."
              : "Quorum details are not available right now."}
          </p>
        )}
      </section>

      <section aria-labelledby="votes-heading">
        <h2 id="votes-heading" className="text-lg font-bold text-foreground mb-4">
          Votes
        </h2>
        <VoteList section={votes} />
      </section>
    </article>
  );
}
