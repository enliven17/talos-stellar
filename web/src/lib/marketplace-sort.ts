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

// ---------------------------------------------------------------------------
// Directory (GET /api/talos) — sort fields and filter validators
// ---------------------------------------------------------------------------

/** Allowed sort fields for the Talos directory endpoint. */
export const DIRECTORY_SORT_FIELDS = ["createdAt", "name"] as const;
export type DirectorySortField = (typeof DIRECTORY_SORT_FIELDS)[number];

/**
 * Valid `status` filter values for the Talos directory.
 * "Deleted" is intentionally excluded from the public-facing filter set.
 */
export const DIRECTORY_STATUS_FILTER = ["Active", "Retired"] as const;
export type DirectoryStatusFilter = (typeof DIRECTORY_STATUS_FILTER)[number];

/**
 * Parse and validate the `status` filter for the talos directory.
 *
 * - Absent (`null`) → `{ ok: true, status: null }` (no filter applied)
 * - Empty string  → 400
 * - Unknown value → 400
 * - Valid value   → `{ ok: true, status: <value> }`
 */
export function parseDirectoryStatusFilter(
  raw: string | null,
): { ok: true; status: DirectoryStatusFilter | null } | { ok: false; response: Response } {
  if (raw === null) return { ok: true, status: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "status must be a non-empty string" },
        { status: 400 },
      ),
    };
  }
  if (!DIRECTORY_STATUS_FILTER.includes(trimmed as DirectoryStatusFilter)) {
    return {
      ok: false,
      response: Response.json(
        {
          error: `Invalid status filter. Supported values: ${DIRECTORY_STATUS_FILTER.join(", ")}`,
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, status: trimmed as DirectoryStatusFilter };
}

/**
 * Parse and validate the `category` filter for the talos directory.
 *
 * - Absent (`null`) → `{ ok: true, category: null }` (no filter applied)
 * - Empty string   → 400
 * - > 128 chars    → 400
 * - Valid string   → `{ ok: true, category: <trimmed> }`
 */
export function parseDirectoryCategoryFilter(
  raw: string | null,
): { ok: true; category: string | null } | { ok: false; response: Response } {
  if (raw === null) return { ok: true, category: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "category must be a non-empty string" },
        { status: 400 },
      ),
    };
  }
  if (trimmed.length > 128) {
    return {
      ok: false,
      response: Response.json(
        { error: "category must be 128 characters or fewer" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, category: trimmed };
}
