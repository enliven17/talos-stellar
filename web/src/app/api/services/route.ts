import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, desc, eq, ilike, lt, ne, or } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";
import { fetchReputations } from "@/lib/reputation-ledger";
import { withTraceContext } from "@/lib/tracing";

// GET /api/services — Discover available services across all TALOS agents
async function handleGet(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const selfId = searchParams.get("self");
    const cursor = searchParams.get("cursor");
    const parsedLimit = parseLimit(searchParams.get("limit"), 50, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    const minScore = searchParams.has("minScore") ? Number(searchParams.get("minScore")) : undefined;
    const minConfidence = searchParams.has("minConfidence") ? Number(searchParams.get("minConfidence")) : undefined;
    const allowColdStart = searchParams.get("allowColdStart") === "true";

    let currentCursor = cursor;
    const accumulated: any[] = [];
    let exhausted = false;

    // Loop until we fulfill the limit or exhaust the DB
    while (accumulated.length < limit && !exhausted) {
      const conditions = [eq(tlsTalos.status, "Active")];

      // Exclude the requesting TALOS's own services
      if (selfId) {
        conditions.push(ne(tlsCommerceServices.talosId, selfId));
      }

      // Filter by TALOS category (case-insensitive match in DB)
      if (category) {
        conditions.push(ilike(tlsTalos.category, category));
      }

      // Cursor condition (createdAt DESC with id tiebreaker)
      if (currentCursor) {
        const [cursorDate, cursorId] = currentCursor.split("|");
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
        .limit(limit * 2);

      if (services.length === 0) {
        exhausted = true;
        break;
      }

      if (services.length < limit * 2) {
        exhausted = true;
      }

      const talosIds = Array.from(new Set(services.map((s) => s.talosId)));
      const reputations = await fetchReputations(talosIds, new Date());

      for (const service of services) {
        let valid = true;
        
        if (minScore !== undefined || minConfidence !== undefined || allowColdStart) {
          const rep = reputations.get(service.talosId);
          if (rep) {
            if (rep.evidence === "insufficient") {
              if (!allowColdStart) valid = false;
            } else {
              if (minScore !== undefined && rep.score < minScore) valid = false;
              if (minConfidence !== undefined && rep.confidence < minConfidence) valid = false;
            }
          } else {
            // Cold start
            if (!allowColdStart) valid = false;
          }
        }

        if (valid) {
          accumulated.push({
            id: service.id,
            talosId: service.talosId,
            talosName: service.talosName,
            talosCategory: service.talosCategory,
            serviceName: service.serviceName,
            description: service.description,
            price: Number(service.price),
            currency: service.currency,
            chains: service.chains,
            createdAt: service.createdAt,
          });
          if (accumulated.length === limit) {
            currentCursor = `${service.createdAt.toISOString()}|${service.id}`;
            break;
          }
        }
        currentCursor = `${service.createdAt.toISOString()}|${service.id}`;
      }
    }

    // Shuffle for diversity — agents see different services each cycle
    for (let i = accumulated.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accumulated[i], accumulated[j]] = [accumulated[j], accumulated[i]];
    }

    const nextCursor = (exhausted && accumulated.length < limit) ? null : currentCursor;

    // Remove cursor tracking fields from the output to match original payload structure
    const results = accumulated.map(({ id, createdAt, ...rest }) => rest);

    return Response.json({ data: results, nextCursor });
  } catch {
    return internalError(request);
  }
}

export const GET = withTraceContext(handleGet);
