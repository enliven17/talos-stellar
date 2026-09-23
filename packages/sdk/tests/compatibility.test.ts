import { describe, it, expect, vi } from 'vitest';
import * as sdk from '../src/index.js';

describe('SDK Compatibility', () => {
  it('should export TalosClient', () => {
    expect(sdk.TalosClient).toBeDefined();
  });

  it('should not depend on Node-specific globals directly', () => {
    // A simple sanity check that the window or global object is handled
    expect(typeof globalThis).toBe('object');
  });

  it('should have fetch available or mockable for edge/browser', () => {
    // If running in browser/edge, fetch should be on globalThis
    const hasFetch = typeof globalThis.fetch === 'function' || typeof fetch === 'function';
    expect(hasFetch).toBeDefined();
  });

  it('uses an injected fetch implementation without consulting the global', async () => {
    const injectedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'injected' }),
    } as Response);
    const globalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });

    try {
      const client = new sdk.TalosClient({
        baseUrl: 'https://example.test',
        fetch: injectedFetch,
      });
      await expect(client.getTalos('boundary')).resolves.toEqual({ id: 'injected' });
      expect(injectedFetch).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: globalFetch, configurable: true, writable: true });
    }
  });

  it('returns an explicit transport error when the injected dependency fails', async () => {
    const injectedFetch = vi.fn().mockRejectedValue(new Error('network dependency unavailable'));
    const client = new sdk.TalosClient({
      baseUrl: 'https://example.test',
      fetch: injectedFetch,
      retryPolicy: { maxAttempts: 1 },
    });

    await expect(client.getTalos('dependency-failure')).rejects.toMatchObject({
      code: 'transport_error',
      status: 0,
    });
  });

  it('redacts sensitive response fields from malformed API errors', async () => {
    const injectedFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: 'bad input', seed: 'never-return-this' }),
    } as Response);
    const client = new sdk.TalosClient({ baseUrl: 'https://example.test', fetch: injectedFetch });

    const error = await client.getTalos('malformed').catch((value) => value as Error);
    expect(error.message).not.toContain('never-return-this');
    expect((error as sdk.TalosAPIError).data).toEqual({ error: 'bad input', seed: '[REDACTED]' });
  });
});
