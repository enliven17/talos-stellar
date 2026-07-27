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
  private enabled: boolean;
  private _injectionCount: number = 0;
  private _injectionHistory: InjectionRecord[] = [];
  private readonly maxHistory: number = 100;

  constructor(options: ChaosInjectorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  registerFault(config: FaultConfig): void {
    if (config.probability < 0 || config.probability > 1) {
      throw new RangeError(
        `Fault probability must be between 0 and 1, got ${config.probability}`,
      );
    }
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

      if (
        fault.type === FaultType.NETWORK_DELAY ||
        fault.type === FaultType.API_TIMEOUT ||
        fault.type === FaultType.SIGNATURE_VERIFICATION_SLOW
      ) {
        await this.sleep(fault.durationMs ?? 1000);
      }

      if (
        fault.type === FaultType.NETWORK_DROP ||
        fault.type === FaultType.DB_CONNECTION_FAIL ||
        fault.type === FaultType.API_TIMEOUT ||
        fault.type === FaultType.REPLAY_STORE_ERROR
      ) {
        throw new ChaosInjectedError(
          fault.type,
          fault.message ?? `[ChaosInjector] Injected ${fault.type} failure`,
        );
      }
    }
  }
}

export const globalChaosInjector = new ChaosInjector();
