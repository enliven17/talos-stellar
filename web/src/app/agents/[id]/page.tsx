import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { TalosDetailClient } from "./detail-client";

export default async function TalosDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Run both DB queries in parallel
  const [talos, [jobStatsRow]] = await Promise.all([
    db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.id, id),
      with: {
        patrons: true,
        activities: { orderBy: (a, { desc }) => [desc(a.createdAt)], limit: 20 },
        approvals: { orderBy: (a, { desc }) => [desc(a.createdAt)], limit: 10 },
        revenues: { orderBy: (r, { desc }) => [desc(r.createdAt)], limit: 20 },
        commerceServices: true,
        commerceJobs: { orderBy: (j, { desc: d }) => [d(j.createdAt)], limit: 10 },
      },
    }),
    db
      .select({
        total: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} = 'completed')::int`,
        failed: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} = 'failed')::int`,
        pending: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} = 'pending')::int`,
        totalRevenue: sql<number>`coalesce(sum(${tlsCommerceJobs.amount}::numeric) filter (where ${tlsCommerceJobs.status} = 'completed'), 0)::float`,
        jobsToday: sql<number>`count(*) filter (where ${tlsCommerceJobs.createdAt} >= ${todayStart})::int`,
      })
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.talosId, id)),
  ]);

  if (!talos) notFound();

  const totalRevenue = talos.revenues.reduce(
    (sum, r) => sum + Number(r.amount),
    0
  );

  // Aggregate revenue by month
  const revenueByMonth = new Map<string, number>();
  for (const r of talos.revenues) {
    const d = new Date(r.createdAt);
    const key = `${d.toLocaleString("en-US", { month: "short" })} ${String(d.getFullYear()).slice(-2)}`;
    revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + Number(r.amount));
  }
  const revenueHistory = Array.from(revenueByMonth.entries())
    .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }))
    .slice(-6);

  // Agent activity stats (today)
  const todayActivities = talos.activities.filter(
    (a) => new Date(a.createdAt) >= todayStart
  );
  const agentStats = {
    postsToday: todayActivities.filter((a) => a.type === "post").length,
    repliesToday: todayActivities.filter((a) => a.type === "reply").length,
    researchesToday: todayActivities.filter((a) => a.type === "research").length,
  };

  const successRate = jobStatsRow.total > 0
    ? Math.round((jobStatsRow.completed / jobStatsRow.total) * 100)
    : null;

  // Serialize for client
  const data = {
    id: talos.id,
    name: talos.name,
    agentName: talos.agentName,
    category: talos.category,
    description: talos.description,
    status: talos.status,
    stellarAssetCode: talos.stellarAssetCode ?? "",
    tokenSymbol: talos.tokenSymbol ?? "PULSE",
    pulsePrice: `$${Number(talos.pulsePrice).toFixed(2)}`,
    totalSupply: talos.totalSupply,
    creatorPublicKey: talos.creatorPublicKey,
    persona: talos.persona ?? "",
    targetAudience: talos.targetAudience ?? "",
    channels: talos.channels,
    approvalThreshold: Number(talos.approvalThreshold),
    gtmBudget: Number(talos.gtmBudget),
    minPatronPulse: talos.minPatronPulse,
    agentOnline: talos.agentOnline,
    agentLastSeen: talos.agentLastSeen?.toISOString() ?? null,
    agentWalletAddress: talos.agentWalletAddress ?? null,
    createdAt: talos.createdAt.toISOString().split("T")[0],
    revenue: `$${totalRevenue.toLocaleString()}`,
    patronCount: talos.patrons.length,
    patrons: talos.patrons.map((p) => ({
      stellarPublicKey: p.stellarPublicKey,
      role: p.role,
      pulseAmount: p.pulseAmount,
      share: Number(p.share),
      status: p.status,
    })),
    activities: talos.activities.map((a) => ({
      id: a.id,
      type: a.type,
      content: a.content,
      channel: a.channel,
      status: a.status,
      timestamp: getRelativeTime(a.createdAt),
    })),
    revenueHistory,
    agentStats,
    // Commerce
    service: talos.commerceServices
      ? {
          name: talos.commerceServices.serviceName,
          description: talos.commerceServices.description,
          price: Number(talos.commerceServices.price),
          currency: talos.commerceServices.currency,
          stellarPublicKey: talos.commerceServices.stellarPublicKey,
          chains: talos.commerceServices.chains,
        }
      : null,
    jobStats: {
      total: jobStatsRow.total,
      completed: jobStatsRow.completed,
      failed: jobStatsRow.failed,
      pending: jobStatsRow.pending,
      successRate,
      totalRevenue: jobStatsRow.totalRevenue,
      jobsToday: jobStatsRow.jobsToday,
    },
    recentJobs: (talos.commerceJobs ?? []).map((j) => ({
      id: j.id,
      serviceName: j.serviceName,
      status: j.status,
      amount: Number(j.amount),
      createdAt: getRelativeTime(j.createdAt),
    })),
  };

  return <TalosDetailClient talos={data} />;
}

function getRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}
