import { NextRequest } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs, tlsCommerceServices, tlsTalos } from "@/db/schema";
import { verifyAgentApiKey } from "@/lib/auth";

function parseWindow(windowParam: string | null): { windowMs: number; windowDays: number } {
  const raw = windowParam ?? "30d";
  const match = raw.match(/^(\d+)d$/i);
  if (!match) return { windowMs: 30 * 24 * 60 * 60 * 1000, windowDays: 30 };

  const windowDays = Number(match[1]);
  return { windowMs: windowDays * 24 * 60 * 60 * 1000, windowDays };
}

function parsePagination(request: Request): { limit: number; cursor: string | null } {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "25", 10) || 25, 1), 100);
  const cursor = searchParams.get("cursor");
  return { limit, cursor };
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDate(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["revenue:read"]);
    if (!auth.ok) return auth.response;

    const talos = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const { windowMs, windowDays } = parseWindow(searchParams.get("window"));
    const { limit, cursor } = parsePagination(request);
    const since = new Date(Date.now() - windowMs);

    const rows = await db
      .select({
        counterpartyId: tlsCommerceJobs.requesterTalosId,
        asset: sql<string>`coalesce(${tlsCommerceServices.currency}, 'USDC')`,
        category: tlsCommerceJobs.serviceName,
        reservedAmount: sql<string>`coalesce(sum(case when ${tlsCommerceJobs.status} in ('pending', 'processing') then ${tlsCommerceJobs.amount}::numeric else 0 end), '0')`,
        settledAmount: sql<string>`coalesce(sum(case when ${tlsCommerceJobs.status} = 'completed' and ${tlsCommerceJobs.txHash} is not null then ${tlsCommerceJobs.amount}::numeric else 0 end), '0')`,
        reservedCount: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} in ('pending', 'processing'))::int`,
        settledCount: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} = 'completed' and ${tlsCommerceJobs.txHash} is not null)::int`,
        lastObservedAt: sql<Date>`max(${tlsCommerceJobs.createdAt})`,
      })
      .from(tlsCommerceJobs)
      .leftJoin(
        tlsCommerceServices,
        and(
          eq(tlsCommerceJobs.talosId, tlsCommerceServices.talosId),
          eq(tlsCommerceJobs.serviceName, tlsCommerceServices.serviceName),
        ),
      )
      .where(and(eq(tlsCommerceJobs.talosId, id), gte(tlsCommerceJobs.createdAt, since)))
      .groupBy(tlsCommerceJobs.requesterTalosId, tlsCommerceJobs.serviceName, tlsCommerceServices.currency)
      .orderBy(desc(sql`max(${tlsCommerceJobs.createdAt})`));

    const filtered = rows
      .map((row) => ({
        agentId: id,
        counterpartyId: row.counterpartyId,
        asset: row.asset ?? "USDC",
        category: row.category ?? "unknown",
        reservedAmount: toNumber(row.reservedAmount),
        settledAmount: toNumber(row.settledAmount),
        reservedCount: row.reservedCount ?? 0,
        settledCount: row.settledCount ?? 0,
        windowDays,
        lastObservedAt: normalizeDate(row.lastObservedAt),
      }))
      .filter((row) => {
        const counterpartyFilter = searchParams.get("counterparty");
        if (counterpartyFilter && row.counterpartyId !== counterpartyFilter) return false;

        const assetFilter = searchParams.get("asset");
        if (assetFilter && row.asset !== assetFilter) return false;

        const categoryFilter = searchParams.get("category");
        if (categoryFilter && row.category !== categoryFilter) return false;

        return true;
      });

    const cursorIndex = cursor
      ? filtered.findIndex((row) => row.lastObservedAt === cursor)
      : -1;
    const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = filtered.slice(startIndex, startIndex + limit + 1);
    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;

    const freshest = items[0]?.lastObservedAt ?? filtered[0]?.lastObservedAt ?? null;
    const freshness = freshest
      ? {
          timestamp: freshest,
          stale: Date.now() - new Date(freshest).getTime() > 24 * 60 * 60 * 1000,
        }
      : null;

    return Response.json({
      agentId: id,
      windowDays,
      pagination: {
        limit,
        nextCursor: hasMore ? items[items.length - 1]?.lastObservedAt ?? null : null,
      },
      freshness,
      exposures: items,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
