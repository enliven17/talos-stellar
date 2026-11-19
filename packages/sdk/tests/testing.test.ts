import { describe, it, expect, afterEach } from 'vitest';
import { TalosClient } from '../src/client';
import {
  createMockFetch,
  presets,
  builders,
  type MockRoutes,
} from '../src/testing';

describe('@talos-protocol/sdk/testing', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createMockFetch', () => {
    it('returns a response for a matched route', async () => {
      const mock = createMockFetch({
        'GET /v1/health': () => builders.json({ status: 'ok' }, 200),
      });
      const res = await mock('https://api.talos.protocol/v1/health');
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'ok' });
    });

    it('records calls for assertions', async () => {
      const mock = createMockFetch({
        'POST /v1/jobs': () => builders.json({ id: 'jb_1' }, 201),
      });
      await mock('https://api.talos.protocol/v1/jobs', {
        method: 'POST',
        body: JSON.stringify({ task: 'echo' }),
      });
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0].method).toBe('POST');
      expect(new URL((mock.requests[0] as any).url).pathname).toBe('/v1/jobs');
    });

    it('throws a descriptive error for unmatched routes', async () => {
      const mock = createMockFetch({});
      await expect(mock('https://api.talos.protocol/v1/missing')).rejects.toThrow(
        /no route matched/i,
      );
    });

    it('supports route matching with query strings', async () => {
      const mock = createMockFetch({
        'GET /v1/jobs': () => builders.json({ items: [] }, 200),
      });
      const res = await mock('https://api.talos.protocol/v1/jobs?limit=10');
      expect(res.status).toBe(200);
    });
  });

  describe('presets.x402Challenge', () => {
    it('drives TalosClient through a 402 challenge', async () => {
      const mock = createMockFetch(presets.x402Challenge());
      globalThis.fetch = mock as unknown as typeof fetch;
      const client = new TalosClient({ baseUrl: 'https://api.talos.protocol' });

      const res = await client.request('/v1/jobs', {
        method: 'POST',
        body: JSON.stringify({ task: 'echo hello' }),
      });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.x402Version).toBe('1');
      expect(body.accepts.length).toBeGreaterThan(0);
      expect(mock.requests).toHaveLength(1);
    });
  });

  describe('presets.jobLifecycle', () => {
    it('walks a job from queued to succeeded', async () => {
      const mock = createMockFetch(presets.jobLifecycle());
      globalThis.fetch = mock as unknown as typeof fetch;
      const client = new TalosClient({ baseUrl: 'https://api.talos.protocol' });

      const created = await client.request('/v1/jobs', {
        method: 'POST',
        body: JSON.stringify({ task: 'echo hello' }),
      });
      expect(created.status).toBe(202);
      const createdBody = await created.json();
      expect(createdBody.status).toBe('queued');

      const running = await client.request('/v1/jobs/job_mock_123');
      expect((await running.json()).status).toBe('running');

      const done = await client.request('/v1/jobs/job_mock_123');
      expect((await done.json()).status).toBe('succeeded');
    });
  });

  describe('presets.pagination', () => {
    it('pages through results', async () => {
      const items = [
        { id: 'jb_1' },
        { id: 'jb_2' },
        { id: 'jb_3' },
        { id: 'jb_4' },
        { id: 'jb_5' },
      ];
      const mock = createMockFetch(presets.pagination({ items, pageSize: 2 }));
      globalThis.fetch = mock as unknown as typeof fetch;
      const client = new TalosClient({ baseUrl: 'https://api.talos.protocol' });

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const path = cursor
          ? `/v1/jobs?cursor=${encodeURIComponent(cursor)}&limit=2`
          : '/v1/jobs?limit=2';
        const res = await client.request(path);
        const body = await res.json();
        for (const item of body.items) {
          seen.push(item.id);
        }
        cursor = body.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toEqual(['jb_1', 'jb_2', 'jb_3', 'jb_4', 'jb_5']);
    });
  });

  describe('presets.errorEnvelope', () => {
    it('returns a structured error envelope', async () => {
      const mock = createMockFetch(
        presets.errorEnvelope({
          status: 422,
          code: 'unprocessable_entity',
          message: 'invalid payload',
        }),
      );
      globalThis.fetch = mock as unknown as typeof fetch;
      const client = new TalosClient({ baseUrl: 'https://api.talos.protocol' });

      const res = await client.request('/v1/jobs', { method: 'POST', body: '{}' });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('unprocessable_entity');
      expect(body.error.message).toBe('invalid payload');
    });
  });

  describe('builders', () => {
    it('builds json responses', async () => {
      const res = builders.json({ a: 1 }, 200);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      await expect(res.json()).resolves.toEqual({ a: 1 });
    });

    it('builds text responses', async () => {
      const res = builders.text('hi', 200);
      await expect(res.text()).resolves.toBe('hi');
    });

    it('builds empty responses', async () => {
      const res = builders.empty(204);
      expect(res.status).toBe(204);
      await expect(res.text()).resolves.toBe('');
    });
  });

  describe('type exports', () => {
    it('exposes MockRoutes type', () => {
      const routes: MockRoutes = {
        'GET /v1/health': () => builders.json({}, 200),
      };
      expect(Object.keys(routes)).toEqual(['GET /v1/health']);
    });
  });
});
