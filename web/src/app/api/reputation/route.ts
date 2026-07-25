import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsCommerceServices } from "@/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { getOrCreateReputation } from "@/lib/reputation";
import { rateLimit, rateLimitResponse, applyRateLimitHeaders } from "@/lib/rate-limit";

const COLD_START_THRESHOLD = 3;

export async function GET(request: NextRequest) {
  // 1. Rate Limiting
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1";

  const limitResult = rateLimit(`reputation:${ip}`, { limit: 100, windowMs: 60 * 1000 });
  if (!limitResult.ok) {
    return rateLimitResponse(limitResult);
  }

  // 2. Authorization Header Check
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return applyRateLimitHeaders(
      Response.json({ error: "Missing or invalid Authorization header" }, { status: 401 }),
      limitResult
    );
  }

  const apiKey = authHeader.slice(7);
  const talos = await db.query.tlsTalos.findFirst({
    where: (t, { eq }) => eq(t.apiKey, apiKey),
  });

  if (!talos) {
    return applyRateLimitHeaders(
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      limitResult
    );
  }

  try {
    const { searchParams } = request.nextUrl;
    const provider = searchParams.get("provider");
    const service = searchParams.get("service");
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

    const minConfidence = searchParams.get("minConfidence") !== null
      ? parseFloat(searchParams.get("minConfidence")!)
      : null;
    const minEvidence = searchParams.get("minEvidence") !== null
      ? parseInt(searchParams.get("minEvidence")!, 10)
      : null;
    const forceRefresh = searchParams.get("forceRefresh") === "true";

    const conditions = [];

    if (provider) {
      conditions.push(eq(tlsCommerceServices.talosId, provider));
    }

    if (service) {
      conditions.push(eq(tlsCommerceServices.serviceName, service));
    }

    if (cursor) {
      const [cursorDate, cursorId] = cursor.split("|");
      if (cursorDate && cursorId) {
        conditions.push(
          or(
            lt(tlsCommerceServices.createdAt, new Date(cursorDate)),
            and(
              eq(tlsCommerceServices.createdAt, new Date(cursorDate)),
              lt(tlsCommerceServices.id, cursorId)
            )
          )
        );
      }
    }

    // Discover matching provider-service offerings
    const services = await db
      .select({
        id: tlsCommerceServices.id,
        talosId: tlsCommerceServices.talosId,
        serviceName: tlsCommerceServices.serviceName,
        createdAt: tlsCommerceServices.createdAt,
      })
      .from(tlsCommerceServices)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tlsCommerceServices.createdAt), desc(tlsCommerceServices.id))
      .limit(limit + 1);

    const hasMore = services.length > limit;
    const page = hasMore ? services.slice(0, limit) : services;

    // Load or calculate reputation data
    const data = [];
    for (const item of page) {
      const reputation = await getOrCreateReputation(item.talosId, item.serviceName, forceRefresh);
      
      // Filtering constraints (ignore constraints if provider is cold start)
      if (reputation.samples < COLD_START_THRESHOLD) {
        data.push(reputation);
      } else {
        if (minConfidence !== null && reputation.confidence < minConfidence) continue;
        if (minEvidence !== null && reputation.samples < minEvidence) continue;
        data.push(reputation);
      }
    }

    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem
      ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
      : null;

    return applyRateLimitHeaders(
      Response.json({ data, nextCursor }),
      limitResult
    );
  } catch (error) {
    console.error("Reputation API error:", error);
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      limitResult
    );
  }
}
