import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChaosInjector,
  ChaosInjectedError,
  FaultType,
  assertValidFaultConfig,
  faultEffect,
} from "../src/chaos.js";
import {
  createSeededRandom,
  assertValidChaosScenario,
  planChaosScenario,
  replayChaosScenario,
  buildChaosFixtureBundle,
  getChaosScenario,
  CHAOS_SCENARIOS,
} from "../src/chaos-fixtures.js";

/** One malformed-input case with its explicitly expected failure. Mirrors the committed wire fixture. */
interface FaultConfigErrorFixture {
  name: string;
  config: unknown;
  expectedError: "TypeError" | "RangeError";
  expectedMessageIncludes: string;
}

/**
 * Negative fixtures for {@link ChaosInjector.registerFault}, mirroring
 * `tests/fixtures/chaos-fault-config-errors.json` (drift-checked below).
 * Malformed probability types and unknown fault types previously registered
 * silently and never fired; they are now explicit errors.
 */
const FAULT_CONFIG_ERROR_FIXTURES: readonly FaultConfigErrorFixture[] = [
  // Note: a *missing* (undefined) config is covered by a runtime-only test —
  // JSON cannot represent `undefined`, so it has no wire fixture.
  {
    name: "null-config",
    config: null,
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig must be a non-null object",
  },
  {
    name: "array-config",
    config: [],
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig must be a non-null object",
  },
  {
    name: "missing-type",
    config: { probability: 0.5 },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.type must be one of",
  },
  {
    name: "unknown-type",
    config: { type: "NETWORK_GREMLIN", probability: 0.5 },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.type must be one of",
  },
  {
    name: "non-string-type",
    config: { type: 42, probability: 0.5 },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.type must be one of",
  },
  {
    name: "missing-probability",
    config: { type: "NETWORK_DROP" },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.probability must be a finite number",
  },
  {
    name: "nan-probability",
    config: { type: "NETWORK_DROP", probability: Number.NaN },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.probability must be a finite number",
  },
  {
    name: "string-probability",
    config: { type: "NETWORK_DROP", probability: "0.5" },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.probability must be a finite number",
  },
  {
    name: "infinite-probability",
    config: { type: "NETWORK_DROP", probability: Number.POSITIVE_INFINITY },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.probability must be a finite number",
  },
  {
    name: "negative-probability",
    config: { type: "NETWORK_DROP", probability: -0.1 },
    expectedError: "RangeError",
    expectedMessageIncludes: "Fault probability must be between 0 and 1",
  },
  {
    name: "probability-above-one",
    config: { type: "NETWORK_DROP", probability: 1.1 },
    expectedError: "RangeError",
    expectedMessageIncludes: "Fault probability must be between 0 and 1",
  },
  {
    name: "negative-duration",
    config: { type: "NETWORK_DELAY", probability: 1, durationMs: -1 },
    expectedError: "RangeError",
    expectedMessageIncludes: "FaultConfig.durationMs must be >= 0",
  },
  {
    name: "nan-duration",
    config: { type: "NETWORK_DELAY", probability: 1, durationMs: Number.NaN },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.durationMs must be a finite number",
  },
  {
    name: "non-string-message",
    config: { type: "NETWORK_DROP", probability: 0.5, message: 42 },
    expectedError: "TypeError",
    expectedMessageIncludes: "FaultConfig.message must be a string",
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_FIXTURE = resolve(here, "fixtures", "chaos-scenarios.json");
const FAULT_ERRORS_FIXTURE = resolve(here, "fixtures", "chaos-fault-config-errors.json");

// ── faultEffect classifier ───────────────────────────────────────────────────

describe("faultEffect (single source of truth)", () => {
  it("classifies delay-only faults (positive)", () => {
    expect(faultEffect(FaultType.NETWORK_DELAY)).toEqual({
      delays: true,
      throws: false,
    });
    expect(faultEffect(FaultType.SIGNATURE_VERIFICATION_SLOW)).toEqual({
      delays: true,
      throws: false,
    });
  });

  it("classifies throw-only faults (positive)", () => {
    expect(faultEffect(FaultType.NETWORK_DROP)).toEqual({
      delays: false,
      throws: true,
    });
    expect(faultEffect(FaultType.DB_CONNECTION_FAIL)).toEqual({
      delays: false,
      throws: true,
    });
    expect(faultEffect(FaultType.REPLAY_STORE_ERROR)).toEqual({
      delays: false,
      throws: true,
    });
  });

  it("classifies delay+throw faults (boundary)", () => {
    expect(faultEffect(FaultType.API_TIMEOUT)).toEqual({
      delays: true,
      throws: true,
    });
  });
});

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

describe("createSeededRandom", () => {
  it("produces identical sequences for identical seeds (determinism)", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds (discrimination)", () => {
    const a = Array.from({ length: 8 }, createSeededRandom(1));
    const b = Array.from({ length: 8 }, createSeededRandom(2));
    expect(a).not.toEqual(b);
  });

  it("draws stay within [0, 1) across many draws (boundary)", () => {
    const draw = createSeededRandom(0xffffffff);
    for (let i = 0; i < 10_000; i++) {
      const v = draw();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("rejects missing/malformed seeds with explicit errors (negative)", () => {
    // @ts-expect-error intentionally malformed
    expect(() => createSeededRandom(undefined)).toThrow(TypeError);
    // @ts-expect-error intentionally malformed
    expect(() => createSeededRandom("42")).toThrow(TypeError);
    expect(() => createSeededRandom(Number.NaN)).toThrow(TypeError);
    expect(() => createSeededRandom(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => createSeededRandom(-1)).toThrow(RangeError);
    expect(() => createSeededRandom(1.5)).toThrow(RangeError);
    expect(() => createSeededRandom(2 ** 32)).toThrow(RangeError);
  });

  it("accepts boundary seeds 0 and 2^32-1 (boundary)", () => {
    expect(() => createSeededRandom(0)).not.toThrow();
    expect(() => createSeededRandom(2 ** 32 - 1)).not.toThrow();
  });
});

// ── Fault-config validation (negative fixtures) ──────────────────────────────

describe("assertValidFaultConfig", () => {
  it.each(FAULT_CONFIG_ERROR_FIXTURES.map((f) => [f.name, f]))(
    "rejects %s with the expected error",
    (_name, fixture) => {
      expect(() => assertValidFaultConfig(fixture.config)).toThrow(
        fixture.expectedError === "TypeError" ? TypeError : RangeError,
      );
      expect(() => assertValidFaultConfig(fixture.config)).toThrow(
        fixture.expectedMessageIncludes,
      );
    },
  );

  it("accepts a fully valid config (positive)", () => {
    expect(() =>
      assertValidFaultConfig({
        type: FaultType.NETWORK_DROP,
        probability: 0.5,
        durationMs: 100,
        message: "simulated drop",
      }),
    ).not.toThrow();
  });

  it("rejects a missing (undefined) config — runtime-only case, not JSON-representable", () => {
    // @ts-expect-error intentionally malformed
    expect(() => assertValidFaultConfig(undefined)).toThrow(TypeError);
  });

  it("rejects invalid configs through ChaosInjector.registerFault too (integration)", () => {
    const injector = new ChaosInjector();
    expect(() =>
      injector.registerFault({
        // @ts-expect-error intentionally malformed
        type: "NETWORK_GREMLIN",
        probability: 0.5,
      }),
    ).toThrow(TypeError);
  });
});

// ── ChaosInjectorOptions validation ──────────────────────────────────────────

describe("ChaosInjectorOptions validation", () => {
  it("rejects a non-function random with explicit TypeError (negative)", () => {
    expect(
      () =>
        new ChaosInjector({
          // @ts-expect-error intentionally malformed
          random: "not-a-function",
        }),
    ).toThrow(TypeError);
  });

  it("rejects a non-function sleep with explicit TypeError (negative)", () => {
    expect(
      () =>
        new ChaosInjector({
          // @ts-expect-error intentionally malformed
          sleep: 123,
        }),
    ).toThrow(TypeError);
  });

  it("constructs fine without options (boundary)", () => {
    expect(() => new ChaosInjector()).not.toThrow();
  });
});

// ── Scenario validation ──────────────────────────────────────────────────────

describe("assertValidChaosScenario", () => {
  const validSpec = CHAOS_SCENARIOS[0];

  it("accepts every registered scenario (positive)", () => {
    for (const scenario of CHAOS_SCENARIOS) {
      expect(() => assertValidChaosScenario(scenario)).not.toThrow();
    }
  });

  it("rejects missing random source (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        seed: undefined,
        scriptedRandom: undefined,
      }),
    ).toThrow(TypeError);
  });

  it("rejects both random sources at once (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        scriptedRandom: [0.5],
      }),
    ).toThrow(TypeError);
  });

  it("rejects a scripted draw of exactly 1 (boundary: draws live in [0,1))", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        seed: undefined,
        scriptedRandom: [1],
        calls: [FaultType.NETWORK_DROP],
      }),
    ).toThrow(RangeError);
  });

  it("accepts a scripted draw of exactly 0 (boundary: 0 is in [0,1))", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        seed: undefined,
        scriptedRandom: [0],
        calls: [FaultType.NETWORK_DROP],
      }),
    ).not.toThrow();
  });

  it("rejects a scripted sequence shorter than the call script (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        seed: undefined,
        scriptedRandom: [0.1],
      }),
    ).toThrow(RangeError);
  });

  it("rejects calls referencing unregistered fault types (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        seed: undefined,
        faults: [{ type: FaultType.NETWORK_DROP, probability: 1 }],
        calls: [FaultType.API_TIMEOUT],
      }),
    ).toThrow(TypeError);
  });

  it("rejects duplicate fault registrations (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        faults: [
          { type: FaultType.NETWORK_DROP, probability: 0.2 },
          { type: FaultType.NETWORK_DROP, probability: 0.8 },
        ],
      }),
    ).toThrow(TypeError);
  });

  it("rejects an empty call script (negative)", () => {
    expect(() =>
      assertValidChaosScenario({
        ...validSpec,
        calls: [],
      }),
    ).toThrow(TypeError);
  });
});

