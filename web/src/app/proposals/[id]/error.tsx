"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AgentErrorState, toPrivacySafeAgentError } from "@/components/agent-view-states";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ProposalDetailError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[proposal-detail-error]", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <Link
        href="/proposals"
        className="text-sm text-muted hover:text-accent transition-colors inline-block mb-8"
      >
        &larr; Back to proposals
      </Link>
      <AgentErrorState
        message={toPrivacySafeAgentError(error, "Something went wrong loading this proposal.")}
        onRetry={reset}
      />
    </div>
  );
}
