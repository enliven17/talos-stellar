import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { searchMarketplaceItems, getCapabilityFilters } from '@/lib/db/services/marketplace';
import type { CapabilityFilter, MarketplaceSearchResponse } from './types';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const capabilitiesParam = searchParams.get('capabilities');
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');

    const page = Math.max(1, parseInt(pageParam || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(limitParam || '20', 10)));

    let capabilityIds: string[] = [];
    if (capabilitiesParam) {
      const parsed = JSON.parse(capabilitiesParam);
      if (Array.isArray(parsed)) {
        capabilityIds = parsed.filter((id: unknown) => typeof id === 'string' && id.length > 0);
      }
    }

    const response: MarketplaceSearchResponse = await searchMarketplaceItems(
      query,
      capabilityIds,
      page,
      limit
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