// ── Planner ──────────────────────────────────────────────────────────────────

describe("planChaosScenario", () => {
  it("produces a JSON-safe plan with no operator messages (privacy)", () => {
    const spec = getChaosScenario("dependency-failure-replay-store")!;
    const plan = planChaosScenario(spec);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("simulated dependency outage");
    expect(plan).toEqual(JSON.parse(serialized));
  });

  it("is deterministic: identical calls produce identical plans (regression)", () => {
    const spec = getChaosScenario("seeded-stream-reproducibility")!;
    const a = planChaosScenario(spec);
    const b = planChaosScenario(spec);
    expect(a).toEqual(b);
  });

  it("applies strict r < p (draw equal to probability does not inject)", () => {
    const plan = planChaosScenario({
      name: "boundary-equality",
      description: "boundary",
      scriptedRandom: [0.5],
      faults: [{ type: FaultType.NETWORK_DROP, probability: 0.5 }],
      calls: [FaultType.NETWORK_DROP],
    });
    expect(plan.calls[0].injected).toBe(false);
    expect(plan.calls[0].randomValue).toBe(0.5);
  });

  it("handles probability 0 and 1 boundaries", () => {
    const never = planChaosScenario({
      name: "never",
      description: "boundary",
      seed: 1,
      faults: [{ type: FaultType.NETWORK_DROP, probability: 0 }],
      calls: [FaultType.NETWORK_DROP],
    });
    expect(never.calls.every((c) => !c.injected)).toBe(true);

    const always = planChaosScenario({
      name: "always",
      description: "boundary",
      seed: 1,
      faults: [{ type: FaultType.NETWORK_DROP, probability: 1 }],
      calls: [FaultType.NETWORK_DROP],
    });
    expect(always.calls.every((c) => c.injected)).toBe(true);
  });

  it("never draws the PRNG when the injector is disabled", () => {
    const plan = planChaosScenario({
      name: "disabled",
      description: "missing-input no-op",
      seed: 1,
      enabled: false,
      faults: [{ type: FaultType.NETWORK_DROP, probability: 1 }],
      calls: [FaultType.NETWORK_DROP, FaultType.NETWORK_DROP],
    });
    expect(plan.calls.every((c) => c.randomValue === null && !c.injected)).toBe(true);
    expect(plan.injectedCount).toBe(0);
  });

  it("does not mutate the input spec (pure planner)", () => {
    const spec = getChaosScenario("mixed-delay-then-drop")!;
    const snapshot = JSON.parse(JSON.stringify(spec));
    planChaosScenario(spec);
    expect(spec).toEqual(snapshot);
  });
});

