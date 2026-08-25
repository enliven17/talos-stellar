import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, lt, lte, ne, or } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";
import { fetchReputations } from "@/lib/reputation-ledger";
import { withTraceContext } from "@/lib/tracing";

const VALID_SORT = ["price_asc", "price_desc", "newest"] as const;
type SortOrder = (typeof VALID_SORT)[number];

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

    // Price range — reject reversed ranges explicitly
    const minPriceRaw = searchParams.get("minPrice");
    const maxPriceRaw = searchParams.get("maxPrice");
    const minPrice = minPriceRaw !== null ? parseFloat(minPriceRaw) : null;
    const maxPrice = maxPriceRaw !== null ? parseFloat(maxPriceRaw) : null;

    if (minPrice !== null && isNaN(minPrice)) {
      return Response.json({ error: "minPrice must be a number" }, { status: 400 });
    }
    if (maxPrice !== null && isNaN(maxPrice)) {
      return Response.json({ error: "maxPrice must be a number" }, { status: 400 });
    }
    if (minPrice !== null && minPrice < 0) {
      return Response.json({ error: "minPrice must be non-negative" }, { status: 400 });
    }
    if (maxPrice !== null && maxPrice < 0) {
      return Response.json({ error: "maxPrice must be non-negative" }, { status: 400 });
    }
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      return Response.json({ error: "minPrice cannot be greater than maxPrice" }, { status: 400 });
    }

    // Sort order — default newest; price sorts disable shuffle for stable ordering
    const sortRaw = searchParams.get("sortBy") ?? "newest";
    const sortBy: SortOrder = (VALID_SORT as readonly string[]).includes(sortRaw)
      ? (sortRaw as SortOrder)
      : "newest";

    let currentCursor = cursor;
    const accumulated: any[] = [];
    let exhausted = false;

    // Loop until we fulfill the limit or exhaust the DB.
    // For price-sorted requests we run a single pass (no cursor continuation).
    const isPriceSorted = sortBy !== "newest";

    const orderClauses =
      sortBy === "price_asc"
        ? [asc(tlsCommerceServices.price), asc(tlsCommerceServices.id)]
        : sortBy === "price_desc"
        ? [desc(tlsCommerceServices.price), asc(tlsCommerceServices.id)]
        : [desc(tlsCommerceServices.createdAt), desc(tlsCommerceServices.id)];

    while (accumulated.length < limit && !exhausted) {
      const conditions = [eq(tlsTalos.status, "Active")];

      if (selfId) {
        conditions.push(ne(tlsCommerceServices.talosId, selfId));
      }

      if (category) {
        conditions.push(ilike(tlsTalos.category, category));
      }

      if (minPrice !== null) {
        conditions.push(gte(tlsCommerceServices.price, String(minPrice)));
      }

      if (maxPrice !== null) {
        conditions.push(lte(tlsCommerceServices.price, String(maxPrice)));
      }

      // Cursor pagination only for newest sort
      if (!isPriceSorted && currentCursor) {
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
        .orderBy(...orderClauses)
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

      // Price-sorted: single pass only
      if (isPriceSorted) break;
    }

    // Shuffle for diversity only for newest sort
    if (!isPriceSorted) {
      for (let i = accumulated.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [accumulated[i], accumulated[j]] = [accumulated[j], accumulated[i]];
      }
    }

    // Price-sorted results never emit a cursor
    const nextCursor = isPriceSorted
      ? null
      : (exhausted && accumulated.length < limit) ? null : currentCursor;

    const results = accumulated.map(({ id, createdAt, ...rest }) => rest);

    return Response.json({ data: results, nextCursor });
  } catch {
    return internalError(request);
  }
}

export const GET = withTraceContext(handleGet);
