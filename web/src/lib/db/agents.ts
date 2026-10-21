import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tlsTalos } from '@/db/schema';

export interface AgentDetail {
  id: string;
  name: string;
  description: string;
  status: string;
  category: string;
  agentName: string | null;
  onChainId: number | null;
  stellarAssetCode: string | null;
  tokenSymbol: string | null;
  pulsePrice: string;
  totalSupply: number;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
  persona: string | null;
  targetAudience: string | null;
  channels: string[];
  toneVoice: string | null;
  approvalThreshold: string;
  gtmBudget: string;
  minPatronPulse: number | null;
  agentOnline: boolean;
  agentLastSeen: Date | null;
  retiredAt: Date | null;
  retiredReason: string | null;
  supersededBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const publicAgentFields = {
  id: tlsTalos.id,
  name: tlsTalos.name,
  description: tlsTalos.description,
  status: tlsTalos.status,
  category: tlsTalos.category,
  agentName: tlsTalos.agentName,
  onChainId: tlsTalos.onChainId,
  stellarAssetCode: tlsTalos.stellarAssetCode,
  tokenSymbol: tlsTalos.tokenSymbol,
  pulsePrice: tlsTalos.pulsePrice,
  totalSupply: tlsTalos.totalSupply,
  creatorShare: tlsTalos.creatorShare,
  investorShare: tlsTalos.investorShare,
  treasuryShare: tlsTalos.treasuryShare,
  persona: tlsTalos.persona,
  targetAudience: tlsTalos.targetAudience,
  channels: tlsTalos.channels,
  toneVoice: tlsTalos.toneVoice,
  approvalThreshold: tlsTalos.approvalThreshold,
  gtmBudget: tlsTalos.gtmBudget,
  minPatronPulse: tlsTalos.minPatronPulse,
  agentOnline: tlsTalos.agentOnline,
  agentLastSeen: tlsTalos.agentLastSeen,
  retiredAt: tlsTalos.retiredAt,
  retiredReason: tlsTalos.retiredReason,
  supersededBy: tlsTalos.supersededBy,
  createdAt: tlsTalos.createdAt,
  updatedAt: tlsTalos.updatedAt,
};

export async function getAgentById(id: string): Promise<AgentDetail | null> {
  try {
    const result = await db
      .select(publicAgentFields)
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    return result[0];
  } catch (error) {
    console.error('Failed to fetch agent details:', error);
    return null;
  }
}