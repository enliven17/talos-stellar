import type { Logger } from "./webhooks.js";

export enum FaultType {
  NETWORK_DELAY = "NETWORK_DELAY",
  NETWORK_DROP = "NETWORK_DROP",
  DB_CONNECTION_FAIL = "DB_CONNECTION_FAIL",
  API_TIMEOUT = "API_TIMEOUT",
  REPLAY_STORE_ERROR = "REPLAY_STORE_ERROR",
  SIGNATURE_VERIFICATION_SLOW = "SIGNATURE_VERIFICATION_SLOW",
}

export interface FaultConfig {
  type: FaultType;
  probability: number;
  durationMs?: number;
  message?: string;
}

export interface InjectionRecord {
  type: FaultType;
  timestamp: Date;
  config: FaultConfig;
}

export interface ChaosInjectorOptions {
  enabled?: boolean;
  random?: () => number;
  logger?: Logger;
  /**
   * Sleep implementation used for delay faults. Defaults to real `setTimeout`.
   * Tests and replays can inject an instant/recording implementation to keep
   * runs fast and deterministic.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What a registered fault does when it fires. Delays sleep for
 * `durationMs` (default 1000) before settling; throws reject with
 * {@link ChaosInjectedError}. A fault may both delay and throw
 * (e.g. {@link FaultType.API_TIMEOUT}).
 */
export interface FaultEffect {
  /** The injection sleeps for `durationMs` before settling. */
  delays: boolean;
  /** The injection rejects with {@link ChaosInjectedError}. */
  throws: boolean;
}

/**
 * Classify what a fault type does when injected. Single source of truth
 * shared by {@link ChaosInjector.maybeInjectFault} and the deterministic
 * chaos fixtures (`chaos-fixtures.ts`), so fixture expectations can never
 * drift from runtime behavior.
 */
export function faultEffect(type: FaultType): FaultEffect {
  switch (type) {
    case FaultType.NETWORK_DELAY:
      return { delays: true, throws: false };
    case FaultType.SIGNATURE_VERIFICATION_SLOW:
      return { delays: true, throws: false };
    case FaultType.NETWORK_DROP:
      return { delays: false, throws: true };
    case FaultType.DB_CONNECTION_FAIL:
      return { delays: false, throws: true };
    case FaultType.REPLAY_STORE_ERROR:
      return { delays: false, throws: true };
    case FaultType.API_TIMEOUT:
      return { delays: true, throws: true };
    default:
      // Unreachable for registered faults (registerFault validates the type);
      // unknown types resolve to a no-op effect.
      return { delays: false, throws: false };
  }
}

/** Short, safe description of an invalid value for error messages. Never echoes object contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean" || t === "undefined") {
    const s = String(value);
    return s.length > 32 ? `${s.slice(0, 32)}…` : s;
  }
  return `a ${t}`;
}

/**
 * Validate a fault configuration. Throws an explicit `TypeError` for
 * missing/malformed fields and a `RangeError` for out-of-range values, so a
 * misconfigured fault fails loudly at registration time instead of silently
 * never firing at injection time.
 *
 * Validation contract:
 *   - `config` must be a non-null, non-array object → otherwise `TypeError`.
 *   - `type` must be a known {@link FaultType} → otherwise `TypeError`
 *     (previously unknown types registered silently and never fired).
 *   - `probability` must be a finite number → otherwise `TypeError`
 *     (previously `NaN` and numeric strings registered silently), and within
 *     `[0, 1]` → otherwise `RangeError`.
 *   - `durationMs`, when provided, must be a finite number ≥ 0 →
 *     otherwise `TypeError` / `RangeError`.
 *   - `message`, when provided, must be a string → otherwise `TypeError`.
 *
 * Privacy note: `message` is operator-supplied test text and is never
 * included in logger metadata (see {@link ChaosInjector}).
 */
export function assertValidFaultConfig(config: unknown): asserts config is FaultConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(
      `FaultConfig must be a non-null object, got ${describeValue(config)}`,
    );
  }
  const candidate = config as Partial<FaultConfig>;
  const knownTypes: string[] = Object.values(FaultType);
  if (typeof candidate.type !== "string" || !knownTypes.includes(candidate.type)) {
    throw new TypeError(
      `FaultConfig.type must be one of ${knownTypes.join(", ")}, got ${describeValue(candidate.type)}`,
    );
  }
  if (typeof candidate.probability !== "number" || !Number.isFinite(candidate.probability)) {
    throw new TypeError(
      `FaultConfig.probability must be a finite number, got ${describeValue(candidate.probability)}`,
    );
  }
  if (candidate.probability < 0 || candidate.probability > 1) {
    throw new RangeError(
      `Fault probability must be between 0 and 1, got ${candidate.probability}`,
    );
  }
  if (candidate.durationMs !== undefined) {
    if (typeof candidate.durationMs !== "number" || !Number.isFinite(candidate.durationMs)) {
      throw new TypeError(
        `FaultConfig.durationMs must be a finite number when provided, got ${describeValue(candidate.durationMs)}`,
      );
    }
    if (candidate.durationMs < 0) {
      throw new RangeError(
        `FaultConfig.durationMs must be >= 0, got ${candidate.durationMs}`,
      );
    }
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    throw new TypeError(
      `FaultConfig.message must be a string when provided, got ${describeValue(candidate.message)}`,
    );
  }
}

