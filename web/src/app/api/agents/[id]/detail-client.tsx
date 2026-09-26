'use client';

import { AgentDetail } from '@/lib/db/agents';

interface AgentDetailClientProps {
  agent: AgentDetail;
}

export default function AgentDetailClient({ agent }: AgentDetailClientProps) {
  return (
    <div className="agent-detail">
      <h2 className="text-2xl font-bold">{agent.name}</h2>
      <div className="mt-2">
        <span className="font-semibold">Status:</span> {agent.status}
      </div>
      <div className="mt-2">
        <span className="font-semibold">Description:</span>
        <p className="mt-1">{agent.description}</p>
      </div>
      <div className="mt-4 text-sm text-gray-500">
        Last updated: {new Date(agent.updatedAt).toLocaleString()}
      </div>
    </div>
  );
}