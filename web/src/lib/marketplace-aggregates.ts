import { createHash } from "node:crypto";

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

/**
 * Materialized aggregate checkpoint. Event identity is retained only as a
 * one-way digest so retries can be deduplicated without persisting raw keys.
 */
export interface MarketplaceAggregate {
  checkpointVersion: 1;
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
  processedEventDigests: string[];
  completedDemandCount: number;
  priceTotal: number;
}

export type PublicMarketplaceAggregate = Omit<
  MarketplaceAggregate,
  "processedEventDigests" | "completedDemandCount" | "priceTotal"
>;

export interface MarketplaceAggregateOptions {
  category: string;
  windowStart: Date;
  windowEnd: Date;
  version: number;
  now: Date;
  maxEvents?: number;
}

export const DEFAULT_MAX_AGGREGATE_EVENTS = 10_000;

export class MarketplaceAggregateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceAggregateValidationError";
  }
}

export class MarketplaceAggregateBackfillRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceAggregateBackfillRequiredError";
  }
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

function validateOptions(options: MarketplaceAggregateOptions): number {
  if (!normalizeCategory(options.category)) {
    throw new MarketplaceAggregateValidationError("category must not be empty");
  }
  if (
    !Number.isFinite(options.windowStart.getTime()) ||
    !Number.isFinite(options.windowEnd.getTime()) ||
    !Number.isFinite(options.now.getTime())
  ) {
    throw new MarketplaceAggregateValidationError("aggregate dates must be valid");
  }
  if (options.windowStart > options.windowEnd) {
    throw new MarketplaceAggregateValidationError(
      "windowStart must be before or equal to windowEnd",
    );
  }
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new MarketplaceAggregateValidationError(
      "version must be a positive safe integer",
    );
  }

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_AGGREGATE_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new MarketplaceAggregateValidationError(
      "maxEvents must be a positive safe integer",
    );
  }
  return maxEvents;
}

function validateEvent(event: MarketplaceAggregateEvent): void {
  if (!event.id.trim() || !event.dedupeKey.trim()) {
    throw new MarketplaceAggregateValidationError(
      "event id and dedupeKey must not be empty",
    );
  }
  if (!normalizeCategory(event.category)) {
    throw new MarketplaceAggregateValidationError(
      "event category must not be empty",
    );
  }
  if (!Number.isFinite(event.occurredAt.getTime())) {
    throw new MarketplaceAggregateValidationError(
      `event ${event.id} has an invalid occurredAt value`,
    );
  }
  if (
    event.price !== undefined &&
    (!Number.isFinite(event.price) || event.price < 0)
  ) {
    throw new MarketplaceAggregateValidationError(
      `event ${event.id} has an invalid price`,
    );
  }
}

function eventDigest(event: MarketplaceAggregateEvent): string {
  return createHash("sha256")
    .update(event.kind)
    .update("\0")
    .update(event.dedupeKey)
    .digest("hex");
}

function summarizeEvents(
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
  previouslyProcessed: ReadonlySet<string> = new Set(),
) {
  const maxEvents = validateOptions(options);
  if (events.length > maxEvents) {
    throw new MarketplaceAggregateValidationError(
      `event batch exceeds the ${maxEvents} event limit`,
    );
  }

  const seen = new Set(previouslyProcessed);
  const accepted: MarketplaceAggregateEvent[] = [];
  const acceptedDigests: string[] = [];

  for (const event of events) {
    validateEvent(event);
    const inWindow =
      event.occurredAt >= options.windowStart &&
      event.occurredAt <= options.windowEnd;
    const sameCategory =
      normalizeCategory(event.category) === normalizeCategory(options.category);
    if (!inWindow || !sameCategory) continue;

    const digest = eventDigest(event);
    if (seen.has(digest)) continue;
    if (seen.size >= maxEvents) {
      throw new MarketplaceAggregateValidationError(
        `aggregate checkpoint exceeds the ${maxEvents} event limit`,
      );
    }
    seen.add(digest);
    accepted.push(event);
    acceptedDigests.push(digest);
  }

  const supply = accepted.filter((event) => event.kind === "supply").length;
  const demandEvents = accepted.filter((event) => event.kind === "demand");
  const completedDemand = demandEvents.filter(
    (event) => event.status === "completed",
  ).length;
  const totalPrice = accepted.reduce(
    (sum, event) => sum + (event.price ?? 0),
    0,
  );

  return {
    supply,
    demand: demandEvents.length,
    sourceEventCount: accepted.length,
    completedDemand,
    totalPrice,
    acceptedDigests,
  };
}

