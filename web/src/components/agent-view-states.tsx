"use client";

import type { ReactNode } from "react";
import {
  emptyCopyFor,
  toPrivacySafeAgentError,
  type AgentViewEmptyKind,
} from "@/lib/agent-view-errors";

export type { AgentViewEmptyKind };
export { emptyCopyFor, toPrivacySafeAgentError };

export interface AgentEmptyStateProps {
  kind?: AgentViewEmptyKind;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  testId?: string;
}

export function AgentEmptyState({
  kind = "generic",
  title,
  description,
  action,
  className = "",
  testId,
}: AgentEmptyStateProps) {
  const copy = emptyCopyFor(kind);
  const heading = title ?? copy.title;
  const body = description ?? copy.description;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId ?? `agent-empty-${kind}`}
      className={`text-center py-16 px-4 ${className}`.trim()}
    >
      <p className="text-sm font-medium text-foreground mb-1">{heading}</p>
      <p className="text-sm text-muted max-w-md mx-auto leading-relaxed">{body}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

export interface AgentErrorStateProps {
  error?: unknown;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  testId?: string;
}

export function AgentErrorState({
  error,
  message,
  onRetry,
  retryLabel = "Try again",
  className = "",
  testId = "agent-error-state",
}: AgentErrorStateProps) {
  const safe = message ?? toPrivacySafeAgentError(error);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid={testId}
      className={`bg-accent/10 border border-accent/20 text-accent p-6 text-center ${className}`.trim()}
    >
      <p className="text-xs tracking-wide mb-2 text-muted">{/* ERROR */}</p>
      <p className="text-sm font-medium mb-1">Unable to load agent view</p>
      <p className="text-sm text-muted mb-6 max-w-md mx-auto leading-relaxed">{safe}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid="agent-error-retry"
          className="border border-accent text-accent px-4 py-2 text-sm hover:bg-accent hover:text-background transition-colors"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
