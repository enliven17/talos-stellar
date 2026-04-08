import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPlaybooks, tlsPlaybookPurchases } from "@/db/schema";
import { and, arrayContains, desc, eq, ilike, lt, or, sql } from "drizzle-orm";

const VALID_CATEGORIES = [
  "Channel Strategy",
  "Content Templates",
  "Targeting",
  "Response",
  "Growth Hacks",
];
const VALID_CHANNELS = ["X", "LinkedIn", "Reddit", "Product Hunt"];

// GET /api/playbooks — List playbooks (with optional filters and cursor pagination)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const category = searchParams.get("category");
    const channel = searchParams.get("channel");
    const search = searchParams.get("search");
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

    const conditions = [eq(tlsPlaybooks.status, "active")];

    if (category && category !== "All") {
      conditions.push(eq(tlsPlaybooks.category, category));
    }
    if (channel && channel !== "All") {
      conditions.push(eq(tlsPlaybooks.channel, channel));
    }
    if (search) {
      conditions.push(
        or(
          ilike(tlsPlaybooks.title, `%${search}%`),
          ilike(tlsPlaybooks.description, `%${search}%`),
          arrayContains(tlsPlaybooks.tags, [search.toLowerCase()]),
        )!
      );
    }

    // Cursor condition (createdAt DESC with id tiebreaker)
    if (cursor) {
      const [cursorDate, cursorId] = cursor.split("|");
      if (cursorDate && cursorId) {
        conditions.push(
          or(
            lt(tlsPlaybooks.createdAt, new Date(cursorDate)),
            and(
              eq(tlsPlaybooks.createdAt, new Date(cursorDate)),
              lt(tlsPlaybooks.id, cursorId),
            ),
          )!,
        );
      }
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
        content: tlsPlaybooks.content,
        purchases: purchaseCount.count,
        createdAt: tlsPlaybooks.createdAt,
      })
      .from(tlsPlaybooks)
      .innerJoin(tlsTalos, eq(tlsPlaybooks.talosId, tlsTalos.id))
      .leftJoin(purchaseCount, eq(tlsPlaybooks.id, purchaseCount.playbookId))
      .where(and(...conditions))
      .orderBy(desc(tlsPlaybooks.createdAt), desc(tlsPlaybooks.id))
      .limit(limit + 1);

    const hasMore = playbooks.length > limit;
    const page = hasMore ? playbooks.slice(0, limit) : playbooks;

    const data = page.map((p) => ({
      ...p,
      talos: p.talosName,
      talosName: undefined,
      purchases: p.purchases ?? 0,
    }));

    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem
      ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
      : null;

    return Response.json({ data, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/playbooks — Create a playbook (requires TALOS apiKey)
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 }
      );
    }

    const token = authHeader.slice(7);
    const talos = await db
      .select({ id: tlsTalos.id, apiKey: tlsTalos.apiKey })
      .from(tlsTalos)
      .where(eq(tlsTalos.apiKey, token))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "Invalid API key" }, { status: 403 });
    }

    const body = await request.json();
    const {
      title,
      category,
      channel,
      description,
      price,
      tags,
      content,
      impressions,
      engagementRate,
      conversions,
      periodDays,
    } = body;

    if (!title || !category || !channel || !description || price == null) {
      return Response.json(
        { error: "title, category, channel, description, price are required" },
        { status: 400 }
      );
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return Response.json(
        { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` },
        { status: 400 }
      );
    }

    if (!VALID_CHANNELS.includes(channel)) {
      return Response.json(
        { error: `channel must be one of: ${VALID_CHANNELS.join(", ")}` },
        { status: 400 }
      );
    }

    if (typeof price !== "number" || price <= 0) {
      return Response.json(
        { error: "price must be a positive number" },
        { status: 400 }
      );
    }

    const [playbook] = await db
      .insert(tlsPlaybooks)
      .values({
        talosId: talos.id,
        title,
        category,
        channel,
        description,
        price: String(price),
        tags: tags ?? [],
        content: content ?? null,
        impressions: impressions ?? 0,
        engagementRate: String(engagementRate ?? 0),
        conversions: conversions ?? 0,
        periodDays: periodDays ?? 30,
      })
      .returning();

    return Response.json(playbook, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
