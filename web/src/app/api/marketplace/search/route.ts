import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchMarketplaceItems, getCapabilityFilters } from '@/lib/db/services/marketplace';
import { parsePriceRange } from '@/lib/parse-price';
import {
  marketplaceFilterErrorResponse,
  parseCapabilityFilter,
  validateSupportedCapabilities,
} from '@/lib/marketplace-sort';
import type { CapabilityFilter, MarketplaceSearchResponse } from './types';

/**
 * GET /api/marketplace/search — search marketplace items.
 *
 * Query parameters:
 *   - q: title substring.
 *   - capabilities: JSON array of capability IDs (`["id-1","id-2"]`) or a
 *     comma-separated list. Absent, empty, or `[]` means no capability filter.
 *   - page, limit: pagination (limit clamped to [1, 100], default 20).
 *   - minPrice, maxPrice: exact USDC price range (see `parsePriceRange`).
 *
 * Responses:
 *   200 MarketplaceSearchResponse — including an ordinary empty `results`
 *       list when valid filters match nothing.
 *   400 MarketplaceFilterValidationError for a rejected capability filter:
 *       `code: "invalid_filter"` when the value is malformed, or
 *       `code: "unsupported_capability"` (with `unsupportedCapabilities`)
 *       when it names IDs that are not active capabilities. Price errors
 *       use the `parsePriceRange` field-error shape.
 *   500 { error: "Internal server error" }
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');

    const parsedPrice = parsePriceRange(
      searchParams.get('minPrice'),
      searchParams.get('maxPrice'),
    );
    if (!parsedPrice.ok) {
      return parsedPrice.response;
    }

    const parsedCapabilities = parseCapabilityFilter(searchParams.get('capabilities'));
    if (!parsedCapabilities.ok) {
      return marketplaceFilterErrorResponse(parsedCapabilities.error);
    }

    const page = Math.max(1, parseInt(pageParam || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(limitParam || '20', 10)));

    // A capability filter is validated against the active vocabulary before
    // searching, so an unsupported capability is a typed 400 rather than an
    // empty result indistinguishable from "no matches".
    let capabilityFilters: CapabilityFilter[] | undefined;
    const capabilityIds = parsedCapabilities.capabilityIds;
    if (capabilityIds.length > 0) {
      capabilityFilters = await getCapabilityFilters();
      const supported = validateSupportedCapabilities(
        capabilityIds,
        capabilityFilters.map((cap) => cap.id),
      );
      if (!supported.ok) {
        return marketplaceFilterErrorResponse(supported.error);
      }
    }

    const response: MarketplaceSearchResponse = await searchMarketplaceItems(
      query,
      capabilityIds,
      page,
      limit,
      capabilityFilters,
    );

    return NextResponse.json(response);
  } catch (error) {
    console.error('Marketplace search error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
