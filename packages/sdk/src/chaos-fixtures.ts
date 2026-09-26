/**
 * Deterministic chaos transport fixtures.
 *
 * This module makes the {@link ChaosInjector} capability safe and predictable
 * to use in tests, CI, and operator drills:
 *
 *   - A small registry of named scenarios ({@link CHAOS_SCENARIOS}) covers the
 *     input classes that matter: missing inputs, malformed configs, boundary
 *     probabilities, retry windows, and dependency failures.
 *   - A seeded PRNG ({@link createSeededRandom}) and a scripted-random escape
 *     hatch make every injection decision reproducible.
 *   - A pure planner ({@link planChaosScenario}) computes the exact expected
 *     outcome of every call — the same decision rules the injector uses — so
 *     tests can assert on a plan instead of flaky probability.
 *   - A replay runner ({@link replayChaosScenario}) executes a scenario
 *     against a real {@link ChaosInjector} with an instant, recorded sleep so
 *     replays are fast and deterministic.
 *   - {@link buildChaosFixtureBundle} serializes every scenario + plan into a
 *     JSON-safe shape, committed as `tests/fixtures/chaos-scenarios.json` and
 *     kept drift-free by tests and `npm run fixtures:check`.
 *
 * Privacy guarantees: plans, replays, and the wire fixture never contain
 * request payloads, credentials, payment proofs, or secrets. Operator-supplied
 * fault `message` strings are intentionally excluded from plans (they surface
 * only on the thrown {@link ChaosInjectedError} itself, and injector logger
 * metadata never includes them).
 *
 * Compatibility: everything here is additive. `ChaosInjector` behavior is
 * unchanged for previously-valid inputs; previously *silently ignored*
 * malformed configs (unknown fault type, non-finite probability, numeric
 * strings, negative durations) now fail loudly at registration time — see
 * {@link assertValidFaultConfig} in `chaos.ts`.
 *
 * @module chaos-fixtures
 */

import {
  ChaosInjector,
  ChaosInjectedError,
  FaultType,
  assertValidFaultConfig,
  faultEffect,
  type FaultConfig,
  type FaultEffect,
} from "./chaos.js";

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

/** Valid seeds are unsigned 32-bit integers. */
const MAX_SEED = 0xffffffff;

/**
 * Create a deterministic pseudo-random generator producing values in
 * `[0, 1)` from an unsigned 32-bit seed (mulberry32). Two generators built
 * from the same seed produce identical sequences, so a scenario's injection
 * decisions can be reproduced bit-for-bit on any machine or CI runner.
 *
 * Explicit errors for malformed input:
 *   - non-number seed (missing, string, …) → `TypeError`
 *   - non-finite seed (`NaN`, `Infinity`) → `TypeError`
 *   - non-integer or out-of-range seed (`-1`, `1.5`, `2^32`) → `RangeError`
 *
 * Boundary seeds `0` and `4294967295` are valid.
 */
export function createSeededRandom(seed: number): () => number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new TypeError(
      `seed must be a finite number, got ${describeValue(seed)}`,
    );
  }
  if (!Number.isInteger(seed)) {
    throw new RangeError(`seed must be an integer, got ${seed}`);
  }
  if (seed < 0 || seed > MAX_SEED) {
    throw new RangeError(`seed must be within [0, ${MAX_SEED}], got ${seed}`);
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short, safe description of an invalid value for error messages. Never echoes object contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") {
    const s = String(value);
    return s.length > 32 ? `${s.slice(0, 32)}…` : s;
  }
  return `a ${t}`;
}

// ── Scenario specification ───────────────────────────────────────────────────

/**
 * The expected outcome of a single fault evaluation.
 *   - `no-op` — nothing injected (disabled, unregistered, or draw ≥ probability).
 *   - `injected-delay` — the call sleeps for `durationMs` (default 1000) and settles.
 *   - `injected-throw` — the call rejects with {@link ChaosInjectedError}.
 *   - `injected-delay-then-throw` — sleep first, then reject (e.g. `API_TIMEOUT`).
 */
