/**
 * GET /api/marketplace/search
 *
 * Ranked marketplace search with deterministic cursor pagination.
 *
 * The cursor is bound to the sort field, sort direction, and a hash of the
 * active filters.  Any change to sort or filters invalidates the cursor so
 * equal-ranked items can never be duplicated or skipped across page boundaries.
 *
 * Query parameters
 * ────────────────
 *   q          text search matched against serviceName / description (optional)
 *   category   exact category match on the owning agent (optional)
 *   sort       createdAt | price  (default: createdAt)
 *   direction  asc | desc         (default: desc)
 *   limit      1–100              (default: 20)
 *   cursor     opaque cursor from a previous response (optional)
 *
 * Response
 * ────────
 *   200  { data: ServiceItem[], nextCursor: string | null }
 *   400  { error: string }  — bad cursor, bad sort, bad limit
 *   500  { error: string }
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, eq, ilike, lt, gt, lte, gte, or, type SQL } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";
import {
  parseMarketplaceSort,
  buildMarketplaceOrderBy,
  hashFilters,
  encodeRankedCursor,
  decodeRankedCursor,
  isCursorCompatible,
  SERVICES_SORT_FIELDS,
  type ServicesSortField,
  type MarketplaceSort,
  type RankedMarketplaceCursor,
} from "@/lib/marketplace-sort";
import { withTraceContext } from "@/lib/tracing";
import { internalError } from "@/lib/api-response";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceItem {
  id: string;
  talosId: string;
  talosName: string;
  talosCategory: string;
  serviceName: string;
  description: string | null;
  price: number;
  currency: string;
  chains: string[];
  createdAt: string;
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleGet(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const q = searchParams.get("q");
    const category = searchParams.get("category");

    // Sort + direction
    const parsedSort = parseMarketplaceSort(
      searchParams.get("sort"),
      searchParams.get("direction"),
      { allowedFields: SERVICES_SORT_FIELDS, fieldLabel: "createdAt, price" },
    );
    if (!parsedSort.ok) return parsedSort.response;
    const sort = parsedSort.sort;

    // Limit
    const parsedLimit = parseLimit(searchParams.get("limit"), 20, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    // Filter identity hash — cursor must carry the same hash to be valid
    const filterHash = hashFilters({
      q,
      category,
      sort: sort.field,
      direction: sort.direction,
    });

    // Cursor
    const rawCursor = searchParams.get("cursor");
    let cursor: RankedMarketplaceCursor | null = null;

    if (rawCursor !== null) {
      cursor = decodeRankedCursor(rawCursor);
      if (!cursor) {
        return Response.json(
          { error: "cursor is invalid or malformed" },
          { status: 400 },
        );
      }
      if (!isCursorCompatible(cursor, sort, filterHash)) {
        return Response.json(
          {
            error:
              "cursor sort or filter parameters do not match the current request — start a new search",
          },
          { status: 400 },
        );
      }
    }

    // Build ORDER BY: primary sort field + id tiebreaker (always desc on id)
    const sortColumns: Record<ServicesSortField, SQLWrapper> = {
      createdAt: tlsCommerceServices.createdAt,
      price: tlsCommerceServices.price,
    };
    const orderBy = buildMarketplaceOrderBy(sort, sortColumns, tlsCommerceServices.id);

    // Build WHERE conditions
    const conditions: SQL[] = [eq(tlsTalos.status, "Active")];

    if (q) {
      const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      conditions.push(
        or(
          ilike(tlsCommerceServices.serviceName, pattern),
          ilike(tlsCommerceServices.description, pattern),
        )!,
      );
    }

    if (category) {
      conditions.push(ilike(tlsTalos.category, category));
    }

    // Cursor condition — prevents duplicates at equal-rank page boundaries.
    // The id tiebreaker is always ordered descending so we always use < cursor.id
    // as the secondary condition.
    if (cursor) {
      const cursorCondition = buildCursorCondition(cursor, sort);
      if (cursorCondition) conditions.push(cursorCondition);
    }

    // Fetch limit+1 to detect whether a next page exists
    const rows = await db
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
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Build next cursor from the last item on this page
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      // Store the value of the sort field plus id for the tiebreaker.
      // For price sort we encode the price in createdAt field (repurposed as
      // sortValue string) so the cursor format stays stable across sort fields.
      const sortValue =
        sort.field === "price"
          ? String(last.price)
          : last.createdAt.toISOString();

      nextCursor = encodeRankedCursor({
        sortField: sort.field,
        sortDirection: sort.direction,
        filterHash,
        createdAt: sortValue,
        id: last.id,
      });
    }

    const data: ServiceItem[] = page.map((row) => ({
      id: row.id,
      talosId: row.talosId,
      talosName: row.talosName,
      talosCategory: row.talosCategory,
      serviceName: row.serviceName,
      description: row.description,
      price: Number(row.price),
      currency: row.currency,
      chains: row.chains,
      createdAt: row.createdAt.toISOString(),
    }));

    return Response.json({ data, nextCursor });
  } catch {
    return internalError(request);
  }
}

// ── Cursor condition builder ───────────────────────────────────────────────────

/**
 * Build the WHERE clause fragment that positions the query after the cursor.
 *
 * For `desc` ordering:
 *   (primaryCol < cursorVal) OR (primaryCol = cursorVal AND id < cursorId)
 *
 * For `asc` ordering:
 *   (primaryCol > cursorVal) OR (primaryCol = cursorVal AND id < cursorId)
 *
 * The id tiebreaker is always `< cursorId` because buildMarketplaceOrderBy
 * always appends `desc(id)` regardless of the primary sort direction.
 */
function buildCursorCondition(
  cursor: RankedMarketplaceCursor,
  sort: MarketplaceSort<string>,
): SQL | null {
  const isDesc = sort.direction === "desc";

  if (sort.field === "createdAt") {
    const cursorDate = new Date(cursor.createdAt);
    return (
      or(
        isDesc
          ? lt(tlsCommerceServices.createdAt, cursorDate)
          : gt(tlsCommerceServices.createdAt, cursorDate),
        and(
          isDesc
            ? lte(tlsCommerceServices.createdAt, cursorDate)
            : gte(tlsCommerceServices.createdAt, cursorDate),
          lt(tlsCommerceServices.id, cursor.id),
        ),
      ) ?? null
    );
  }

  if (sort.field === "price") {
    // cursor.createdAt carries the price string (sortValue) for price-sorted pages
    const priceVal = cursor.createdAt;
    return (
      or(
        isDesc
          ? lt(tlsCommerceServices.price, priceVal)
          : gt(tlsCommerceServices.price, priceVal),
        and(
          isDesc
            ? lte(tlsCommerceServices.price, priceVal)
            : gte(tlsCommerceServices.price, priceVal),
          lt(tlsCommerceServices.id, cursor.id),
        ),
      ) ?? null
    );
  }

  return null;
}

export const GET = withTraceContext(handleGet);
