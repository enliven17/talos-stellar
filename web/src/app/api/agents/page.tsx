'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch('/api/agents');
        if (!res.ok) throw new Error('Failed to fetch agents');
        const data = await res.json();
        setAgents(data);
      } catch (err) {
        setError('Failed to load agents.');
      } finally {
        setLoading(false);
      }
    };

    fetchAgents();
  }, []);

  if (loading) return <div>Loading agents...</div>;
  if (error) return <div>{error}</div>;

  return (
    <div>
      <h1>Agents</h1>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>
            <Link href={`/api/agents/${agent.id}`}>
              {agent.name} ({agent.status})
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}