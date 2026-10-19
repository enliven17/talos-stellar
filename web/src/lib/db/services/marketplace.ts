import { eq, and, ilike, inArray, count } from 'drizzle-orm';
import { db } from '@/db';
import { capabilities, marketplaceItems, itemCapabilities } from '@/db/schema';
import type { CapabilityFilter, MarketplaceSearchResult, MarketplaceSearchResponse } from '@/app/api/marketplace/search/types';

export async function getCapabilityFilters(): Promise<CapabilityFilter[]> {
  try {
    const filters = await db
      .select()
      .from(capabilities)
      .orderBy(capabilities.sortOrder);
    return filters as CapabilityFilter[];
  } catch (error) {
    console.error('getCapabilityFilters error:', error);
    return [];
  }
}

export async function searchMarketplace(opts: {
  search: string;
  category?: string;
  capability?: string;
  limit?: number;
  offset?: number;
}): Promise<MarketplaceSearchResponse> {
  const { search, category, capability, limit = 20, offset = 0 } = opts;
  try {
    const [result] = await db
      .select({
        id: marketplaceItems.id,
        name: marketplaceItems.name,
        description: marketplaceItems.description,
        category: marketplaceItems.category,
        capability: marketplaceItems.capability,
        price: marketplaceItems.price,
        imageUrl: marketplaceItems.imageUrl,
        slug: marketplaceItems.slug,
        featured: marketplaceItems.featured,
        createdAt: marketplaceItems.createdAt,
        updatedAt: marketplaceItems.updatedAt,
      })
      .from(marketplaceItems)
      .where(
        and(
          ilike(marketplaceItems.name, `%${search}%`),
          category ? eq(marketplaceItems.category, category) : undefined,
          capability ? eq(marketplaceItems.capability, capability) : undefined,
        ),
      )
      .limit(limit)
      .offset(offset);

    return {
      items: result ? [result] : [],
      total: result ? 1 : 0,
      limit,
      offset,
    };
  } catch (error) {
    console.error('searchMarketplace error:', error);
    throw error;
  }
}
