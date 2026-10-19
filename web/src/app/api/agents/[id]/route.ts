import { NextRequest, NextResponse } from 'next/server';
import { getAgentById } from '@/lib/db/agents';
import { generateETag, isETagMatch } from '@/lib/etag';
import { badRequest, notFound } from '@/lib/api-response';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const resolvedParams = await params;
  const id = resolvedParams?.id;

  if (!id || typeof id !== 'string' || id.trim().length === 0 || /\s/.test(id)) {
    return badRequest(request, 'Invalid agent ID');
  }

  const agent = await getAgentById(id);

  if (!agent) {
    return notFound(request, 'Agent not found');
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