export type ChaosCallOutcome =
  | "no-op"
  | "injected-delay"
  | "injected-throw"
  | "injected-delay-then-throw";

/**
 * A named, reproducible chaos scenario. Exactly one random source must be
 * provided: `seed` (replayed through the seeded PRNG) or `scriptedRandom`
 * (a fixed draw sequence, used to pin boundary semantics such as
 * "a draw exactly equal to the probability does not inject").
 */
export interface ChaosScenarioSpec {
  /** Stable scenario name; also the wire fixture key. */
  name: string;
  /** One-line explanation surfaced in fixtures and logs. */
  description: string;
  /** Unsigned 32-bit PRNG seed. Required unless `scriptedRandom` is provided. */
  seed?: number;
  /** Fixed draw sequence in `[0, 1)`. Required unless `seed` is provided. */
  scriptedRandom?: number[];
  /** Whether the injector is enabled for this scenario. Default `true`. */
  enabled?: boolean;
  /** Registered faults. Each fault type may appear at most once. */
  faults: FaultConfig[];
  /** Ordered fault-type evaluations (the "call script"). */
  calls: FaultType[];
}

/**
 * The deterministic plan for one scenario call. `randomValue` is the draw the
 * PRNG produced (`null` when no draw happened — the injector skips the PRNG
 * entirely when disabled). `probability` is the registered fault probability
 * in effect for the call.
 */
export interface ChaosCallPlan {
  /** 0-based call index. */
  index: number;
  /** Fault type evaluated on this call. */
  faultType: FaultType;
  /** PRNG draw for this call, or `null` when no draw occurred. */
  randomValue: number | null;
  /** Probability in effect for this call. */
  probability: number;
  /** Whether the call injected the fault. */
  injected: boolean;
  /** Expected outcome discriminator (wire-safe). */
  outcome: ChaosCallOutcome;
}

/** Normalized, message-free fault description used in plans (privacy-safe). */
export interface PlannedFault {
  type: FaultType;
  probability: number;
  /** `null` when unset (the injector then defaults to 1000 ms for delays). */
  durationMs: number | null;
}

/** The deterministic plan for a whole scenario. JSON-safe by construction. */
export interface ChaosPlan {
  scenario: string;
  /** Seed when the scenario is PRNG-driven, `null` for scripted scenarios. */
  seed: number | null;
  enabled: boolean;
  /** Normalized registered faults (operator `message` strings excluded). */
  faults: PlannedFault[];
  /** Per-call expectations, in script order. */
  calls: ChaosCallPlan[];
  /** Number of injecting calls. */
  injectedCount: number;
}

/** Outcome label for an injected fault, derived from its classified effect. */
function outcomeFor(effect: FaultEffect): ChaosCallOutcome {
  if (effect.delays && effect.throws) return "injected-delay-then-throw";
  if (effect.delays) return "injected-delay";
  if (effect.throws) return "injected-throw";
  return "no-op";
}

/**
 * Validate a scenario spec. Throws an explicit `TypeError`/`RangeError`
 * (never a silent misconfiguration) for:
 *   - missing/non-object spec, missing or empty `name`
 *   - missing random source (neither `seed` nor `scriptedRandom`) or both set
 *   - malformed seeds (see {@link createSeededRandom})
 *   - scripted draws that are not finite numbers in `[0, 1)` (a draw of
 *     exactly `1` can never occur, so `1` is rejected as malformed)
 *   - a scripted draw sequence shorter than the call script (a run would
 *     otherwise rely on implementation-defined wraparound)
 *   - missing/empty `calls`, unknown fault types in `calls`, or calls that
 *     reference a fault type that is not registered
 *   - invalid or duplicate fault configs (last-wins registration ambiguity)
 */
