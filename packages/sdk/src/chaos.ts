export enum FaultType {
  NETWORK_DELAY = 'NETWORK_DELAY',
  NETWORK_DROP = 'NETWORK_DROP',
  DB_CONNECTION_FAIL = 'DB_CONNECTION_FAIL',
  API_TIMEOUT = 'API_TIMEOUT',
}

export interface FaultConfig {
  type: FaultType;
  probability: number;
  durationMs?: number;
  message?: string;
}

export class ChaosInjector {
  private activeFaults: Map<FaultType, FaultConfig> = new Map();

  registerFault(config: FaultConfig) {
    this.activeFaults.set(config.type, config);
  }

  clearFaults() {
    this.activeFaults.clear();
  }

  async maybeInjectFault(type: FaultType): Promise<void> {
    const fault = this.activeFaults.get(type);
    if (!fault) return;

    if (Math.random() < fault.probability) {
      console.warn(`[ChaosInjector] Injecting fault: ${type}`);
      if (fault.type === FaultType.NETWORK_DELAY || fault.type === FaultType.API_TIMEOUT) {
        await new Promise((resolve) => setTimeout(resolve, fault.durationMs || 1000));
      }
      if (fault.type === FaultType.NETWORK_DROP || fault.type === FaultType.DB_CONNECTION_FAIL || fault.type === FaultType.API_TIMEOUT) {
        throw new Error(`[ChaosInjector] Injected error: ${fault.message || 'Controlled failure'}`);
      }
    }
  }
}

export const globalChaosInjector = new ChaosInjector();
