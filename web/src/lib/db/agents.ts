import { eq } from 'drizzle-orm';
import { db } from './client'; // Assuming a standard drizzle client export
import { agents } from './schema'; // Assuming schema definition

export interface AgentDetail {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  // Exclude sensitive fields like secrets, seeds, payment proofs
}

export async function getAgentById(id: string): Promise<AgentDetail | null> {
  try {
    const result = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const agent = result[0];
    // Map to safe interface, excluding sensitive internal fields
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      status: agent.status || 'unknown',
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  } catch (error) {
    // Log error internally but do not expose details to client
    console.error('Failed to fetch agent details:', error);
    return null;
  }
}