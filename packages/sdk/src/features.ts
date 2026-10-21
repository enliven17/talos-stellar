/**
 * Feature Detection utilities for TALOS SDK.
 */

export enum FeatureStatus {
  AVAILABLE = "available",
  UNAVAILABLE = "unavailable",
  EXPERIMENTAL = "experimental",
  DEPRECATED = "deprecated",
}

export const FeatureFlags = {
  CHAOS_INJECTION: "chaos_injection",
  SIGNING: "signing",
  IDEMPOTENCY: "idempotency",
  PROPOSALS: "proposals",
  MARKETPLACE: "marketplace",
} as const;

export type FeatureFlag = (typeof FeatureFlags)[keyof typeof FeatureFlags] | string;

export interface FeatureDetectionResult {
  name: string;
  available: boolean;
  status: FeatureStatus;
}

export function detectFeature(feature: FeatureFlag): FeatureDetectionResult {
  const isAvailable = Object.values(FeatureFlags).includes(feature as any);
  return {
    name: String(feature),
    available: isAvailable,
    status: isAvailable ? FeatureStatus.AVAILABLE : FeatureStatus.UNAVAILABLE,
  };
}
