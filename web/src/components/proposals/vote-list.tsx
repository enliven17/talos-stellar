import Link from "next/link";
import { explorerTxUrl, type OnChainVote } from "@/lib/soroban";
import { formatTimestamp, formatWeight, shortAddress } from "@/lib/proposal-detail";

export type VotesSection =
  /** Database proposals have a single decision, not a vote list. */
  | { kind: "not-applicable" }
  | { kind: "unavailable" }
  | {
      kind: "ok";
      votes: OnChainVote[];
      nextHref: string | null;
      firstHref: string | null;
      /** Votes cast before the RPC's retention window are not in the list. */
      incomplete: boolean;
    };

/** One page of votes, oldest first, with links to the next page and back to the first. */
export function VoteList({ section }: { section: VotesSection }) {
  if (section.kind === "not-applicable") {
    return (
      <p className="text-sm text-muted">
        This proposal is decided by a single patron decision, so there is no vote list. Votes
        appear here for proposals voted on in the governance contract.
      </p>
    );
  }

  if (section.kind === "unavailable") {
    return (
      <p role="status" className="text-sm text-muted">
        The vote list could not be read from the network right now. The tallies above come from
        the contract and are not affected. Reload the page to try again.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {section.votes.length === 0 ? (
        <p className="text-sm text-muted">No votes to show{section.firstHref ? " on this page" : " yet"}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <caption className="sr-only">Votes on this proposal, oldest first</caption>
            <thead>
              <tr className="text-muted border-b border-border">
                <th scope="col" className="py-2 pr-4 font-normal">Voter</th>
                <th scope="col" className="py-2 pr-4 font-normal">Vote</th>
                <th scope="col" className="py-2 pr-4 font-normal text-right">Weight</th>
                <th scope="col" className="py-2 pr-4 font-normal">When</th>
                <th scope="col" className="py-2 font-normal">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {section.votes.map((vote) => {
                const txUrl = explorerTxUrl(vote.txHash);
                return (
                  <tr key={`${vote.txHash}-${vote.voter}`} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-mono text-foreground" title={vote.voter}>
                      {shortAddress(vote.voter)}
                    </td>
                    <td
                      className={`py-2 pr-4 font-bold ${vote.choice === "Approve" ? "text-green-400" : "text-red-400"}`}
                    >
                      {vote.choice}
                    </td>
                    <td className="py-2 pr-4 text-right text-foreground">{formatWeight(vote.weight)}</td>
                    <td className="py-2 pr-4 text-muted">
                      <time dateTime={vote.closedAt}>{formatTimestamp(vote.closedAt)}</time>
                    </td>
                    <td className="py-2">
                      {txUrl ? (
                        <a
                          href={txUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`View transaction ${vote.txHash.slice(0, 8)} on Stellar Expert (opens in a new tab)`}
                          className="font-mono text-accent hover:underline"
                        >
                          {vote.txHash.slice(0, 8)}...
                        </a>
                      ) : (
                        <span className="font-mono text-muted">{vote.txHash.slice(0, 8)}...</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {section.incomplete && (
        <p className="text-xs text-muted">
          The network only keeps recent events, so votes cast earlier than that are not listed. The
          tallies above include every vote.
        </p>
      )}

      {(section.firstHref || section.nextHref) && (
        <nav aria-label="Vote pages" className="flex gap-4 text-xs">
          {section.firstHref && (
            <Link href={section.firstHref} className="text-accent hover:underline">
              First page
            </Link>
          )}
          {section.nextHref && (
            <Link href={section.nextHref} className="text-accent hover:underline">
              Next page
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
