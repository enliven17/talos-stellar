'use client';

import Link from 'next/link';

interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

interface AgentsClientProps {
  agents: AgentSummary[];
}

export default function AgentsClient({ agents }: AgentsClientProps) {
  if (agents.length === 0) {
    return <p>No agents found.</p>;
  }

  return (
    <ul className="list-disc pl-5">
      {agents.map((agent) => (
        <li key={agent.id} className="mb-2">
          <Link href={`/api/agents/${agent.id}`} className="text-blue-600 hover:underline">
            {agent.name}
          </Link>
          <span className="ml-2 text-gray-500">- {agent.status}</span>
        </li>
      ))}
    </ul>
  );
}