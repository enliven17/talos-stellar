import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/db';
import { marketplaceItems } from '@/db/schema';
import { inArray } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const idsParam = searchParams.get('ids');

    if (!idsParam) {
      return NextResponse.json({ error: 'Missing ids parameter' }, { status: 400 });
    }

    const ids = idsParam.split(',').map((id) => id.trim()).filter((id) => id.length > 0);

    if (ids.length === 0) {
      return NextResponse.json({ error: 'Empty ids list' }, { status: 400 });
    }

    // Limit comparison to a reasonable number to prevent DB load issues
    if (ids.length > 10) {
      return NextResponse.json({ error: 'Maximum 10 items can be compared' }, { status: 400 });
    }

    const items = await db
      .select()
      .from(marketplaceItems)
      .where(inArray(marketplaceItems.id, ids));

    const mappedItems = items.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      price: item.price,
      currency: item.currency,
      provider: item.provider,
      rating: item.rating,
      createdAt: item.createdAt.toISOString(),
    }));

    return NextResponse.json({ items: mappedItems });
  } catch (error) {
    console.error('Marketplace compare error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