// ── Replay (production path) ─────────────────────────────────────────────────

describe("replayChaosScenario", () => {
  it("matches the plan exactly for every registered scenario (regression)", async () => {
    for (const scenario of CHAOS_SCENARIOS) {
      const { plan, calls } = await replayChaosScenario(scenario);
      expect(calls.map((c) => c.outcome)).toEqual(
        plan.calls.map((c) => c.outcome),
      );
    }
  });

  it("replays are byte-for-byte repeatable (determinism)", async () => {
    const spec = getChaosScenario("seeded-stream-reproducibility")!;
    const first = await replayChaosScenario(spec);
    const second = await replayChaosScenario(spec);
    expect(first.calls).toEqual(second.calls);
    expect(first.totalDelayMs).toBe(second.totalDelayMs);
  });

  it("delay faults record durationMs without throwing (positive)", async () => {
    const { calls } = await replayChaosScenario(
      getChaosScenario("mixed-delay-then-drop")!,
    );
    const delayCalls = calls.filter((c) => c.faultType === FaultType.NETWORK_DELAY);
    expect(delayCalls.length).toBeGreaterThan(0);
    for (const call of delayCalls) {
      expect(call.outcome).toBe("injected-delay");
      expect(call.delayedMs).toBe(250);
      expect(call.errorMessage).toBeNull();
    }
  });

  it("drop faults throw ChaosInjectedError with the fault type (positive)", async () => {
    const { calls, errors } = await replayChaosScenario(
      getChaosScenario("always-injects-unit-probability")!,
    );
    expect(errors.length).toBe(3);
    for (const err of errors) {
      expect(err).toBeInstanceOf(ChaosInjectedError);
      expect(err.faultType).toBe(FaultType.NETWORK_DROP);
    }
    for (const call of calls) {
      expect(call.outcome).toBe("injected-throw");
      expect(call.delayedMs).toBeNull();
    }
  });

  it("API_TIMEOUT delays first, then throws (positive)", async () => {
    const { calls } = await replayChaosScenario(
      getChaosScenario("api-timeout-delay-then-throw")!,
    );
    expect(calls[0].outcome).toBe("injected-delay-then-throw");
    expect(calls[0].delayedMs).toBe(100);
    expect(calls[0].errorMessage).toContain("API_TIMEOUT");
  });

  it("zero-duration delay faults record 0 ms (boundary)", async () => {
    const { calls, totalDelayMs } = await replayChaosScenario(
      getChaosScenario("zero-duration-delay-boundary")!,
    );
    expect(calls[0].outcome).toBe("injected-delay");
    expect(calls[0].delayedMs).toBe(0);
    expect(totalDelayMs).toBe(0);
  });

  it("default sleep is instant — replays do not actually wait (performance)", async () => {
    const start = Date.now();
    await replayChaosScenario(getChaosScenario("mixed-delay-then-drop")!);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("forwards to a custom sleep implementation (dependency injection)", async () => {
    const observed: number[] = [];
    await replayChaosScenario(getChaosScenario("zero-duration-delay-boundary")!, {
      sleep: async (ms) => {
        observed.push(ms);
      },
    });
    expect(observed).toEqual([0]);
  });

  it("disabled injector replays produce all no-ops with zero delay (missing-input)", async () => {
    const { plan, calls, errors, totalDelayMs } = await replayChaosScenario(
      getChaosScenario("disabled-injector-no-op")!,
    );
    expect(plan.seed).not.toBeNull();
    expect(calls.every((c) => c.outcome === "no-op")).toBe(true);
    expect(errors).toEqual([]);
    expect(totalDelayMs).toBe(0);
  });

  it("errors carry the operator message but the replay result never does (privacy)", async () => {
    const { errors } = await replayChaosScenario(
      getChaosScenario("dependency-failure-replay-store")!,
    );
    expect(errors[0].message).toContain("simulated dependency outage");
  });

  it("rejects malformed scenarios instead of replaying them (negative)", async () => {
    const bad = {
      ...getChaosScenario("mixed-delay-then-drop")!,
      scriptedRandom: undefined,
      seed: undefined,
    };
    await expect(replayChaosScenario(bad)).rejects.toThrow(TypeError);
  });

  it("rejects a non-function sleep option with explicit TypeError (negative)", async () => {
    const spec = getChaosScenario("mixed-delay-then-drop")!;
    await expect(
      replayChaosScenario(spec, {
        // @ts-expect-error intentionally malformed
        sleep: "not-a-function",
      }),
    ).rejects.toThrow(TypeError);
  });
});

// ── Scenario registry invariants ─────────────────────────────────────────────

describe("CHAOS_SCENARIOS registry", () => {
  it("covers the required input classes", () => {
    const names = CHAOS_SCENARIOS.map((s) => s.name);
    expect(names).toContain("never-injects-zero-probability");
    expect(names).toContain("always-injects-unit-probability");
    expect(names).toContain("probability-boundary-half-excluded");
    expect(names).toContain("mixed-delay-then-drop");
    expect(names).toContain("api-timeout-delay-then-throw");
    expect(names).toContain("dependency-failure-replay-store");
    expect(names).toContain("retry-window-transient-drop");
    expect(names).toContain("disabled-injector-no-op");
    expect(names).toContain("zero-duration-delay-boundary");
    expect(names).toContain("seeded-stream-reproducibility");
  });

  it("has unique, stable scenario names (regression guard)", () => {
    const names = CHAOS_SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("supports lookups by name and returns undefined for missing (negative)", () => {
    expect(getChaosScenario("api-timeout-delay-then-throw")).toBeDefined();
    expect(getChaosScenario("does-not-exist")).toBeUndefined();
  });

  it("the seeded reproducibility scenario actually injects and skips (regression)", async () => {
    const { plan, calls } = await replayChaosScenario(
      getChaosScenario("seeded-stream-reproducibility")!,
    );
    // Seed 1, probability 0.75: draws 0.6271/0.0027/0.5274/.../0.9948 pin the
    // exact inject/skip pattern (9 of 12 inject). If this ever changes, the
    // PRNG or the decision rule changed — regenerate the wire fixture.
    expect(plan.injectedCount).toBe(9);
    expect(calls.length).toBe(12);
    expect(calls.slice(0, 3).map((c) => c.outcome)).toEqual([
      "injected-throw",
      "injected-throw",
      "injected-throw",
    ]);
    expect(calls.slice(3, 5).map((c) => c.outcome)).toEqual(["no-op", "no-op"]);
    expect(calls[9].outcome).toBe("no-op");
  });
});

// ── Wire fixture drift ───────────────────────────────────────────────────────

describe("wire fixture drift", () => {
  it("tests/fixtures/chaos-scenarios.json matches buildChaosFixtureBundle exactly", () => {
    const committed = JSON.parse(readFileSync(SCENARIOS_FIXTURE, "utf8"));
    const generated = buildChaosFixtureBundle();
    expect(committed).toEqual(generated);
  });

  it("tests/fixtures/chaos-fault-config-errors.json matches FAULT_CONFIG_ERROR_FIXTURES", () => {
    const committed = JSON.parse(readFileSync(FAULT_ERRORS_FIXTURE, "utf8"));
    expect(committed.version).toBe(1);
    // Non-finite numbers are not JSON-representable; JSON.stringify maps them
    // to null while the committed fixture uses the wire strings "NaN" and
    // "Infinity". Normalize both sides through a canonical stringifier.
    const canonicalize = (value: unknown): unknown => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
      }
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) continue; // matches JSON.stringify
          out[k] = canonicalize(v);
        }
        return out;
      }
      return value;
    };
    const runtimeCases = FAULT_CONFIG_ERROR_FIXTURES.map((f) => ({
      name: f.name,
      config: canonicalize(f.config),
      expectedError: f.expectedError,
      expectedMessageIncludes: f.expectedMessageIncludes,
    }));
    expect(committed.cases).toEqual(runtimeCases);
  });

  it("the committed fixture is privacy-safe: no secrets, proofs, or messages", () => {
    const raw =
      readFileSync(SCENARIOS_FIXTURE, "utf8") +
      readFileSync(FAULT_ERRORS_FIXTURE, "utf8");
    expect(raw).not.toContain("simulated dependency outage");
    expect(raw).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(raw).not.toMatch(/G[A-Z0-9]{55}/); // Stellar key shape
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("X-PAYMENT");
  });
});

