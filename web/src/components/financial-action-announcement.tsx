"use client";

import { useCallback, useRef, useState } from "react";

export type FinancialActionOutcome = "submitted" | "confirmed" | "failed";

export interface FinancialActionAnnouncement {
  /** Stable identifier for one action attempt, such as a transaction hash or job ID. */
  actionId: string;
  /** Short, human-readable name of the financial action. */
  label: string;
  /** Latest outcome to announce. */
  outcome: FinancialActionOutcome;
}

/**
 * Keeps a polite live-region message for an asynchronous financial action.
 * Repeated polling results and regressions after a terminal outcome are ignored.
 */
export function useFinancialActionAnnouncement() {
  const [announcement, setAnnouncement] =
    useState<FinancialActionAnnouncement | null>(null);
  const outcomesByAction = useRef(new Map<string, FinancialActionOutcome>());

  const announce = useCallback(
    (next: FinancialActionAnnouncement) => {
      const previous = outcomesByAction.current.get(next.actionId);
      if (
        previous === next.outcome ||
        previous === "confirmed" ||
        previous === "failed"
      ) {
        return false;
      }

      outcomesByAction.current.set(next.actionId, next.outcome);
      setAnnouncement(next);
      return true;
    },
    [],
  );

  return { announcement, announce };
}

export function FinancialActionAnnouncementRegion({
  announcement,
}: {
  /** Latest event from `useFinancialActionAnnouncement`. */
  announcement: FinancialActionAnnouncement | null;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="financial-action-announcement"
      className="sr-only"
    >
      {announcement ? (
        <span key={`${announcement.actionId}:${announcement.outcome}`}>
          {announcement.label} {announcement.outcome}.
        </span>
      ) : null}
    </div>
  );
}
