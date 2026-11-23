export const SERVICE_AVAILABILITY_FRESHNESS_MS = 5 * 60 * 1000;

export type ServiceAvailabilityState = "available" | "unavailable" | "unknown";
export type ServiceAvailabilityFreshness = "fresh" | "stale" | "unknown";

export interface ServiceAvailabilityEvidence {
  state: ServiceAvailabilityState;
  freshness: ServiceAvailabilityFreshness;
  lastObservedAt: string | null;
}

/**
 * Convert the last heartbeat into an explicit, buyer-facing availability
 * result. A missing observation is deliberately different from an observed
 * offline service; `agentOnline=false` alone is not enough to claim either.
 */
export function deriveServiceAvailability(
  agentOnline: boolean,
  agentLastSeen: Date | string | null,
  now = new Date(),
): ServiceAvailabilityEvidence {
  if (!agentLastSeen) {
    return { state: "unknown", freshness: "unknown", lastObservedAt: null };
  }

  const observedAt = agentLastSeen instanceof Date
    ? agentLastSeen
    : new Date(agentLastSeen);
  if (Number.isNaN(observedAt.getTime())) {
    return { state: "unknown", freshness: "unknown", lastObservedAt: null };
  }

  const age = Math.max(0, now.getTime() - observedAt.getTime());
  const freshness: ServiceAvailabilityFreshness =
    age <= SERVICE_AVAILABILITY_FRESHNESS_MS ? "fresh" : "stale";

  return {
    state: agentOnline && freshness === "fresh" ? "available" : "unavailable",
    freshness,
    lastObservedAt: observedAt.toISOString(),
  };
}
