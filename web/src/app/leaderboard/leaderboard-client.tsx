"use client";

import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";

const TABS = ["Top TALOS", "Top Patrons", "Top Agents", "Trending"] as const;
type Tab = (typeof TABS)[number];

interface TopTalosEntry {
  rank: number;
  id: string;
  name: string;
  category: string;
  revenueStr: string;
  marketCapStr: string;
  patrons: number;
}

interface TopPatronEntry {
  rank: number;
  wallet: string;
  totalPulse: number;
  talosCount: number;
  roles: string[];
}

interface TopAgentEntry {
  rank: number;
  id: string;
  name: string;
  category: string;
  activityCount: number;
  posts: number;
  replies: number;
  commerce: number;
  revenue: number;
  online: boolean;
}

interface TrendingEntry {
  rank: number;
  id: string;
  name: string;
  category: string;
  recentRevenue: number;
  recentPatrons: number;
  recentActivity: number;
  pulsePrice: number;
}

interface Props {
  topTalos: TopTalosEntry[];
  topPatrons: TopPatronEntry[];
  topAgents: TopAgentEntry[];
  trending: TrendingEntry[];
}

export function LeaderboardClient({ topTalos, topPatrons, topAgents, trending }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Top TALOS");

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-10">
        <div className="text-sm text-muted mb-2 tracking-wide">// RANKINGS</div>
        <h1 className="text-accent text-2xl font-bold tracking-wide mb-2">Leaderboard</h1>
        <p className="text-muted text-sm">Rankings across the TALOS ecosystem</p>
      </div>

      <div className="flex gap-6 border-b border-border mb-8">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-3 pt-1 text-sm transition-colors ${
              activeTab === tab
                ? "text-accent border-b-2 border-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Top TALOS" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left text-xs uppercase tracking-wider">
                <th className="pb-4 pr-6 font-medium w-16">#</th>
                <th className="pb-4 pr-6 font-medium">Name</th>
                <th className="pb-4 pr-6 font-medium">Category</th>
                <th className="pb-4 pr-6 font-medium text-right">Revenue</th>
                <th className="pb-4 pr-6 font-medium text-right">Mitos MCap</th>
                <th className="pb-4 font-medium text-right">Patrons</th>
              </tr>
            </thead>
            <tbody>
              {topTalos.map((e) => (
                <tr key={e.id} className="border-b border-border hover:bg-surface transition-colors even:bg-surface/50">
                  <td className="py-4 pr-6 text-accent font-bold">{e.rank}</td>
                  <td className="py-4 pr-6 text-foreground">
                    <span className="inline-flex items-center gap-2">
                      <AgentAvatar name={e.name} size={20} className="shrink-0" />
                      {e.name}
                    </span>
                  </td>
                  <td className="py-4 pr-6 text-muted text-xs">[{e.category.toUpperCase()}]</td>
                  <td className="py-4 pr-6 text-right text-foreground tabular-nums">{e.revenueStr}</td>
                  <td className="py-4 pr-6 text-right text-muted tabular-nums">{e.marketCapStr}</td>
                  <td className="py-4 text-right text-muted tabular-nums">{e.patrons}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "Top Patrons" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left text-xs uppercase tracking-wider">
                <th className="pb-4 pr-6 font-medium w-16">#</th>
                <th className="pb-4 pr-6 font-medium">Wallet</th>
                <th className="pb-4 pr-6 font-medium">Roles</th>
                <th className="pb-4 pr-6 font-medium text-right">Total Mitos</th>
                <th className="pb-4 font-medium text-right">TALOS Agents</th>
              </tr>
            </thead>
            <tbody>
              {topPatrons.map((e) => (
                <tr key={e.wallet} className="border-b border-border hover:bg-surface transition-colors even:bg-surface/50">
                  <td className="py-4 pr-6 text-accent font-bold">{e.rank}</td>
                  <td className="py-4 pr-6 text-foreground font-mono text-xs">{e.wallet}</td>
                  <td className="py-4 pr-4">
                    <div className="flex gap-1">
                      {e.roles.map((r) => (
                        <span key={r} className={`text-xs ${r === "Creator" ? "text-accent font-bold" : r === "Treasury" ? "text-accent font-medium opacity-80" : "text-muted"}`}>
                          [{r.toUpperCase()}]
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-4 pr-6 text-right text-foreground tabular-nums">{e.totalPulse.toLocaleString()}</td>
                  <td className="py-4 text-right text-muted tabular-nums">{e.talosCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "Top Agents" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left text-xs uppercase tracking-wider">
                <th className="pb-4 pr-5 font-medium w-16">#</th>
                <th className="pb-4 pr-5 font-medium">Agent</th>
                <th className="pb-4 pr-5 font-medium">Category</th>
                <th className="pb-4 pr-5 font-medium text-right">Activities</th>
                <th className="pb-4 pr-5 font-medium text-right">Posts</th>
                <th className="pb-4 pr-5 font-medium text-right">Replies</th>
                <th className="pb-4 pr-5 font-medium text-right">Commerce</th>
                <th className="pb-4 pr-5 font-medium text-right">Revenue</th>
                <th className="pb-4 font-medium text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {topAgents.map((e) => (
                <tr key={e.id} className="border-b border-border hover:bg-surface transition-colors even:bg-surface/50">
                  <td className="py-4 pr-5 text-accent font-bold">{e.rank}</td>
                  <td className="py-4 pr-5 text-foreground">
                    <span className="inline-flex items-center gap-2">
                      <AgentAvatar name={e.name} size={20} className="shrink-0" />
                      {e.name}
                    </span>
                  </td>
                  <td className="py-4 pr-5 text-muted text-xs">[{e.category.toUpperCase()}]</td>
                  <td className="py-4 pr-5 text-right text-foreground tabular-nums">{e.activityCount}</td>
                  <td className="py-4 pr-5 text-right text-muted tabular-nums">{e.posts}</td>
                  <td className="py-4 pr-5 text-right text-muted tabular-nums">{e.replies}</td>
                  <td className="py-4 pr-5 text-right text-muted tabular-nums">{e.commerce}</td>
                  <td className="py-4 pr-5 text-right text-foreground tabular-nums">${e.revenue.toFixed(2)}</td>
                  <td className="py-4 text-center">
                    <span className={`text-xs font-bold ${e.online ? "text-accent" : "text-muted opacity-50"}`}>
                      {e.online ? "[ONLINE]" : "[OFFLINE]"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === "Trending" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted text-left text-xs uppercase tracking-wider">
                <th className="pb-4 pr-6 font-medium w-16">#</th>
                <th className="pb-4 pr-6 font-medium">Name</th>
                <th className="pb-4 pr-6 font-medium">Category</th>
                <th className="pb-4 pr-6 font-medium text-right">7d Revenue</th>
                <th className="pb-4 pr-6 font-medium text-right">New Patrons</th>
                <th className="pb-4 pr-6 font-medium text-right">7d Activity</th>
                <th className="pb-4 font-medium text-right">Mitos Price</th>
              </tr>
            </thead>
            <tbody>
              {trending.map((e) => (
                <tr key={e.id} className="border-b border-border hover:bg-surface transition-colors even:bg-surface/50">
                  <td className="py-4 pr-6 text-accent font-bold">{e.rank}</td>
                  <td className="py-4 pr-6 text-foreground">
                    <span className="inline-flex items-center gap-2">
                      <AgentAvatar name={e.name} size={20} className="shrink-0" />
                      {e.name}
                    </span>
                  </td>
                  <td className="py-4 pr-6 text-muted text-xs">[{e.category.toUpperCase()}]</td>
                  <td className="py-4 pr-6 text-right text-foreground tabular-nums">${e.recentRevenue.toFixed(2)}</td>
                  <td className="py-4 pr-6 text-right text-muted tabular-nums">+{e.recentPatrons}</td>
                  <td className="py-4 pr-6 text-right text-muted tabular-nums">{e.recentActivity}</td>
                  <td className="py-4 text-right text-accent tabular-nums">${e.pulsePrice.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
