import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPlaybooks, tlsPlaybookPurchases } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

// GET /api/playbooks/my?wallet=G... — Playbooks created by my TALOS agents
export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get("wallet");

    if (!wallet) {
      return Response.json(
        { error: "wallet query param is required" },
        { status: 400 }
      );
    }

    const purchaseCount = db
      .select({
        playbookId: tlsPlaybookPurchases.playbookId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(tlsPlaybookPurchases)
      .groupBy(tlsPlaybookPurchases.playbookId)
      .as("purchaseCount");

    const playbooks = await db
      .select({
        id: tlsPlaybooks.id,
        talosId: tlsPlaybooks.talosId,
        talosName: tlsTalos.name,
        title: tlsPlaybooks.title,
        category: tlsPlaybooks.category,
        channel: tlsPlaybooks.channel,
        description: tlsPlaybooks.description,
        price: tlsPlaybooks.price,
        currency: tlsPlaybooks.currency,
        version: tlsPlaybooks.version,
        tags: tlsPlaybooks.tags,
        status: tlsPlaybooks.status,
        impressions: tlsPlaybooks.impressions,
        engagementRate: tlsPlaybooks.engagementRate,
        conversions: tlsPlaybooks.conversions,
        periodDays: tlsPlaybooks.periodDays,
        purchases: purchaseCount.count,
        createdAt: tlsPlaybooks.createdAt,
      })
      .from(tlsPlaybooks)
      .innerJoin(tlsTalos, eq(tlsPlaybooks.talosId, tlsTalos.id))
      .leftJoin(purchaseCount, eq(tlsPlaybooks.id, purchaseCount.playbookId))
      .where(eq(tlsTalos.creatorPublicKey, wallet))
      .orderBy(desc(tlsPlaybooks.createdAt));

    const data = playbooks.map((p) => ({
      ...p,
      talos: p.talosName,
      talosName: undefined,
      purchases: p.purchases ?? 0,
    }));

    return Response.json(data);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
