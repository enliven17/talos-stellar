import { eq, and, ilike, inArray, count } from 'drizzle-orm';
import { db } from '../db';
import { capabilities, marketplaceItems, itemCapabilities } from '../schema/marketplace';
import type { CapabilityFilter, MarketplaceSearchResult, MarketplaceSearchResponse } from '@/app/api/marketplace/search/types';

export async function getCapabilityFilters(): Promise<CapabilityFilter[]> {
  try {
    const filters = await db
      .select()
      .from(capabilities)
      .where(eq(capabilities.isActive, true))
      .orderBy(capabilities.name);

    return filters.map((cap) => ({
      id: cap.id,
      name: cap.name,
      description: cap.description,
      category: cap.category,
      isActive: cap.isActive,
    }));
  } catch (error) {
    console.error('Failed to fetch capability filters:', error);
    throw new Error('Failed to fetch capability filters');
  }
}

export async function searchMarketplaceItems(
  query: string,
  capabilityIds: string[],
  page: number,
  limit: number
): Promise<MarketplaceSearchResponse> {
  try {
    const offset = (page - 1) * limit;
    const safeQuery = `%${query}%`;

    let results = [];
    let totalCount = 0;

    if (capabilityIds.length > 0) {
      const itemIds = await db
        .select({ id: marketplaceItems.id })
        .from(marketplaceItems)
        .innerJoin(itemCapabilities, eq(marketplaceItems.id, itemCapabilities.itemId))
        .where(
          and(
            ilike(marketplaceItems.title, safeQuery),
            inArray(itemCapabilities.capabilityId, capabilityIds)
          )
        )
        .groupBy(marketplaceItems.id);

      const ids = itemIds.map((item) => item.id);

      if (ids.length > 0) {
        results = await db
          .select()
          .from(marketplaceItems)
          .where(inArray(marketplaceItems.id, ids))
          .limit(limit)
          .offset(offset);

        const countResult = await db
          .select({ count: count() })
          .from(marketplaceItems)
          .where(inArray(marketplaceItems.id, ids));

        totalCount = countResult[0].count;
      }
    } else {
      results = await db
        .select()
        .from(marketplaceItems)
        .where(ilike(marketplaceItems.title, safeQuery))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(marketplaceItems)
        .where(ilike(marketplaceItems.title, safeQuery));

      totalCount = countResult[0].count;
    }

    const capabilitiesList = await getCapabilityFilters();

    const mappedResults: MarketplaceSearchResult[] = results.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      capabilities: [],
      price: item.price,
      currency: item.currency,
      provider: item.provider,
      rating: item.rating,
      createdAt: item.createdAt.toISOString(),
    }));

    return {
      results: mappedResults,
      total: totalCount,
      page,
      limit,
      filters: {
        capabilities: capabilitiesList,
      },
    };
  } catch (error) {
    console.error('Failed to search marketplace items:', error);
    throw new Error('Failed to search marketplace items');
  }
}