// Shared types for the agent detail page and its tab components.

export interface ServiceInfo {
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stellarPublicKey: string;
  chains: string[];
}

export interface JobStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  successRate: number | null;
  totalRevenue: number;
  jobsToday: number;
}

export interface RecentJob {
  id: string;
  serviceName: string;
  status: string;
  amount: number;
  createdAt: string;
}

export interface TalosDetail {
  id: string;
  name: string;
  agentName: string | null;
  category: string;
  description: string;
  status: string;
  stellarAssetCode: string;
  tokenSymbol: string;
  pulsePrice: string;
  totalSupply: number;
  creatorPublicKey: string | null;
  agentWalletAddress: string | null;
  persona: string;
  targetAudience: string;
  channels: string[];
  approvalThreshold: number;
  gtmBudget: number;
  minPatronPulse: number | null;
  investorShare: number;
  agentOnline: boolean;
  agentLastSeen: string | null;
  createdAt: string;
  revenue: string;
  patronCount: number;
  patrons: {
    stellarPublicKey: string;
    role: string;
    pulseAmount: number;
    share: number;
    status: string;
  }[];
  activities: {
    id: string;
    type: string;
    content: string;
    channel: string;
    status: string;
    timestamp: string;
  }[];
  revenueHistory: { month: string; amount: number }[];
  agentStats: {
    postsToday: number;
    repliesToday: number;
    researchesToday: number;
  };
  service: ServiceInfo | null;
  jobStats: JobStats;
  recentJobs: RecentJob[];
}

export const TABS = [
  "Overview",
  "Services",
  "Activity",
  "Patrons",
  "Revenue",
  "Governance",
  "Agent",
] as const;

export type Tab = (typeof TABS)[number];

export const TYPE_ICONS: Record<string, string> = {
  post: ">_",
  research: "??",
  reply: "<>",
  commerce: "$$",
  approval: "!!",
};

export const JOB_STATUS_STYLES: Record<string, string> = {
  completed: "text-accent font-bold",
  pending: "text-muted",
  failed: "text-red-600",
};

/** Approval shape returned by /api/talos/:id/approvals */
export interface Approval {
  id: string;
  type: string;
  title: string;
  description: string | null;
  amount: string | null;
  status: string;
  decidedBy: string | null;
  createdAt: string;
}

/** Revenue distribution preview */
export interface DistPreview {
  totalRevenue: number;
  distributableAmount: number;
  investorSharePercent: number;
  breakdown: {
    stellarPublicKey: string;
    pulseAmount: number;
    sharePercent: string;
    estimatedUsdc: string;
  }[];
}

/** Buyback stats preview */
export interface BuybackPreview {
  totalRevenue: number;
  treasuryBalance: number;
  treasurySharePercent: number;
  totalBuybackExecuted: number;
  operatorMitosBalance: number;
  circulatingSupply: number;
}
