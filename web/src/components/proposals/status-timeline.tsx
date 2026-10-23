import { explorerTxUrl } from "@/lib/soroban";
import { formatTimestamp, type TimelineStep } from "@/lib/proposal-detail";

const STATE_TEXT = {
  done: "Completed",
  current: "In progress",
  upcoming: "Not yet",
} as const;

const MARKER = {
  done: "bg-green-400 border-green-400",
  current: "bg-accent border-accent",
  upcoming: "bg-background border-border",
} as const;

/** The proposal's steps as an ordered list. The step in progress carries `aria-current`. */
export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-5">
      {steps.map((step) => {
        const txUrl = explorerTxUrl(step.txHash);
        const time = formatTimestamp(step.at);
        return (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            className="flex gap-4"
          >
            <span
              aria-hidden="true"
              className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${MARKER[step.state]}`}
            />
            <div className="min-w-0">
              <p className="text-sm font-bold text-foreground">
                {step.label}
                <span className="sr-only">: {STATE_TEXT[step.state]}</span>
              </p>
              {step.detail && <p className="text-xs text-muted mt-0.5">{step.detail}</p>}
              {time && (
                <p className="text-xs text-muted/70 mt-0.5">
                  <time dateTime={step.at ?? undefined}>{time}</time>
                </p>
              )}
              {step.txHash && (
                <p className="text-xs mt-0.5">
                  {txUrl ? (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View transaction ${step.txHash.slice(0, 8)} on Stellar Expert (opens in a new tab)`}
                      className="font-mono text-accent hover:underline"
                    >
                      {step.txHash.slice(0, 8)}...
                    </a>
                  ) : (
                    <span className="font-mono text-muted">{step.txHash.slice(0, 8)}...</span>
                  )}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
