import { EnvironmentMetadata, EnvStateTransition, EnvState } from "./types";
import { logEnvStateTransition } from "./logger";

export interface EnvironmentProvider {
  provision(prNumber: number, branch: string): Promise<EnvironmentMetadata>;
  teardown(prNumber: number): Promise<void>;
  getStatus(prNumber: number): Promise<EnvState>;
}

export class MockEnvironmentProvider implements EnvironmentProvider {
  async provision(prNumber: number, branch: string): Promise<EnvironmentMetadata> {
    logEnvStateTransition({
      prNumber,
      from: "pending",
      to: "provisioning",
      at: Date.now(),
    });

    // Mock API call to provisioning backend (e.g. Neon branching)
    await new Promise((resolve) => setTimeout(resolve, 500));

    const meta: EnvironmentMetadata = {
      prNumber,
      branch,
      createdAt: new Date().toISOString(),
      ttlHours: 72, // Default 3 days
      costLimitUsd: 5.0,
      dbUrl: `postgresql://pr_${prNumber}:secret@mock-db.local:5432/talos_pr_${prNumber}`,
      directUrl: `postgresql://pr_${prNumber}:secret@mock-db.local:5432/talos_pr_${prNumber}`,
    };

    logEnvStateTransition({
      prNumber,
      from: "provisioning",
      to: "ready",
      at: Date.now(),
    });

    return meta;
  }

  async teardown(prNumber: number): Promise<void> {
    logEnvStateTransition({
      prNumber,
      from: "ready",
      to: "tearing_down",
      at: Date.now(),
    });

    // Mock API call
    await new Promise((resolve) => setTimeout(resolve, 500));

    logEnvStateTransition({
      prNumber,
      from: "tearing_down",
      to: "destroyed",
      at: Date.now(),
    });
  }

  async getStatus(prNumber: number): Promise<EnvState> {
    // In a real implementation this would fetch from provider API
    return "ready";
  }
}

// Predictable naming format for PR environments
export function formatEnvironmentName(prNumber: number): string {
  return `pr-${prNumber}`;
}
