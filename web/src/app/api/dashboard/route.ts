import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons } from "@/db/schema";
import { eq, or, inArray } from "drizzle-orm";
import { withTimeout, TimeoutError } from "@/lib/timeout";
import { withRequestId } from "@/lib/with-request-id";

import { badRequest, errorResponse, internalError } from "@/lib/api-response";
import { parseStellarPublicKeyParam } from "@/lib/stellar-keys";
import { summarizeRevenueObservations } from "@/lib/revenue-observations";

/** Timeout in ms for dashboard database queries (under platform function limit). */
export const DASHBOARD_QUERY_TIMEOUT_MS = 15_000;

async function _GET(req: NextRequest) {
  const walletResult = parseStellarPublicKeyParam(req.nextUrl.searchParams.get("wallet"));
  if (!walletResult.ok) {
    return walletResult.response;
  }
  const addr = walletResult.publicKey;


  // Add timeout for patron query
  let patronTalosIds = [];
  try {
    patronTalosIds = await withTimeout(
      db.select({ talosId: tlsPatrons.talosId }).from(tlsPatrons).where(eq(tlsPatrons.stellarPublicKey, addr)).limit(100),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "Dashboard patron query timeout",
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      return errorResponse(
        req,
        504,
        "GATEWAY_TIMEOUT",
        "Query timeout. Please try again with a simpler query.",
      );
    }
    console.error("Dashboard query error:", error);
    return internalError(req);
  }

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
  let talosRows = [];
  try {
    talosRows = await withTimeout(
      db.query.tlsTalos.findMany({
        where: whereCondition,
        limit: 100,
        with: {
          approvals: { orderBy: (a, { desc: d }) => [d(a.createdAt)], limit: 50 },
          activities: { orderBy: (a, { desc: d }) => [d(a.createdAt)], limit: 10 },
          revenues: { orderBy: (r, { desc: d }) => [d(r.createdAt)], limit: 50 },
          patrons: { limit: 50 },
        },
      }),
      DASHBOARD_QUERY_TIMEOUT_MS,
      "Dashboard main query timeout",
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      return errorResponse(
        req,
        504,
        "GATEWAY_TIMEOUT",
        "Query timeout. Please try again with a simpler query.",
      );
    }
    console.error("Dashboard query error:", error);
    return internalError(req);
  }

  // Aggregate data
  const totalValue = talosRows.reduce(
    (sum, c) => sum + Number(c.pulsePrice) * c.totalSupply,
    0,
  );
  // Absence of revenue records is not evidence of zero revenue, so the
  // aggregate is only reported once at least one observation exists.
  const revenueSummaries = talosRows.map((c) => ({
    talos: c,
    summary: summarizeRevenueObservations(c.revenues),
  }));
  const hasRevenueObservations = revenueSummaries.some(
    ({ summary }) => summary.hasObservations,
  );
  const totalRevenue = revenueSummaries.reduce(
    (sum, { summary }) => sum + (summary.total ?? 0),
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

  // Keep streams that have at least one observation, including a verified
  // zero. Streams with no observations are omitted rather than reported as $0.
  const revenueStreams = revenueSummaries
    .filter(({ summary }) => summary.hasObservations)
    .map(({ talos: c, summary }) => ({
      talosId: c.id,
      talosName: c.name,
      totalRevenue: summary.total,
      observationCount: c.revenues.length,
      bySource: summary.bySource ?? {},
      recentTx: c.revenues.slice(0, 5).map((r) => ({
        amount: Number(r.amount),
        source: r.source,
        currency: r.currency,
        date: r.createdAt.toISOString(),
      })),
    }));

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
      totalRevenue: hasRevenueObservations ? `$${totalRevenue.toFixed(2)}` : null,
      pendingCount: pendingApprovals.length,
    },
    approvals: pendingApprovals,
    approvalHistory,
    activities: allActivities,
    agents,
    revenueStreams,
    talosManagement,
    observedAt: new Date().toISOString(),
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

export const GET = withRequestId(_GET);
