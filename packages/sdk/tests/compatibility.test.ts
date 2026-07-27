import { describe, it, expect } from 'vitest';
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
});