export function assertValidChaosScenario(spec: unknown): asserts spec is ChaosScenarioSpec {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError(
      `ChaosScenarioSpec must be a non-null object, got ${describeValue(spec)}`,
    );
  }
  const candidate = spec as Partial<ChaosScenarioSpec>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    throw new TypeError(
      `ChaosScenarioSpec.name must be a non-empty string, got ${describeValue(candidate.name)}`,
    );
  }
  if (
    typeof candidate.description !== "string" ||
    candidate.description.length === 0
  ) {
    throw new TypeError(
      `ChaosScenarioSpec.description must be a non-empty string, got ${describeValue(candidate.description)}`,
    );
  }

  const hasSeed = candidate.seed !== undefined;
  const hasScript =
    candidate.scriptedRandom !== undefined && candidate.scriptedRandom !== null;
  if (hasSeed && hasScript) {
    throw new TypeError(
      "ChaosScenarioSpec must provide exactly one random source: seed or scriptedRandom, not both",
    );
  }
  if (!hasSeed && !hasScript) {
    throw new TypeError(
      "ChaosScenarioSpec requires a random source: provide seed or scriptedRandom",
    );
  }
  if (hasScript) {
    const script = candidate.scriptedRandom as unknown[];
    if (!Array.isArray(script)) {
      throw new TypeError(
        `ChaosScenarioSpec.scriptedRandom must be an array of draws, got ${describeValue(script)}`,
      );
    }
    for (const draw of script) {
      if (typeof draw !== "number" || !Number.isFinite(draw)) {
        throw new TypeError(
          `ChaosScenarioSpec.scriptedRandom draws must be finite numbers, got ${describeValue(draw)}`,
        );
      }
      if (draw < 0 || draw >= 1) {
        throw new RangeError(
          `ChaosScenarioSpec.scriptedRandom draws must be within [0, 1), got ${draw}`,
        );
      }
    }
  }

  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
    throw new TypeError(
      `ChaosScenarioSpec.enabled must be a boolean when provided, got ${describeValue(candidate.enabled)}`,
    );
  }

  if (!Array.isArray(candidate.faults) || candidate.faults.length === 0) {
    throw new TypeError(
      "ChaosScenarioSpec.faults must be a non-empty array of FaultConfig",
    );
  }
  const registered = new Set<string>();
  for (const fault of candidate.faults) {
    assertValidFaultConfig(fault);
    if (registered.has(fault.type)) {
      throw new TypeError(
        `ChaosScenarioSpec.faults registers ${fault.type} more than once; fault registration is last-wins, so duplicate entries are ambiguous`,
      );
    }
    registered.add(fault.type);
  }

  if (!Array.isArray(candidate.calls) || candidate.calls.length === 0) {
    throw new TypeError(
      "ChaosScenarioSpec.calls must be a non-empty array of FaultType",
    );
  }
  for (const call of candidate.calls) {
    if (typeof call !== "string" || !registered.has(call)) {
      throw new TypeError(
        `ChaosScenarioSpec.calls references ${describeValue(call)} which is not registered in faults; register it or fix the call script`,
      );
    }
  }
  if (hasScript && (candidate.scriptedRandom as number[]).length < candidate.calls.length) {
    throw new RangeError(
      `ChaosScenarioSpec.scriptedRandom has ${(candidate.scriptedRandom as number[]).length} draw(s) but the call script needs ${candidate.calls.length}`,
    );
  }
}

// ── Planner ──────────────────────────────────────────────────────────────────

/**
 * Compute the deterministic plan for a scenario without executing anything.
 *
 * The planner mirrors {@link ChaosInjector.maybeInjectFault} decision rules
 * exactly, in call order, sharing a single PRNG stream:
 *   1. when the injector is disabled, no draw happens and the call is a no-op;
 *   2. otherwise a draw `r` is taken; the fault injects iff `r < probability`
 *      (strict comparison — a draw exactly equal to the probability is *not*
 *      an injection, and this scenario is pinned by the
 *      `probability-boundary-half-excluded` fixture).
 *
 * The returned plan is JSON-safe: plain objects and primitives only, with
 * operator-supplied fault messages deliberately excluded.
 */
