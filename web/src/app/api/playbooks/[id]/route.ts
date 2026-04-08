import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPlaybooks, tlsPlaybookPurchases } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

// GET /api/playbooks/:id — Playbook detail
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const purchaseCount = db
      .select({
        playbookId: tlsPlaybookPurchases.playbookId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(tlsPlaybookPurchases)
      .where(eq(tlsPlaybookPurchases.playbookId, id))
      .groupBy(tlsPlaybookPurchases.playbookId)
      .as("purchaseCount");

    const result = await db
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
        content: tlsPlaybooks.content,
        purchases: purchaseCount.count,
        createdAt: tlsPlaybooks.createdAt,
        updatedAt: tlsPlaybooks.updatedAt,
      })
      .from(tlsPlaybooks)
      .innerJoin(tlsTalos, eq(tlsPlaybooks.talosId, tlsTalos.id))
      .leftJoin(purchaseCount, eq(tlsPlaybooks.id, purchaseCount.playbookId))
      .where(eq(tlsPlaybooks.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!result) {
      return Response.json({ error: "Playbook not found" }, { status: 404 });
    }

    return Response.json({
      ...result,
      talos: result.talosName,
      talosName: undefined,
      purchases: result.purchases ?? 0,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/playbooks/:id — Update playbook (requires TALOS apiKey)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7);

    const playbook = await db.query.tlsPlaybooks.findFirst({
      where: eq(tlsPlaybooks.id, id),
      with: {
        talos: { columns: { apiKey: true } },
      },
    });

    if (!playbook) {
      return Response.json({ error: "Playbook not found" }, { status: 404 });
    }

    if (!playbook.talos.apiKey || playbook.talos.apiKey !== token) {
      return Response.json({ error: "Invalid API key" }, { status: 403 });
    }

    const body = await request.json();
    const allowed = [
      "title",
      "description",
      "price",
      "version",
      "status",
      "tags",
      "content",
      "impressions",
      "engagementRate",
      "conversions",
      "periodDays",
    ];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        // Convert numeric fields to string for Decimal columns
        if ((key === "price" || key === "engagementRate") && typeof body[key] === "number") {
          data[key] = String(body[key]);
        } else {
          data[key] = body[key];
        }
      }
    }

    if (data.status && !["active", "inactive"].includes(data.status as string)) {
      return Response.json(
        { error: "status must be 'active' or 'inactive'" },
        { status: 400 }
      );
    }

    if (data.price !== undefined) {
      if (typeof body.price !== "number" || body.price <= 0) {
        return Response.json(
          { error: "price must be a positive number" },
          { status: 400 }
        );
      }
    }

    const [updated] = await db
      .update(tlsPlaybooks)
      .set(data)
      .where(eq(tlsPlaybooks.id, id))
      .returning();

    return Response.json(updated);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
