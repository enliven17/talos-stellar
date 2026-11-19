import { formatWeight, type QuorumView } from "@/lib/proposal-detail";

interface BarProps {
  /** Unique within the page; names the label the bar is described by. */
  id: string;
  label: string;
  /** Filled share, 0 to 100. */
  percent: number;
  /** What a screen reader announces instead of the bare percentage. */
  valueText: string;
  /** Where on the track the proposal has to get to, 0 to 100, if there is a line to cross. */
  threshold?: number;
  /** Plain-words state shown beside the bar so it is never conveyed by colour alone. */
  status: string;
  met: boolean;
  children?: React.ReactNode;
}

function Bar({ id, label, percent, valueText, threshold, status, met, children }: BarProps) {
  const labelId = `${id}-label`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <h3 id={labelId} className="text-sm font-bold text-foreground">
          {label}
        </h3>
        <span className={`text-xs font-bold ${met ? "text-green-400" : "text-yellow-400"}`}>
          {status}
        </span>
      </div>
      <div
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="relative h-2 bg-border"
      >
        <div
          className={`h-full ${met ? "bg-green-400" : "bg-accent"}`}
          style={{ width: `${percent}%` }}
        />
        {threshold !== undefined && (
          <div
            aria-hidden="true"
            className="absolute -top-1 -bottom-1 w-0.5 bg-foreground"
            style={{ left: `${threshold}%` }}
          />
        )}
      </div>
      <p className="text-xs text-muted mt-2">{children}</p>
    </div>
  );
}

/**
 * The contract's quorum state as two bars: how close the vote is to quorum, and
 * where the approval share stands against the share needed to pass. The figures
 * come from `get_proposal_quorum_state` as it returned them.
 */
export function QuorumProgress({ quorum }: { quorum: QuorumView }) {
  const approvalStatus = quorum.consensusMet
    ? "Consensus reached"
    : BigInt(quorum.votesCast) === BigInt(0)
      ? "No votes yet"
      : "Below the approval needed";

  return (
    <div className="space-y-6">
      <Bar
        id="quorum"
        label="Quorum"
        percent={quorum.quorumPercent}
        valueText={`${formatWeight(quorum.votesCast)} of ${formatWeight(quorum.quorumThreshold)} voting weight cast, ${quorum.quorumPercent}% of quorum`}
        status={quorum.quorumMet ? "Quorum reached" : "Quorum not reached"}
        met={quorum.quorumMet}
      >
        {formatWeight(quorum.votesCast)} of {formatWeight(quorum.quorumThreshold)} voting weight
        cast ({quorum.quorumPercent}%)
      </Bar>
      <Bar
        id="consensus"
        label="Approval"
        percent={quorum.approvalPercent}
        threshold={quorum.consensusPercent}
        valueText={`${quorum.approvalPercent}% of the weight cast approves; ${quorum.consensusPercent}% is needed to pass`}
        status={approvalStatus}
        met={quorum.consensusMet}
      >
        {quorum.approvalPercent}% approve; {quorum.consensusPercent}% needed to pass (the line on
        the bar)
      </Bar>
      <dl className="grid grid-cols-3 gap-4 text-xs">
        <div>
          <dt className="text-muted">Approve weight</dt>
          <dd className="text-green-400 font-bold">{formatWeight(quorum.yesVotes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Reject weight</dt>
          <dd className="text-red-400 font-bold">{formatWeight(quorum.noVotes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Voters</dt>
          <dd className="text-foreground font-bold">
            {quorum.totalVoters === null ? "Unknown" : quorum.totalVoters.toLocaleString("en-US")}
          </dd>
        </div>
      </dl>
    </div>
  );
}