export function planChaosScenario(spec: ChaosScenarioSpec): ChaosPlan {
  assertValidChaosScenario(spec);

  const enabled = spec.enabled ?? true;
  const faults = new Map<FaultType, FaultConfig>();
  for (const fault of spec.faults) faults.set(fault.type, fault);

  let draw: (() => number) | null = null;
  if (spec.scriptedRandom !== undefined) {
    let cursor = 0;
    const script = spec.scriptedRandom;
    draw = () => {
      // assertValidChaosScenario guarantees the script covers every call.
      const value = script[cursor] ?? script[script.length - 1];
      cursor += 1;
      return value;
    };
  } else {
    const seeded = createSeededRandom(spec.seed as number);
    draw = seeded;
  }

  const calls: ChaosCallPlan[] = [];
  let injectedCount = 0;
  spec.calls.forEach((faultType, index) => {
    const fault = faults.get(faultType) as FaultConfig;
    let randomValue: number | null = null;
    let injected = false;
    if (enabled) {
      const value = draw ? draw() : null;
      randomValue = value;
      injected = value !== null && value < fault.probability;
    }
    const outcome = injected
      ? outcomeFor(faultEffect(faultType))
      : "no-op";
    if (injected) injectedCount += 1;
    calls.push({
      index,
      faultType,
      randomValue,
      probability: fault.probability,
      injected,
      outcome,
    });
  });

  return {
    scenario: spec.name,
    seed: spec.seed !== undefined ? spec.seed : null,
    enabled,
    faults: spec.faults.map((fault) => ({
      type: fault.type,
      probability: fault.probability,
      durationMs: fault.durationMs !== undefined ? fault.durationMs : null,
    })),
    calls,
    injectedCount,
  };
}

// ── Replay ───────────────────────────────────────────────────────────────────

/** Options for {@link replayChaosScenario}. */
export interface ReplayChaosScenarioOptions {
  /**
   * Sleep implementation used for delay faults. Defaults to an instant,
   * recording stub so replays never actually wait. Pass through to observe
   * requested delays: `(ms) => recorded.push(ms)`.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** What actually happened during one replayed call. */
export interface ChaosReplayCall {
  index: number;
  faultType: FaultType;
  outcome: ChaosCallOutcome;
  /** Milliseconds requested from `sleep`, or `null` when the call did not delay. */
  delayedMs: number | null;
  /** `ChaosInjectedError.message` when the call threw, else `null`. */
  errorMessage: string | null;
}

/** The result of replaying a scenario against a real injector. */
export interface ChaosReplayResult {
  scenario: string;
  /** The planner's expectation (should equal the observed outcomes). */
  plan: ChaosPlan;
  /** Observed per-call outcomes. */
  calls: ChaosReplayCall[];
  /** The {@link ChaosInjectedError}s thrown during the replay, in order. */
  errors: ChaosInjectedError[];
  /** Total milliseconds requested from `sleep` across the replay. */
  totalDelayMs: number;
}

/**
 * Replay a scenario against a real {@link ChaosInjector} using the scenario's
 * random source, and record what actually happened. Delay faults sleep via
 * the (instant by default) `sleep` option, so replays are deterministic and
 * fast while still exercising the production code path — including fault
 * validation, effect classification, and error construction.
 */
export async function replayChaosScenario(
  spec: ChaosScenarioSpec,
  options: ReplayChaosScenarioOptions = {},
): Promise<ChaosReplayResult> {
  assertValidChaosScenario(spec);
  if (options.sleep !== undefined && typeof options.sleep !== "function") {
    throw new TypeError(
      `ReplayChaosScenarioOptions.sleep must be a function when provided, got ${describeValue(options.sleep)}`,
    );
  }

  const plan = planChaosScenario(spec);
  const userSleep = options.sleep;
  const recordedDelays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    recordedDelays.push(ms);
    if (userSleep) await userSleep(ms);
  };

  const random =
    spec.scriptedRandom !== undefined
      ? (() => {
          let cursor = 0;
          return () => {
            const value = spec.scriptedRandom![cursor % spec.scriptedRandom!.length];
            cursor += 1;
            return value;
          };
        })()
      : createSeededRandom(spec.seed as number);

  const injector = new ChaosInjector({
    enabled: plan.enabled,
    random,
    sleep,
  });
  for (const fault of spec.faults) injector.registerFault(fault);

