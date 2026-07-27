import { NextRequest } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs, tlsCommerceServices, tlsTalos } from "@/db/schema";
import { verifyAgentApiKey } from "@/lib/auth";

function toNumber(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: unknown): string | null {
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
    const auth = await verifyAgentApiKey(request, id);
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
    const windowDays = Math.max(1, Number(searchParams.get("window") ?? 30));
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        counterpartyId: tlsCommerceJobs.requesterTalosId,
        asset: sql<string>`coalesce(${tlsCommerceServices.currency}, 'USDC')`,
        reservedAmount: sql<string>`coalesce(sum(case when ${tlsCommerceJobs.status} in ('pending', 'processing') then ${tlsCommerceJobs.amount}::numeric else 0 end), '0')`,
        settledAmount: sql<string>`coalesce(sum(case when ${tlsCommerceJobs.status} = 'completed' and ${tlsCommerceJobs.txHash} is not null then ${tlsCommerceJobs.amount}::numeric else 0 end), '0')`,
        deniedCount: sql<number>`count(*) filter (where ${tlsCommerceJobs.status} = 'failed')::int`,
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
      .groupBy(tlsCommerceJobs.requesterTalosId, tlsCommerceServices.currency)
      .orderBy(desc(sql`max(${tlsCommerceJobs.createdAt})`));

    const alerts = [] as Array<{
      type: string;
      severity: string;
      message: string;
      counterpartyId: string | null;
      asset: string;
      windowDays: number;
      observedAt: string | null;
    }>;

    for (const row of rows) {
      const reserved = toNumber(row.reservedAmount);
      const settled = toNumber(row.settledAmount);
      const drift = reserved > 0 && settled > 0 ? reserved - settled : 0;
      const deniedCount = row.deniedCount ?? 0;
      const observedAt = toIso(row.lastObservedAt);

      if (reserved >= 1000) {
        alerts.push({
          type: "saturation",
          severity: "warning",
          message: `Reserved exposure has reached ${reserved} for ${row.asset}.`,
          counterpartyId: row.counterpartyId,
          asset: row.asset ?? "USDC",
          windowDays,
          observedAt,
        });
      }

      if (deniedCount >= 3) {
        alerts.push({
          type: "repeated-denial",
          severity: "warning",
          message: `Repeated denials detected across ${deniedCount} jobs.`,
          counterpartyId: row.counterpartyId,
          asset: row.asset ?? "USDC",
          windowDays,
          observedAt,
        });
      }

      if (Math.abs(drift) >= 100) {
        alerts.push({
          type: "reconciliation-drift",
          severity: "critical",
          message: `Reserved and settled values diverged by ${drift}.`,
          counterpartyId: row.counterpartyId,
          asset: row.asset ?? "USDC",
          windowDays,
          observedAt,
        });
      }
    }

    return Response.json({
      agentId: id,
      windowDays,
      alerts,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
