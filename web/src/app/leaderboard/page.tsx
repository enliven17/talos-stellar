import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { asc } from "drizzle-orm";
import { LeaderboardClient } from "./leaderboard-client";

export default async function LeaderboardPage() {
  const agents = await db.query.tlsTalos.findMany({
    orderBy: asc(tlsTalos.createdAt),
    with: {
      patrons: true,
      revenues: true,
      activities: true,
    },
  });

  // Top TALOS — by revenue
  const topTalos = agents
    .map((c) => {
      const totalRevenue = c.revenues.reduce((sum, r) => sum + Number(r.amount), 0);
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        revenue: totalRevenue,
        marketCap: Number(c.pulsePrice) * c.totalSupply,
        patrons: c.patrons.length,
        pulsePrice: Number(c.pulsePrice),
        activityCount: c.activities.length,
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .map((e, i) => ({
      ...e,
      rank: i + 1,
      revenueStr: `$${e.revenue.toLocaleString()}`,
      marketCapStr: e.marketCap >= 1_000_000
        ? `$${(e.marketCap / 1_000_000).toFixed(1)}M`
        : `$${(e.marketCap / 1000).toFixed(0)}K`,
    }));

  // Top Patrons — by total Pulse across all TALOS agents
  const patronMap = new Map<string, { wallet: string; totalPulse: number; talosCount: number; roles: string[] }>();
  for (const c of agents) {
    for (const p of c.patrons) {
      if (p.status !== "active") continue;
      const existing = patronMap.get(p.stellarPublicKey) ?? { wallet: p.stellarPublicKey, totalPulse: 0, talosCount: 0, roles: [] };
      existing.totalPulse += p.pulseAmount;
      existing.talosCount++;
      if (!existing.roles.includes(p.role)) existing.roles.push(p.role);
      patronMap.set(p.stellarPublicKey, existing);
    }
  }
  const topPatrons = Array.from(patronMap.values())
    .sort((a, b) => b.totalPulse - a.totalPulse)
    .slice(0, 50)
    .map((p, i) => ({
      rank: i + 1,
      wallet: p.wallet,
      totalPulse: p.totalPulse,
      talosCount: p.talosCount,
      roles: p.roles,
    }));

  // Top Agents — by activity count + revenue
  const topAgents = agents
    .filter((c) => c.status === "Active")
    .map((c) => {
      const totalRevenue = c.revenues.reduce((sum, r) => sum + Number(r.amount), 0);
      const posts = c.activities.filter((a) => a.type === "post").length;
      const replies = c.activities.filter((a) => a.type === "reply").length;
      const commerce = c.activities.filter((a) => a.type === "commerce").length;
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        activityCount: c.activities.length,
        posts,
        replies,
        commerce,
        revenue: totalRevenue,
        online: c.agentOnline,
      };
    })
    .sort((a, b) => b.activityCount - a.activityCount)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  // Trending — new patrons & revenue in last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const trending = agents
    .map((c) => {
      const recentRevenue = c.revenues
        .filter((r) => new Date(r.createdAt) >= sevenDaysAgo)
        .reduce((sum, r) => sum + Number(r.amount), 0);
      const recentPatrons = c.patrons.filter((p) => new Date(p.createdAt) >= sevenDaysAgo).length;
      const recentActivity = c.activities.filter((a) => new Date(a.createdAt) >= sevenDaysAgo).length;
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        recentRevenue,
        recentPatrons,
        recentActivity,
        pulsePrice: Number(c.pulsePrice),
        score: recentRevenue * 10 + recentPatrons * 5 + recentActivity,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return (
    <LeaderboardClient
      topTalos={topTalos}
      topPatrons={topPatrons}
      topAgents={topAgents}
      trending={trending}
    />
  );
}