  const calls: ChaosReplayCall[] = [];
  const errors: ChaosInjectedError[] = [];
  for (let index = 0; index < spec.calls.length; index += 1) {
    const faultType = spec.calls[index];
    const expectedInjection = plan.calls[index].injected;
    let delayedMs: number | null = null;
    let errorMessage: string | null = null;
    let outcome: ChaosCallOutcome = "no-op";
    const delaysBefore = recordedDelays.length;
    try {
      await injector.maybeInjectFault(faultType);
    } catch (err) {
      if (!(err instanceof ChaosInjectedError)) throw err;
      errors.push(err);
      errorMessage = err.message;
    }
    const callDelays = recordedDelays.slice(delaysBefore);
    if (expectedInjection) {
      const effect = faultEffect(faultType);
      if (effect.delays) {
        delayedMs = callDelays[0] ?? null;
      }
      outcome = errorMessage !== null
        ? effect.delays
          ? "injected-delay-then-throw"
          : "injected-throw"
        : "injected-delay";
      if (errorMessage !== null && !effect.throws) {
        // Defensive: a "delay-only" fault must never throw. Treat as failure.
        outcome = "injected-delay";
        errorMessage = null;
        errors.pop();
      }
    }
    calls.push({ index, faultType, outcome, delayedMs, errorMessage });
  }

  const totalDelayMs = recordedDelays.reduce((sum, ms) => sum + ms, 0);
  return { scenario: spec.name, plan, calls, errors, totalDelayMs };
}

// ── Scenario registry ────────────────────────────────────────────────────────

/**
 * The canonical deterministic chaos scenarios. Names are stable wire-fixture
 * keys: never rename or reorder them; add new scenarios at the end.
 *
 * Coverage map:
 *   - boundary: `never-injects-zero-probability`,
 *     `always-injects-unit-probability`,
 *     `probability-boundary-half-excluded`, `zero-duration-delay-boundary`
 *   - positive happy paths: `mixed-delay-then-drop`,
 *     `api-timeout-delay-then-throw`
 *   - dependency failure: `dependency-failure-replay-store`
 *   - retry: `retry-window-transient-drop`
 *   - disabled (missing-input no-op): `disabled-injector-no-op`
 *   - regression / reproducibility: `seeded-stream-reproducibility`
 */
