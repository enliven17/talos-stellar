import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db/agents';
import { generateETag, isETagMatch } from '@/lib/etag';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { error: 'Invalid agent ID' },
      { status: 400 }
    );
  }

  const agent = await getAgentById(id);

  if (!agent) {
    return NextResponse.json(
      { error: 'Agent not found' },
      { status: 404 }
    );
  }

  const responseBody = JSON.stringify(agent);
  const etag = generateETag(responseBody);

  const ifNoneMatch = request.headers.get('if-none-match');

  if (ifNoneMatch && isETagMatch(ifNoneMatch, responseBody)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        'ETag': etag,
        'Cache-Control': 'public, max-age=60',
      },
    });
  }

  return NextResponse.json(agent, {
    headers: {
      'ETag': etag,
      'Cache-Control': 'public, max-age=60',
    },
  });
}