function materializeAggregate(
  summary: {
    supply: number;
    demand: number;
    sourceEventCount: number;
    completedDemand: number;
    totalPrice: number;
    processedEventDigests: string[];
  },
  options: MarketplaceAggregateOptions,
): MarketplaceAggregate {
  return {
    checkpointVersion: 1,
    category: options.category,
    version: options.version,
    windowStart: toIso(options.windowStart),
    windowEnd: toIso(options.windowEnd),
    supply: summary.supply,
    demand: summary.demand,
    capacity: Math.max(0, summary.supply - summary.demand),
    averagePrice:
      summary.sourceEventCount > 0
        ? summary.totalPrice / summary.sourceEventCount
        : 0,
    fulfillmentRate:
      summary.demand > 0
        ? clamp01(summary.completedDemand / summary.demand)
        : 0,
    unmetNeeds: Math.max(0, summary.demand - summary.supply),
    sourceEventCount: summary.sourceEventCount,
    freshUntil: toIso(new Date(options.now.getTime() + 5 * 60_000)),
    lastComputedAt: toIso(options.now),
    processedEventDigests: [...summary.processedEventDigests].sort(),
    completedDemandCount: summary.completedDemand,
    priceTotal: summary.totalPrice,
  };
}

export function buildMarketplaceAggregate(
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
): MarketplaceAggregate {
  const summary = summarizeEvents(events, options);
  return materializeAggregate(
    {
      ...summary,
      processedEventDigests: summary.acceptedDigests,
    },
    options,
  );
}

export function applyMarketplaceAggregateDelta(
  previous: MarketplaceAggregate,
  events: MarketplaceAggregateEvent[],
  options: MarketplaceAggregateOptions,
): MarketplaceAggregate {
  validateOptions(options);
  if (previous.checkpointVersion !== 1) {
    throw new MarketplaceAggregateBackfillRequiredError(
      "unsupported aggregate checkpoint version; rebuild from source events",
    );
  }
  if (previous.version !== options.version) {
    throw new MarketplaceAggregateBackfillRequiredError(
      "aggregate version changed; rebuild from source events",
    );
  }
  if (
    normalizeCategory(previous.category) !== normalizeCategory(options.category) ||
    previous.windowStart !== toIso(options.windowStart) ||
    previous.windowEnd !== toIso(options.windowEnd)
  ) {
    throw new MarketplaceAggregateBackfillRequiredError(
      "aggregate category or window changed; rebuild from source events",
    );
  }

  const priorDigests = new Set(previous.processedEventDigests);
  const delta = summarizeEvents(events, options, priorDigests);

  return materializeAggregate(
    {
      supply: previous.supply + delta.supply,
      demand: previous.demand + delta.demand,
      sourceEventCount: previous.sourceEventCount + delta.sourceEventCount,
      completedDemand:
        previous.completedDemandCount + delta.completedDemand,
      totalPrice: previous.priceTotal + delta.totalPrice,
      processedEventDigests: [
        ...previous.processedEventDigests,
        ...delta.acceptedDigests,
      ],
    },
    options,
  );
}

export function toPublicMarketplaceAggregate(
  checkpoint: MarketplaceAggregate,
): PublicMarketplaceAggregate {
  return {
    checkpointVersion: checkpoint.checkpointVersion,
    category: checkpoint.category,
    version: checkpoint.version,
    windowStart: checkpoint.windowStart,
    windowEnd: checkpoint.windowEnd,
    supply: checkpoint.supply,
    demand: checkpoint.demand,
    capacity: checkpoint.capacity,
    averagePrice: checkpoint.averagePrice,
    fulfillmentRate: checkpoint.fulfillmentRate,
    unmetNeeds: checkpoint.unmetNeeds,
    sourceEventCount: checkpoint.sourceEventCount,
    freshUntil: checkpoint.freshUntil,
    lastComputedAt: checkpoint.lastComputedAt,
  };
}