export const CHAOS_SCENARIOS: readonly ChaosScenarioSpec[] = Object.freeze([
  {
    name: "never-injects-zero-probability",
    description:
      "Boundary: probability 0 never injects, whatever the PRNG draws.",
    seed: 1,
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 0 },
    ],
    calls: [
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
    ],
  },
  {
    name: "always-injects-unit-probability",
    description:
      "Boundary: probability 1 always injects, whatever the PRNG draws.",
    scriptedRandom: [0.25, 0.5, 0.75],
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 1 },
    ],
    calls: [
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
    ],
  },
  {
    name: "probability-boundary-half-excluded",
    description:
      "Boundary: a draw exactly equal to the probability does NOT inject (strict r < p); just below it does.",
    scriptedRandom: [0.5, 0.4999999999, 0.5],
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 0.5 },
    ],
    calls: [
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
    ],
  },
  {
    name: "mixed-delay-then-drop",
    description:
      "Positive: delay faults settle after durationMs; drop faults reject; interleaved calls each take one PRNG draw.",
    scriptedRandom: [0, 0, 0],
    faults: [
      { type: FaultType.NETWORK_DELAY, probability: 1, durationMs: 250 },
      { type: FaultType.NETWORK_DROP, probability: 1 },
    ],
    calls: [
      FaultType.NETWORK_DELAY,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DELAY,
    ],
  },
  {
    name: "api-timeout-delay-then-throw",
    description:
      "Positive: API_TIMEOUT delays for durationMs and then rejects — the retry-eligible timeout shape.",
    scriptedRandom: [0],
    faults: [
      { type: FaultType.API_TIMEOUT, probability: 1, durationMs: 100 },
    ],
    calls: [FaultType.API_TIMEOUT],
  },
  {
    name: "dependency-failure-replay-store",
    description:
      "Dependency failure: REPLAY_STORE_ERROR rejects on every draw below probability, simulating a lost replay store.",
    scriptedRandom: [0.1, 0.9],
    faults: [
      {
        type: FaultType.REPLAY_STORE_ERROR,
        probability: 1,
        message: "simulated dependency outage",
      },
    ],
    calls: [
      FaultType.REPLAY_STORE_ERROR,
      FaultType.REPLAY_STORE_ERROR,
    ],
  },
  {
    name: "retry-window-transient-drop",
    description:
      "Retry: a transient drop fires inside a bounded retry window and the window recovers — the shape auto-retry policies must absorb.",
    scriptedRandom: [0.7, 0.2, 0.8, 0.2, 0.6],
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 0.5 },
    ],
    calls: [
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
      FaultType.NETWORK_DROP,
    ],
  },
  {
    name: "disabled-injector-no-op",
    description:
      "Missing-input behavior: a disabled injector is a total no-op — the PRNG is never even consulted.",
    seed: 7,
    enabled: false,
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 1 },
    ],
    calls: [FaultType.NETWORK_DROP],
  },
  {
    name: "zero-duration-delay-boundary",
    description:
      "Boundary: durationMs 0 is a valid delay fault — it records an injection and delays zero milliseconds.",
    scriptedRandom: [0],
    faults: [
      { type: FaultType.NETWORK_DELAY, probability: 1, durationMs: 0 },
    ],
    calls: [FaultType.NETWORK_DELAY],
  },
  {
    name: "seeded-stream-reproducibility",
    description:
      "Regression: the same seed always produces the same draw sequence and therefore the same injection pattern.",
    seed: 1,
    faults: [
      { type: FaultType.NETWORK_DROP, probability: 0.75 },
    ],
    calls: Array.from({ length: 12 }, () => FaultType.NETWORK_DROP),
  },
]);

/** Look up a scenario by its stable name. Returns `undefined` when missing. */
export function getChaosScenario(name: string): ChaosScenarioSpec | undefined {
  return CHAOS_SCENARIOS.find((scenario) => scenario.name === name);
}

// ── Wire fixture bundle ──────────────────────────────────────────────────────

/**
 * A serialized scenario + plan. JSON-safe: plain objects and primitives only,
 * with operator-supplied fault `message` strings excluded.
 *
 * Contract is pinned by the committed wire fixture
 * `tests/fixtures/chaos-scenarios.json` (drift-checked in CI).
 */
export interface SerializedChaosScenario {
  name: string;
  description: string;
  /** Seed, or `null` when the scenario is scripted. */
  seed: number | null;
  /** Scripted draws, or `null` when the scenario is seeded. */
  scriptedRandom: number[] | null;
  enabled: boolean;
  /** Normalized faults (message strings excluded). */
  faults: PlannedFault[];
  /** The call script, as fault-type names. */
  calls: string[];
  /** The deterministic plan for the scenario. */
  plan: ChaosPlan;
}

/** The committed wire fixture shape (`tests/fixtures/chaos-scenarios.json`). */
export interface ChaosFixtureBundle {
  version: 1;
  generatedBy: string;
  scenarios: SerializedChaosScenario[];
}

/**
 * Build the deterministic wire fixture bundle: every registered scenario with
 * its computed plan. Pure and JSON-safe — stable across machines, Node
 * versions, and CI runners.
 */
export function buildChaosFixtureBundle(): ChaosFixtureBundle {
  return {
    version: 1,
    generatedBy: "packages/sdk/scripts/generate-chaos-fixtures.mjs",
    scenarios: CHAOS_SCENARIOS.map((spec) => {
      const plan = planChaosScenario(spec);
      return {
        name: spec.name,
        description: spec.description,
        seed: spec.seed !== undefined ? spec.seed : null,
        scriptedRandom:
          spec.scriptedRandom !== undefined ? [...spec.scriptedRandom] : null,
        enabled: spec.enabled ?? true,
        faults: plan.faults,
        calls: [...spec.calls],
        plan,
      };
    }),
  };
}

