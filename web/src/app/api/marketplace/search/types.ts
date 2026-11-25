export interface CapabilityFilter {
  id: string;
  name: string;
  version: number;
  description: string;
  category: string;
  isActive: boolean;
}

export interface MarketplaceSearchQuery {
  query?: string;
  capabilities?: string[];
  page?: number;
  limit?: number;
}

export interface MarketplaceSearchResult {
  id: string;
  title: string;
  description: string;
  capabilities: string[];
  price: number;
  currency: string;
  provider: string;
  rating: number;
  createdAt: string;
}

export interface MarketplaceSearchResponse {
  results: MarketplaceSearchResult[];
  total: number;
  page: number;
  limit: number;
  filters: {
    capabilities: CapabilityFilter[];
  };
}

/**
 * HTTP 400 body for a rejected capability filter. `code` distinguishes a
 * malformed value (`invalid_filter`) from a well-formed request for
 * capabilities that are not active (`unsupported_capability`). A valid filter
 * with no matching items is not an error and returns an empty `results` list.
 */
export type {
  MarketplaceFilterErrorCode,
  MarketplaceFilterValidationError,
} from '@/lib/marketplace-sort';
