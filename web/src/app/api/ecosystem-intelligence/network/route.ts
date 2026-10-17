import { NextResponse } from "next/server";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs, tlsTalos } from "@/db/schema";
import { isRetryableDbError } from "@/db/db-retry";
import {
  AnalyticsInputValidationError,
  DEFAULT_ANALYTICS_PRIVACY_POLICY,
  deduplicateAnalyticsRows,
  suppressSparseRows,
} from "@/lib/analytics-privacy";
import { withRequestId } from "@/lib/with-request-id";

const MAX_NODES = 100;
const MAX_EDGES = 200;
const ALLOWED_WINDOWS = new Set([7, 30, 90]);

interface CommerceJobRow {
  id: string;
  talosId: string;
  requesterTalosId: string;
  amount: string;
}

interface AggregatedEdge {
  buyerId: string;
  sellerId: string;
  jobCount: number;
  volume: number;
}

export function aggregateCommerceEdges(rows: readonly CommerceJobRow[]) {
  const { rows: jobs, duplicateCount } = deduplicateAnalyticsRows(
    rows,
    "commerce jobs",
    row => row.id,
  );
  const grouped = new Map<string, AggregatedEdge>();

  for (const job of jobs) {
    if (!job.requesterTalosId || !job.talosId || job.requesterTalosId === job.talosId) {
      continue;
    }
    const key = JSON.stringify([job.requesterTalosId, job.talosId]);
    const current = grouped.get(key) ?? {
      buyerId: job.requesterTalosId,
      sellerId: job.talosId,
      jobCount: 0,
      volume: 0,
    };
    current.jobCount += 1;
    current.volume += Number(job.amount) || 0;
    grouped.set(key, current);
  }

  const privacy = suppressSparseRows(
    [...grouped.values()],
    edge => edge.jobCount,
  );
  const selectedEdges: AggregatedEdge[] = [];
  const nodeIds = new Set<string>();

  for (const edge of privacy.rows.sort((a, b) =>
    b.jobCount - a.jobCount || b.volume - a.volume ||
    a.buyerId.localeCompare(b.buyerId) || a.sellerId.localeCompare(b.sellerId)
  )) {
    const newNodeCount = Number(!nodeIds.has(edge.buyerId)) + Number(!nodeIds.has(edge.sellerId));
    if (selectedEdges.length >= MAX_EDGES || nodeIds.size + newNodeCount > MAX_NODES) {
      continue;
    }
    nodeIds.add(edge.buyerId);
    nodeIds.add(edge.sellerId);
    selectedEdges.push(edge);
  }

  return {
    edges: selectedEdges,
    nodeIds: [...nodeIds],
    duplicateCount,
    suppressedCount: privacy.suppressedCount,
    truncated: selectedEdges.length < privacy.rows.length,
  };
}

async function _GET(request: Request) {
  const url = new URL(request.url);
  const windowValue = url.searchParams.get("window") ?? "30";
  const windowDays = Number(windowValue);
  if (!Number.isInteger(windowDays) || !ALLOWED_WINDOWS.has(windowDays)) {
    return NextResponse.json(
      { error: "window must be one of 7, 30, or 90 days" },
      { status: 400 },
    );
  }

  try {
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const rawJobs = await db.query.tlsCommerceJobs.findMany({
      where: and(
        eq(tlsCommerceJobs.status, "completed"),
        gte(tlsCommerceJobs.createdAt, since),
      ),
      columns: {
        id: true,
        talosId: true,
        requesterTalosId: true,
        amount: true,
      },
      limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
    });
    const aggregation = aggregateCommerceEdges(rawJobs);
    const names = aggregation.nodeIds.length
      ? await db.query.tlsTalos.findMany({
          where: inArray(tlsTalos.id, aggregation.nodeIds),
          columns: { id: true, name: true },
        })
      : [];
    const nameById = new Map(names.map(agent => [agent.id, agent.name]));
    const edges = aggregation.edges.map(edge => ({
      buyer: { id: edge.buyerId, name: nameById.get(edge.buyerId) ?? edge.buyerId },
      seller: { id: edge.sellerId, name: nameById.get(edge.sellerId) ?? edge.sellerId },
      jobCount: edge.jobCount,
      volume: edge.volume,
    }));

    const response = NextResponse.json({
      edges,
      metadata: {
        windowDays,
        generatedAt: generatedAt.toISOString(),
        nodeCount: aggregation.nodeIds.length,
        suppressedEdges: aggregation.suppressedCount,
        deduplicatedJobs: aggregation.duplicateCount,
        truncated: aggregation.truncated,
        maximumNodes: MAX_NODES,
        maximumEdges: MAX_EDGES,
      },
    });
    response.headers.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return response;
  } catch (error) {
    if (error instanceof AnalyticsInputValidationError) {
      return NextResponse.json(
        { error: "Analytics input failed validation", retryable: false },
        { status: 422 },
      );
    }
    if (isRetryableDbError(error)) {
      return NextResponse.json(
        { error: "Temporary database error, please retry", retryable: true },
        { status: 503 },
      );
    }
    console.error("Error fetching ecosystem commerce network:", error);
    return NextResponse.json(
      { error: "Failed to fetch ecosystem commerce network" },
      { status: 500 },
    );
  }
}

export const GET = withRequestId(_GET);