/**
 * Shared marketplace sort parser for the list API endpoints.
 *
 * The marketplace endpoints (`GET /api/services`, `GET /api/playbooks`)
 * accept `sort` (field) and `direction` (asc|desc) query parameters.
 *
 * Rules:
 * - When a parameter is absent, the deterministic default is used
 *   (`createdAt` descending) so omitted parameters remain stable and
 *   cursor-compatible.
 * - Unknown sort fields and directions are rejected with a 400 response so
 *   invalid values never reach the query builder.
 * - Cursor pagination is only compatible with the default `createdAt desc`
 *   ordering; routes reject a cursor combined with any other sort via
 *   `isDefaultMarketplaceSort`.
 */
import { createHash } from "node:crypto";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { asc, desc } from "drizzle-orm";

export const MARKETPLACE_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type MarketplaceSortDirection =
  (typeof MARKETPLACE_SORT_DIRECTIONS)[number];

export const SERVICES_SORT_FIELDS = ["createdAt", "price"] as const;
export type ServicesSortField = (typeof SERVICES_SORT_FIELDS)[number];

export const PLAYBOOKS_SORT_FIELDS = ["createdAt", "price", "title"] as const;
export type PlaybooksSortField = (typeof PLAYBOOKS_SORT_FIELDS)[number];

export const DEFAULT_MARKETPLACE_SORT_FIELD = "createdAt";
export const DEFAULT_MARKETPLACE_SORT_DIRECTION = "desc";

export interface MarketplaceSort<TField extends string> {
  field: TField;
  direction: MarketplaceSortDirection;
}

export interface MarketplaceSortConfig<TField extends string> {
  allowedFields: readonly TField[];
  fieldLabel: string;
}

export type ParseMarketplaceSortResult<TField extends string> =
  | { ok: true; sort: MarketplaceSort<TField> }
  | { ok: false; response: Response };

/**
 * Parse and validate `sort` and `direction` query values.
 *
 * Returns `{ ok: false; response }` for unknown fields/directions (HTTP 400)
 * and `{ ok: true; sort }` with the deterministic defaults filled in when the
 * parameters are omitted.
 */
export function parseMarketplaceSort<TField extends string>(
  rawField: string | null,
  rawDirection: string | null,
  config: MarketplaceSortConfig<TField>,
): ParseMarketplaceSortResult<TField> {
  if (
    rawField !== null &&
    !config.allowedFields.includes(rawField as TField)
  ) {
    return {
      ok: false,
      response: Response.json(
        { error: `Invalid sort field. Supported fields: ${config.fieldLabel}` },
        { status: 400 },
      ),
    };
  }

  if (
    rawDirection !== null &&
    !MARKETPLACE_SORT_DIRECTIONS.includes(
      rawDirection as MarketplaceSortDirection,
    )
  ) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "Invalid sort direction. Supported directions: asc, desc",
        },
        { status: 400 },
      ),
    };
  }

  const field = (
    rawField === null || rawField === "" ? DEFAULT_MARKETPLACE_SORT_FIELD : rawField
  ) as TField;
  const direction =
    rawDirection === null || rawDirection === ""
      ? DEFAULT_MARKETPLACE_SORT_DIRECTION
      : (rawDirection as MarketplaceSortDirection);

  return { ok: true, sort: { field, direction } };
}

/**
 * True only for the default `createdAt desc` ordering, which is the ordering
 * the `createdAt|id` cursor pagination scheme is compatible with.
 */
export function isDefaultMarketplaceSort<TField extends string>(
  sort: MarketplaceSort<TField>,
): boolean {
  return (
    sort.field === DEFAULT_MARKETPLACE_SORT_FIELD &&
    sort.direction === DEFAULT_MARKETPLACE_SORT_DIRECTION
  );
}

/**
 * Build the drizzle `orderBy` clauses for a validated marketplace sort.
 *
 * The selected column is ordered by the requested direction and `id` is
 * appended as a deterministic tiebreaker so the ordering is always total and
 * stable across pages.
 */
export function buildMarketplaceOrderBy<TField extends string>(
  sort: MarketplaceSort<TField>,
  columns: Record<TField, SQLWrapper>,
  idColumn: SQLWrapper,
): SQL[] {
  const order = sort.direction === "asc" ? asc : desc;
  return [order(columns[sort.field]), desc(idColumn)];
}

// ─── Ranked cursor (sort + filter-bound) ─────────────────────────────────────

/**
 * Encode a cursor that binds sort + filter identity.
 *
 * The cursor carries: sort field, sort direction, filterHash, createdAt, and
 * id.  Any change in sort or filters invalidates the cursor so stale pages
 * never silently skip or duplicate rows.
 */
export interface RankedMarketplaceCursor {
  sortField: string;
  sortDirection: MarketplaceSortDirection;
  /** SHA-256 hex of the canonical filter string. */
  filterHash: string;
  /** ISO timestamp of the last item on the previous page (for createdAt). */
  createdAt: string;
  /** id of the last item on the previous page (tiebreaker). */
  id: string;
}

/** base64url-encode a RankedMarketplaceCursor. */
export function encodeRankedCursor(cursor: RankedMarketplaceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode a base64url cursor string.
 * Returns null for any input that is not a structurally valid
 * RankedMarketplaceCursor (parse errors, missing fields, bad date).
 */
export function decodeRankedCursor(raw: string): RankedMarketplaceCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<RankedMarketplaceCursor>;

    if (
      typeof parsed.sortField !== "string" ||
      parsed.sortField.length === 0 ||
      typeof parsed.sortDirection !== "string" ||
      !MARKETPLACE_SORT_DIRECTIONS.includes(
        parsed.sortDirection as MarketplaceSortDirection,
      ) ||
      typeof parsed.filterHash !== "string" ||
      parsed.filterHash.length === 0 ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }

    return {
      sortField: parsed.sortField,
      sortDirection: parsed.sortDirection as MarketplaceSortDirection,
      filterHash: parsed.filterHash,
      createdAt: new Date(parsed.createdAt).toISOString(),
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

/**
 * Canonical filter hash — SHA-256 hex of a stable JSON string of the filters.
 * Keys are sorted so the hash is order-independent.
 */
export function hashFilters(filters: Record<string, string | null>): string {
  const sorted = Object.keys(filters)
    .sort()
    .reduce<Record<string, string | null>>((acc, key) => {
      acc[key] = filters[key];
      return acc;
    }, {});
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Returns true when the cursor's encoded sort and filter hash match the
 * current request parameters exactly.
 */
export function isCursorCompatible(
  cursor: RankedMarketplaceCursor,
  sort: MarketplaceSort<string>,
  filterHash: string,
): boolean {
  return (
    cursor.sortField === sort.field &&
    cursor.sortDirection === sort.direction &&
    cursor.filterHash === filterHash
  );
}