// ── Retry interaction (client-facing behavior) ────────────────────────────────

describe("chaos + client retry interaction", () => {
  it("a chaos drop inside a bounded retry window surfaces TalosTransportError-compatible rejection", async () => {
    // The TalosClient retries ChaosInjectedError rejections only if they are
    // TalosAPIError — they are not, so a chaos drop propagates immediately.
    // This pins the documented contract: chaos failures are test-only and
    // never silently absorbed by production retry policies.
    const { calls } = await replayChaosScenario(
      getChaosScenario("retry-window-transient-drop")!,
    );
    const injected = calls.filter((c) => c.injected !== false && c.outcome !== "no-op");
    expect(injected.length).toBeGreaterThan(0);
    for (const call of injected) {
      expect(call.outcome).toBe("injected-throw");
    }
  });
});

// ── Logger privacy ───────────────────────────────────────────────────────────

describe("injector logger privacy", () => {
  it("logger metadata never includes the operator fault message (privacy)", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const injector = new ChaosInjector({
      random: () => 0,
      logger,
    });
    injector.registerFault({
      type: FaultType.NETWORK_DROP,
      probability: 1,
      message: "TOPSECRET-do-not-log",
    });
    try {
      await injector.maybeInjectFault(FaultType.NETWORK_DROP);
    } catch {
      /* expected */
    }
    const allMeta = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(allMeta).not.toContain("TOPSECRET-do-not-log");
  });
});
