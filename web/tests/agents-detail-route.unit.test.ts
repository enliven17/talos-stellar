import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => {
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.where = vi.fn(self);
    chain.limit = vi.fn(() => Promise.resolve(result));
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  return { dbSelect, makeSelectChain };
});

vi.mock('@/db', () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

import { GET } from '@/app/api/agents/[id]/route';
import { generateETag } from '@/lib/etag';

describe('GET /api/agents/[id]', () => {
  const mockAgent = {
    id: 'agent-123',
    name: 'Talos Alpha',
    description: 'Autonomous trading agent',
    status: 'Active',
    category: 'DeFi',
    agentName: 'talos-alpha',
    onChainId: 42,
    stellarAssetCode: 'ALPHA',
    tokenSymbol: 'ALP',
    pulsePrice: '1.250000',
    totalSupply: 1000000,
    creatorShare: 60,
    investorShare: 25,
    treasuryShare: 15,
    persona: 'Prudent Risk-Taker',
    targetAudience: 'DeFi Traders',
    channels: ['telegram', 'discord'],
    toneVoice: 'Analytical',
    approvalThreshold: '10.00',
    gtmBudget: '200.00',
    minPatronPulse: 50,
    agentOnline: true,
    agentLastSeen: new Date('2026-03-30T10:00:00Z'),
    retiredAt: null,
    retiredReason: null,
    supersededBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-03-30T10:00:00Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with public agent fields only', async () => {
    mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([mockAgent]));

    const req = new NextRequest('http://localhost:3000/api/agents/agent-123');
    const res = await GET(req, { params: Promise.resolve({ id: 'agent-123' }) });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe('agent-123');
    expect(body.name).toBe('Talos Alpha');
    expect(body.description).toBe('Autonomous trading agent');
    expect(body.status).toBe('Active');

    // Verify sensitive fields are not present
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('keyHash');
    expect(body).not.toHaveProperty('agentWalletId');
    expect(body).not.toHaveProperty('agentWalletAddress');
    expect(body).not.toHaveProperty('walletPublicKey');

    // Headers
    expect(res.headers.get('ETag')).toBeDefined();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('returns 304 when If-None-Match matches the ETag', async () => {
    mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([mockAgent]));

    const responseBody = JSON.stringify(mockAgent);
    const etag = generateETag(responseBody);

    const req = new NextRequest('http://localhost:3000/api/agents/agent-123', {
      headers: {
        'if-none-match': etag,
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: 'agent-123' }) });

    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('returns 404 with standard error envelope when agent is not found', async () => {
    mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));

    const req = new NextRequest('http://localhost:3000/api/agents/unknown-id', {
      headers: {
        'x-request-id': 'req-not-found-1',
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: 'unknown-id' }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Agent not found',
      requestId: 'req-not-found-1',
    });
    expect(body).not.toHaveProperty('error');
  });

  it('returns 400 with standard error envelope when id is malformed', async () => {
    const req = new NextRequest('http://localhost:3000/api/agents/%20', {
      headers: {
        'x-request-id': 'req-bad-id-1',
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: '   ' }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid agent ID',
      requestId: 'req-bad-id-1',
    });
    expect(body).not.toHaveProperty('error');
  });
});
