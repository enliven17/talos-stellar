export type MarketplaceAggregateKind = "supply" | "demand";

export interface MarketplaceAggregateEvent {
  id: string;
  kind: MarketplaceAggregateKind;
  category: string;
  occurredAt: Date;
  price?: number;
  status?: "completed" | "failed" | "pending";
  dedupeKey: string;
}

export interface MarketplaceAggregate {
  category: string;
  version: number;
  windowStart: string;
  windowEnd: string;
  supply: number;
  demand: number;
  capacity: number;
  averagePrice: number;
  fulfillmentRate: number;
  unmetNeeds: number;
  sourceEventCount: number;
  freshUntil: string;
  lastComputedAt: string;
}

export interface MarketplaceAggregateOptions {
  category: string;
  windowStart: Date;
  windowEnd: Date;
  version: number;
  now: Date;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase();
}

function summarizeEvents(
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
) {
  const filtered = events.filter((event) => {
    const inWindow =
      event.occurredAt >= options.windowStart &&
      event.occurredAt <= options.windowEnd;
    const sameCategory =
      normalizeCategory(event.category) === normalizeCategory(options.category);
    return inWindow && sameCategory;
  });

  const seen = new Set<string>();
  const deduped = filtered.filter((event) => {
    const key = `${event.kind}:${event.dedupeKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const supplyEvents = deduped.filter((event) => event.kind === "supply");
  const demandEvents = deduped.filter((event) => event.kind === "demand");
  const completedDemand = demandEvents.filter(
    (event) => event.status === "completed",
  );
  const totalPrice = deduped.reduce(
    (sum, event) => sum + (event.price ?? 0),
    0,
  );

  const supply = supplyEvents.length;
  const demand = demandEvents.length;
  const capacity = Math.max(0, supply - demand);
  const averagePrice = deduped.length > 0 ? totalPrice / deduped.length : 0;
  const fulfillmentRate =
    demandEvents.length > 0 ? completedDemand.length / demandEvents.length : 0;

  return {
    supply,
    demand,
    capacity,
    averagePrice,
    fulfillmentRate,
    sourceEventCount: deduped.length,
    completedDemand: completedDemand.length,
    totalPrice,
  };
}

export function buildMarketplaceAggregate(
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
): MarketplaceAggregate {
  const summary = summarizeEvents(events, options);
  const unmetNeeds = Math.max(0, summary.demand - summary.supply);

  return {
    category: options.category,
    version: options.version,
    windowStart: toIso(options.windowStart),
    windowEnd: toIso(options.windowEnd),
    supply: summary.supply,
    demand: summary.demand,
    capacity: summary.capacity,
    averagePrice: summary.averagePrice,
    fulfillmentRate: clamp01(summary.fulfillmentRate),
    unmetNeeds,
    sourceEventCount: summary.sourceEventCount,
    freshUntil: toIso(new Date(options.now.getTime() + 5 * 60_000)),
    lastComputedAt: toIso(options.now),
  };
}

export function applyMarketplaceAggregateDelta(
  previous: MarketplaceAggregate,
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
): MarketplaceAggregate {
  const delta = summarizeEvents(events, options);
  const previousPriceTotal = previous.averagePrice * previous.sourceEventCount;
  const previousCompletedDemand = Math.round(
    previous.fulfillmentRate * previous.demand,
  );

  const combinedSupply = previous.supply + delta.supply;
  const combinedDemand = previous.demand + delta.demand;
  const combinedSourceEventCount =
    previous.sourceEventCount + delta.sourceEventCount;
  const combinedCompletedDemand =
    previousCompletedDemand + delta.completedDemand;
  const combinedPriceTotal = previousPriceTotal + delta.totalPrice;
  const combinedAveragePrice =
    combinedSourceEventCount > 0
      ? combinedPriceTotal / combinedSourceEventCount
      : 0;
  const combinedFulfillmentRate =
    combinedDemand > 0 ? combinedCompletedDemand / combinedDemand : 0;
  const combinedCapacity = Math.max(0, combinedSupply - combinedDemand);
  const combinedUnmetNeeds = Math.max(0, combinedDemand - combinedSupply);

  return {
    category: options.category,
    version: options.version,
    windowStart: toIso(options.windowStart),
    windowEnd: toIso(options.windowEnd),
    supply: combinedSupply,
    demand: combinedDemand,
    capacity: combinedCapacity,
    averagePrice: combinedAveragePrice,
    fulfillmentRate: clamp01(combinedFulfillmentRate),
    unmetNeeds: combinedUnmetNeeds,
    sourceEventCount: combinedSourceEventCount,
    freshUntil: toIso(new Date(options.now.getTime() + 5 * 60_000)),
    lastComputedAt: toIso(options.now),
  };
}
