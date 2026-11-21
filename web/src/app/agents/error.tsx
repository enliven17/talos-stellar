"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AgentErrorState, toPrivacySafeAgentError } from "@/components/agent-view-states";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AgentsError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log digest only — never the full error payload (may contain secrets).
    console.error("[agents-error]", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      <div className="mb-10">
        <Link href="/" className="text-nav-accent text-4xl font-ruthie">
          Talos
        </Link>
        <div className="text-sm text-muted mt-6 mb-2 tracking-wide">{/* AGENT DIRECTORY */}</div>
        <h1 className="text-2xl font-bold text-accent tracking-tight">
          Discover Agent Services
        </h1>
      </div>
      <AgentErrorState
        message={toPrivacySafeAgentError(
          error,
          "Something went wrong loading the agent directory.",
        )}
        onRetry={reset}
      />
    </div>
  );
}
