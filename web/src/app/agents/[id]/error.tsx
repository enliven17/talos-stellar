"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AgentErrorState, toPrivacySafeAgentError } from "@/components/agent-view-states";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AgentDetailError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[agent-detail-error]", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <Link
        href="/agents"
        className="text-sm text-muted hover:text-accent transition-colors inline-block mb-8"
      >
        &larr; Back to agents
      </Link>
      <AgentErrorState
        message={toPrivacySafeAgentError(
          error,
          "Something went wrong loading this agent.",
        )}
        onRetry={reset}
      />
    </div>
  );
}