export class ChaosInjectedError extends Error {
  constructor(
    public readonly faultType: FaultType,
    message: string,
  ) {
    super(message);
    this.name = "ChaosInjectedError";
  }
}

export class ChaosInjector {
  private activeFaults: Map<FaultType, FaultConfig> = new Map();
  private readonly random: () => number;
  private readonly logger?: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private enabled: boolean;
  private _injectionCount: number = 0;
  private _injectionHistory: InjectionRecord[] = [];
  private readonly maxHistory: number = 100;

  constructor(options: ChaosInjectorOptions = {}) {
    if (options.random !== undefined && typeof options.random !== "function") {
      throw new TypeError(
        `ChaosInjectorOptions.random must be a function when provided, got ${describeValue(options.random)}`,
      );
    }
    this.enabled = options.enabled ?? true;
    this.random = options.random ?? Math.random;
    if (options.sleep !== undefined && typeof options.sleep !== "function") {
      throw new TypeError(
        `ChaosInjectorOptions.sleep must be a function when provided, got ${describeValue(options.sleep)}`,
      );
    }
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  registerFault(config: FaultConfig): void {
    assertValidFaultConfig(config);
    this.activeFaults.set(config.type, config);
    this.logger?.info("chaos:fault_registered", {
      type: config.type,
      probability: config.probability,
      durationMs: config.durationMs ?? null,
    });
  }

  unregisterFault(type: FaultType): void {
    this.activeFaults.delete(type);
    this.logger?.info("chaos:fault_unregistered", { type });
  }

  clearFaults(): void {
    this.activeFaults.clear();
    this.logger?.info("chaos:faults_cleared");
  }

  hasFault(type: FaultType): boolean {
    return this.activeFaults.has(type);
  }

  getFault(type: FaultType): FaultConfig | undefined {
    return this.activeFaults.get(type);
  }

  getRegisteredFaults(): FaultType[] {
    return Array.from(this.activeFaults.keys());
  }

  get injectionCount(): number {
    return this._injectionCount;
  }

  get injectionHistory(): ReadonlyArray<InjectionRecord> {
    return this._injectionHistory;
  }

  resetStats(): void {
    this._injectionCount = 0;
    this._injectionHistory = [];
  }

  private recordInjection(type: FaultType, config: FaultConfig): void {
    this._injectionCount += 1;
    this._injectionHistory.push({
      type,
      timestamp: new Date(),
      config,
    });
    if (this._injectionHistory.length > this.maxHistory) {
      this._injectionHistory.splice(
        0,
        this._injectionHistory.length - this.maxHistory,
      );
    }
  }

  private async maybeSleep(ms: number): Promise<void> {
    await this.sleep(ms);
  }

  async maybeInjectFault(type: FaultType): Promise<void> {
    if (!this.enabled) return;

    const fault = this.activeFaults.get(type);
    if (!fault) return;

    if (this.random() < fault.probability) {
      this.recordInjection(type, fault);
      this.logger?.warn("chaos:fault_injected", {
        type,
        probability: fault.probability,
        durationMs: fault.durationMs ?? null,
      });

      const effect = faultEffect(fault.type);
      if (effect.delays) {
        await this.maybeSleep(fault.durationMs ?? 1000);
      }

      if (effect.throws) {
        throw new ChaosInjectedError(
          fault.type,
          fault.message ?? `[ChaosInjector] Injected ${fault.type} failure`,
        );
      }
    }
  }
}

export const globalChaosInjector = new ChaosInjector();
