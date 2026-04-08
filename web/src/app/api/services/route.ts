import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, desc, eq, ilike, lt, ne, or } from "drizzle-orm";

// GET /api/services — Discover available services across all TALOS agents
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const category = searchParams.get("category");
    const selfId = searchParams.get("self");
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

    const conditions = [];

    // Exclude the requesting TALOS's own services
    if (selfId) {
      conditions.push(ne(tlsCommerceServices.talosId, selfId));
    }

    // Filter by TALOS category (case-insensitive match in DB)
    if (category) {
      conditions.push(ilike(tlsTalos.category, category));
    }

    // Cursor condition (createdAt DESC with id tiebreaker)
    if (cursor) {
      const [cursorDate, cursorId] = cursor.split("|");
      if (cursorDate && cursorId) {
        conditions.push(
          or(
            lt(tlsCommerceServices.createdAt, new Date(cursorDate)),
            and(
              eq(tlsCommerceServices.createdAt, new Date(cursorDate)),
              lt(tlsCommerceServices.id, cursorId),
            ),
          )!,
        );
      }
    }

    const services = await db
      .select({
        id: tlsCommerceServices.id,
        talosId: tlsCommerceServices.talosId,
        talosName: tlsTalos.name,
        talosCategory: tlsTalos.category,
        serviceName: tlsCommerceServices.serviceName,
        description: tlsCommerceServices.description,
        price: tlsCommerceServices.price,
        currency: tlsCommerceServices.currency,
        chains: tlsCommerceServices.chains,
        createdAt: tlsCommerceServices.createdAt,
      })
      .from(tlsCommerceServices)
      .innerJoin(tlsTalos, eq(tlsCommerceServices.talosId, tlsTalos.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tlsCommerceServices.createdAt), desc(tlsCommerceServices.id))
      .limit(limit + 1);

    const hasMore = services.length > limit;
    const page = hasMore ? services.slice(0, limit) : services;

    let results = page.map((s) => ({
      talosId: s.talosId,
      talosName: s.talosName,
      talosCategory: s.talosCategory,
      serviceName: s.serviceName,
      description: s.description,
      price: Number(s.price),
      currency: s.currency,
      chains: s.chains,
    }));

    // Shuffle for diversity — agents see different services each cycle
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [results[i], results[j]] = [results[j], results[i]];
    }

    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem
      ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
      : null;

    return Response.json({ data: results, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
