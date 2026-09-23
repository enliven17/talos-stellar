import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices } from "@/db/schema";
import { and, eq, ilike, lt, ne, or, type SQL, type SQLWrapper } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";
import {
  buildMarketplaceOrderBy,
  isDefaultMarketplaceSort,
  parseMarketplaceSort,
  SERVICES_SORT_FIELDS,
  type ServicesSortField,
} from "@/lib/marketplace-sort";
import { fetchReputations } from "@/lib/reputation-ledger";
import { withTraceContext } from "@/lib/tracing";
import { internalError } from "@/lib/api-response";

export type ServiceCursor = {
  createdAt: string;
  id: string;
};

type ServiceRow = {
  id: string;
  talosId: string;
  talosName: string;
  talosCategory: string;
  serviceName: string;
  description: string | null;
  price: string | number;
  currency: string;
  chains: string[];
  createdAt: Date;
};

type ServiceResult = Omit<ServiceRow, "price" | "createdAt" | "id"> & {
  price: number;
};

export function encodeServiceCursor(cursor: ServiceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeServiceCursor(raw: string | null): ServiceCursor | null {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ServiceCursor>;
    const date = new Date(parsed.createdAt ?? "");
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(date.getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { createdAt: date.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

async function handleGet(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const selfId = searchParams.get("self");
    const rawCursor = searchParams.get("cursor");
    const cursor = decodeServiceCursor(rawCursor);
    if (searchParams.has("cursor") && !cursor) {
      return Response.json(
        { error: "cursor must be a valid service cursor" },
        { status: 400 },
      );
    }
    const parsedLimit = parseLimit(searchParams.get("limit"), 50, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    const parsedSort = parseMarketplaceSort(
      searchParams.get("sort"),
      searchParams.get("direction"),
      { allowedFields: SERVICES_SORT_FIELDS, fieldLabel: "createdAt, price" },
    );
    if (!parsedSort.ok) return parsedSort.response;
    const sort = parsedSort.sort;

    if (cursor && !isDefaultMarketplaceSort(sort)) {
      return Response.json(
        {
          error:
            "cursor pagination is only supported with the default createdAt desc sort",
        },
        { status: 400 },
      );
    }

    const sortColumns: Record<ServicesSortField, SQLWrapper> = {
      createdAt: tlsCommerceServices.createdAt,
      price: tlsCommerceServices.price,
    };
    const orderBy = buildMarketplaceOrderBy(
      sort,
      sortColumns,
      tlsCommerceServices.id,
    );

    const minScore = searchParams.has("minScore")
      ? Number(searchParams.get("minScore"))
      : undefined;
    const minConfidence = searchParams.has("minConfidence")
      ? Number(searchParams.get("minConfidence"))
      : undefined;
    const allowColdStart = searchParams.get("allowColdStart") === "true";

    const accumulated: ServiceResult[] = [];
    let currentCursor: ServiceCursor | null = cursor;
    let pageCursor: ServiceCursor | null = null;
    let hasMore = false;
    let dbExhausted = false;

    while (!dbExhausted && !(accumulated.length === limit && hasMore)) {
      const conditions = buildConditions(
        currentCursor,
        category,
        selfId,
      );

      const services = await fetchServicesBatch(
        conditions,
        orderBy,
        limit * 2,
      );

      if (services.length === 0) {
        dbExhausted = true;
        break;
      }
      if (services.length < limit * 2) {
        dbExhausted = true;
      }

      const talosIds = Array.from(new Set(services.map((s) => s.talosId)));
      const reputations = await fetchReputations(talosIds, new Date());

      for (const service of services) {
        const valid = isValidService(
          service,
          reputations,
          minScore,
          minConfidence,
          allowColdStart,
        );

        const advanced: ServiceCursor = {
          createdAt: service.createdAt.toISOString(),
          id: service.id,
        };

        if (valid && accumulated.length < limit) {
          accumulated.push(toServiceResult(service));
          pageCursor = advanced;
        } else if (valid && accumulated.length === limit) {
          hasMore = true;
        }

        currentCursor = advanced;

        if (accumulated.length === limit && hasMore) {
          break;
        }
      }
    }

    const nextCursor =
      accumulated.length === limit && hasMore ? pageCursor : null;

    return Response.json({
      data: accumulated,
      nextCursor: nextCursor ? encodeServiceCursor(nextCursor) : null,
    });
  } catch {
    return internalError(request);
  }
}

function buildConditions(
  cursor: ServiceCursor | null,
  category: string | null,
  selfId: string | null,
) {
  const conditions = [eq(tlsTalos.status, "Active")];

  if (selfId) {
    conditions.push(ne(tlsCommerceServices.talosId, selfId));
  }

  if (category) {
    conditions.push(ilike(tlsTalos.category, category));
  }

  if (cursor) {
    const cursorCondition = or(
      lt(tlsCommerceServices.createdAt, new Date(cursor.createdAt)),
      and(
        eq(tlsCommerceServices.createdAt, new Date(cursor.createdAt)),
        lt(tlsCommerceServices.id, cursor.id),
      ),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  return conditions;
}

function fetchServicesBatch(
  conditions: ReturnType<typeof buildConditions>,
  orderBy: SQL[],
  batchSize: number,
) {
  return db
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
    .orderBy(...orderBy)
    .limit(batchSize);
}

function isValidService(
  service: ServiceRow,
  reputations: Map<
    string,
    { evidence: string; score?: number; confidence?: number }
  >,
  minScore: number | undefined,
  minConfidence: number | undefined,
  allowColdStart: boolean,
): boolean {
  if (
    minScore === undefined &&
    minConfidence === undefined &&
    !allowColdStart
  ) {
    return true;
  }

  const rep = reputations.get(service.talosId);
  if (rep) {
    if (rep.evidence === "insufficient") {
      return allowColdStart;
    }
    if (
      minScore !== undefined &&
      (rep.score === undefined || rep.score < minScore)
    ) {
      return false;
    }
    if (
      minConfidence !== undefined &&
      (rep.confidence === undefined || rep.confidence < minConfidence)
    ) {
      return false;
    }
    return true;
  }

  return allowColdStart;
}

function toServiceResult(service: ServiceRow): ServiceResult {
  return {
    talosId: service.talosId,
    talosName: service.talosName,
    talosCategory: service.talosCategory,
    serviceName: service.serviceName,
    description: service.description,
    price: Number(service.price),
    currency: service.currency,
    chains: service.chains,
  };
}

export const GET = withTraceContext(handleGet);
