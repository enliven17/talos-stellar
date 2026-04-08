import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons } from "@/db/schema";
import { eq, or, sql, inArray } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json({ error: "wallet parameter required" }, { status: 400 });
  }

  // Stellar public keys are case-sensitive; compare exactly.
  const addr = wallet;

  // Find TALOS IDs where user is a patron
  const patronTalosIds = await db
    .select({ talosId: tlsPatrons.talosId })
    .from(tlsPatrons)
    .where(eq(tlsPatrons.stellarPublicKey, addr));

  const patronIds = patronTalosIds.map((p) => p.talosId);

  // Build a WHERE filter: user is owner (wallet/creator/investor/treasury) or patron
  const ownerCondition = or(
    eq(tlsTalos.walletPublicKey, addr),
    eq(tlsTalos.creatorPublicKey, addr),
    eq(tlsTalos.investorPublicKey, addr),
    eq(tlsTalos.treasuryPublicKey, addr),
  );
  const whereCondition = patronIds.length > 0
    ? or(ownerCondition, inArray(tlsTalos.id, patronIds))!
    : ownerCondition!;

  // Query only the matching TALOS records with their relations
  const talosRows = await db.query.tlsTalos.findMany({
    where: whereCondition,
    with: {
      approvals: { orderBy: (a, { desc: d }) => [d(a.createdAt)] },
      activities: { orderBy: (a, { desc: d }) => [d(a.createdAt)], limit: 10 },
      revenues: { orderBy: (r, { desc: d }) => [d(r.createdAt)] },
      patrons: true,
    },
  });

  // Aggregate data
  const totalValue = talosRows.reduce(
    (sum, c) => sum + Number(c.pulsePrice) * c.totalSupply,
    0,
  );
  const totalRevenue = talosRows.reduce(
    (sum, c) => sum + c.revenues.reduce((rs, r) => rs + Number(r.amount), 0),
    0,
  );

  const pendingApprovals = talosRows.flatMap((c) =>
    c.approvals
      .filter((a) => a.status === "pending")
      .map((a) => ({
        id: a.id,
        talosId: c.id,
        talosName: c.name,
        type: a.type,
        title: a.title,
        description: a.description,
        amount: a.amount ? `$${Number(a.amount)}` : null,
        timestamp: a.createdAt.toISOString(),
      })),
  );

  const approvalHistory = talosRows
    .flatMap((c) =>
      c.approvals
        .filter((a) => a.status === "approved" || a.status === "rejected")
        .map((a) => ({
          id: a.id,
          talosId: c.id,
          talosName: c.name,
          type: a.type,
          title: a.title,
          description: a.description,
          amount: a.amount ? `$${Number(a.amount)}` : null,
          status: a.status as "approved" | "rejected",
          decidedBy: a.decidedBy,
          decidedAt: a.decidedAt?.toISOString() ?? null,
          txHash: a.txHash ?? null,
          timestamp: a.createdAt.toISOString(),
        })),
    )
    .sort((a, b) => new Date(b.decidedAt ?? b.timestamp).getTime() - new Date(a.decidedAt ?? a.timestamp).getTime())
    .slice(0, 50);

  const allActivities = talosRows
    .flatMap((c) =>
      c.activities.map((a) => ({
        id: a.id,
        talosName: c.name,
        action: a.content,
        status: a.status,
        timestamp: a.createdAt.toISOString(),
      })),
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

  const agents = talosRows.map((c) => ({
    name: c.name,
    status: c.agentOnline ? "online" : "offline",
    lastActive: c.agentLastSeen ? getRelativeTime(c.agentLastSeen) : "never",
  }));

  const revenueStreams = talosRows
    .map((c) => {
      const talosRevenue = c.revenues.reduce((s, r) => s + Number(r.amount), 0);
      const bySource: Record<string, number> = {};
      for (const r of c.revenues) {
        bySource[r.source] = (bySource[r.source] ?? 0) + Number(r.amount);
      }
      return {
        talosId: c.id,
        talosName: c.name,
        totalRevenue: talosRevenue,
        bySource,
        recentTx: c.revenues.slice(0, 5).map((r) => ({
          amount: Number(r.amount),
          source: r.source,
          currency: r.currency,
          date: r.createdAt.toISOString(),
        })),
      };
    })
    .filter((r) => r.totalRevenue > 0);

  function maskApiKey(key: string | null): string | null {
    if (!key || key.length < 12) return null;
    return `${key.slice(0, 8)}${"*".repeat(key.length - 12)}${key.slice(-4)}`;
  }

  const talosManagement = talosRows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    approvalThreshold: Number(c.approvalThreshold),
    gtmBudget: Number(c.gtmBudget),
    channels: c.channels,
    stellarAssetCode: c.stellarAssetCode ?? "",
    agentWalletAddress: c.agentWalletAddress ?? null,
    totalSupply: c.totalSupply,
    pulsePrice: Number(c.pulsePrice),
    apiKeyMasked: maskApiKey(c.apiKey),
    apiKeyRaw: c.apiKey,
  }));

  return NextResponse.json({
    stats: {
      totalValue: `$${Math.round(totalValue).toLocaleString()}`,
      activeTalos: talosRows.filter((c) => c.status === "Active").length,
      totalRevenue: `$${totalRevenue.toFixed(2)}`,
      pendingCount: pendingApprovals.length,
    },
    approvals: pendingApprovals,
    approvalHistory,
    activities: allActivities,
    agents,
    revenueStreams,
    talosManagement,
  });
}

function getRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
