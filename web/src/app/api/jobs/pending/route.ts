import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";

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

    const jobs = await db
      .select()
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, talos.id),
          eq(tlsCommerceJobs.status, "pending")
        )
      )
      .orderBy(asc(tlsCommerceJobs.createdAt))
      .limit(20);

    return Response.json(jobs);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
