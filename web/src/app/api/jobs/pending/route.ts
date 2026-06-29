import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

// GET /api/jobs/pending — Get pending jobs for the authenticated TALOS (as service provider)
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json({ error: "Missing Authorization header" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const talos = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.apiKey, token))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "Invalid API key" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 200);

    const conditions = [
      eq(tlsCommerceJobs.talosId, talos.id),
      eq(tlsCommerceJobs.status, "pending"),
    ];
    if (cursor) conditions.push(sql`${tlsCommerceJobs.createdAt} > ${new Date(cursor)}`);

    const rows = await db
      .select()
      .from(tlsCommerceJobs)
      .where(and(...conditions))
      .orderBy(asc(tlsCommerceJobs.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const jobs = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? jobs[jobs.length - 1]?.createdAt.toISOString() ?? null : null;

    return Response.json({ jobs, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
