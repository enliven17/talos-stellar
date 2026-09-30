'use client';

import { useEffect, useState } from 'react';
import { AgentDetail } from '@/lib/db/agents';

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchAgent = async () => {
      try {
        const res = await fetch(`/api/agents/${params.id}`);
        if (!res.ok) {
          if (res.status === 304) {
            // Not Modified - data is likely cached or stale in state
            // We can keep existing state or fetch again if needed
            // For simplicity, we assume state is valid if 304
            return;
          }
          throw new Error('Failed to fetch agent');
        }
        const data = await res.json();
        if (isMounted) {
          setAgent(data);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError('An error occurred while loading the agent.');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchAgent();

    return () => {
      isMounted = false;
    };
  }, [params.id]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>{error}</div>;
  if (!agent) return <div>Agent not found</div>;

  return (
    <div>
      <h1>{agent.name}</h1>
      <p>{agent.description}</p>
      <p>Status: {agent.status}</p>
      <p>Updated: {agent.updatedAt.toLocaleString()}</p>
    </div>
  );
}