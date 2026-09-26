export interface CapabilityFilter {
  id: string;
  name: string;
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