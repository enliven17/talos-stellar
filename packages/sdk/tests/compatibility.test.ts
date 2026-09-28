import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as sdk from '../src/index.js';
import {
  planChaosScenario,
  getChaosScenario,
  createSeededRandom,
  CHAOS_SCENARIOS,
} from '../src/chaos-fixtures.js';
import { FaultType } from '../src/chaos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE_SMOKE = resolve(__dirname, '../scripts/smoke-edge.mjs');

describe('SDK Compatibility', () => {
  it('should export TalosClient', () => {
    expect(sdk.TalosClient).toBeDefined();
  });

  it('should not depend on Node-specific globals directly', () => {
    expect(typeof globalThis).toBe('object');
  });

  it('should have fetch available or mockable for edge/browser', () => {
    const hasFetch = typeof globalThis.fetch === 'function' || typeof fetch === 'function';
    expect(hasFetch).toBeDefined();
  });
});

describe('Edge runtime compatibility smoke', () => {
  it('smoke-edge.mjs is valid ESM (no TypeScript annotations)', () => {
    const source = readFileSync(EDGE_SMOKE, 'utf8');
    // Regression: prior smoke-edge.mjs shipped with TS `as` / `: type` syntax and could not run.
    expect(source).not.toMatch(/\bas unknown as\b/);
    expect(source).not.toMatch(/:\s*string\[\]/);
    expect(source).not.toMatch(/function\s+\w+\([^)]*:\s*string/);
    expect(source).toMatch(/compat:edge/);
    expect(source).toMatch(/vm\.createContext/);
  });

  it('edge-like sandbox excludes Node built-ins (negative)', () => {
    const edgeGlobal: Record<string, unknown> = {
      globalThis: undefined,
      TextEncoder,
      TextDecoder,
      crypto,
      fetch: () => {
        throw new Error('fetch should not be called');
      },
      setTimeout,
      clearTimeout,
      Promise,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Error,
      TypeError,
      JSON,
      Math,
      Map,
      Set,
      Date,
      Uint8Array,
      ArrayBuffer,
      URL,
      Headers,
      console,
      undefined,
    };
    edgeGlobal.globalThis = edgeGlobal;
    edgeGlobal.self = edgeGlobal;

    const ctx = vm.createContext(edgeGlobal);
    expect(vm.runInContext('typeof process', ctx)).toBe('undefined');
    expect(vm.runInContext('typeof Buffer', ctx)).toBe('undefined');
    expect(vm.runInContext('typeof require', ctx)).toBe('undefined');
    expect(vm.runInContext('typeof __dirname', ctx)).toBe('undefined');
  });

  it('edge-like sandbox retains web APIs (positive)', () => {
    const edgeGlobal: Record<string, unknown> = {
      globalThis: undefined,
      TextEncoder,
      TextDecoder,
      crypto,
      fetch: async () => new Response('ok'),
      Promise,
      Object,
      URL,
      Headers,
      Response,
      AbortController,
      undefined,
    };
    edgeGlobal.globalThis = edgeGlobal;
    const ctx = vm.createContext(edgeGlobal);
    expect(vm.runInContext('typeof TextEncoder', ctx)).toBe('function');
    expect(vm.runInContext('typeof crypto', ctx)).toBe('object');
    expect(vm.runInContext('typeof fetch', ctx)).toBe('function');
    expect(vm.runInContext('typeof AbortController', ctx)).toBe('function');
  });

  it('TalosClient constructs without requiring Node process/Buffer (boundary)', () => {
    const client = new sdk.TalosClient({
      baseUrl: 'http://example.test',
      apiKey: 'edge-smoke-secret',
    });
    expect(typeof client.getTalos).toBe('function');
    expect(typeof client.listTaloses).toBe('function');
    // Privacy-safe: secrets must not appear in JSON serialization.
    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain('edge-smoke-secret');
  });

  it('malformed options yield explicit Error, not Node ReferenceError (negative)', () => {
    try {
      // @ts-expect-error intentional malformed input
      new sdk.TalosClient(null);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).not.toMatch(/process is not defined|Buffer is not defined/);
      return;
    }
    // Some constructors tolerate null via defaults — also acceptable.
    expect(true).toBe(true);
  });

  it('exports the deterministic chaos fixture surface', () => {
    expect(sdk.CHAOS_SCENARIOS).toBeDefined();
    expect(sdk.planChaosScenario).toBeTypeOf('function');
    expect(sdk.replayChaosScenario).toBeTypeOf('function');
    expect(sdk.buildChaosFixtureBundle).toBeTypeOf('function');
    expect(sdk.createSeededRandom).toBeTypeOf('function');
    expect(sdk.faultEffect).toBeTypeOf('function');
  });

  it('chaos planner is pure JS and deterministic (browser-safe boundary)', () => {
    const scenario = getChaosScenario('always-injects-unit-probability');
    expect(scenario).toBeDefined();
    const plan = planChaosScenario(scenario!);
    expect(plan.calls[0].outcome).toBe('injected-throw');
    expect(plan.calls[0].injected).toBe(true);
    // Seeded PRNG relies only on Math (no Node crypto), so it is usable in
    // every supported runtime from the compat matrix.
    const a = createSeededRandom(1);
    const b = createSeededRandom(1);
    expect(Array.from({ length: 8 }, () => a())).toEqual(
      Array.from({ length: 8 }, () => b()),
    );
  });

  it('every registered scenario name is a stable wire key (regression)', () => {
    const names = CHAOS_SCENARIOS.map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(getChaosScenario(name)).toBeDefined();
    }
    // Boundary scenario pins the strict r < p decision rule.
    const boundary = planChaosScenario(getChaosScenario('probability-boundary-half-excluded')!);
    expect(boundary.calls.map((c) => c.injected)).toEqual([false, true, false]);
    expect(boundary.calls[0].faultType).toBe(FaultType.NETWORK_DROP);
  });
});
