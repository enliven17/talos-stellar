import { describe, expect, it } from "vitest";
import {
  buildMarketplaceAggregate,
  applyMarketplaceAggregateDelta,
  MarketplaceAggregateBackfillRequiredError,
  MarketplaceAggregateValidationError,
  toPublicMarketplaceAggregate,
  type MarketplaceAggregateEvent,
} from "../src/lib/marketplace-aggregates";

describe("buildMarketplaceAggregate", () => {
  it("deduplicates repeated events and respects bounded windows and category filters", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const events: MarketplaceAggregateEvent[] = [
      {
        id: "svc-1",
        kind: "supply",
        category: "Marketing",
        occurredAt: new Date("2026-07-27T11:00:00.000Z"),
        price: 24,
        dedupeKey: "svc-1",
      },
      {
        id: "svc-2",
        kind: "supply",
        category: "Marketing",
        occurredAt: new Date("2026-07-27T10:30:00.000Z"),
        price: 16,
        dedupeKey: "svc-2",
      },
      {
        id: "demand-1",
        kind: "demand",
        category: "Marketing",
        occurredAt: new Date("2026-07-27T10:45:00.000Z"),
        price: 20,
        status: "completed",
        dedupeKey: "demand-1",
      },
      {
        id: "demand-2",
        kind: "demand",
        category: "Marketing",
        occurredAt: new Date("2026-07-27T09:00:00.000Z"),
        price: 10,
        status: "failed",
        dedupeKey: "demand-2",
      },
      {
        id: "duplicate-demand",
        kind: "demand",
        category: "Marketing",
        occurredAt: new Date("2026-07-27T11:30:00.000Z"),
        price: 15,
        status: "completed",
        dedupeKey: "demand-1",
      },
      {
        id: "other-category",
        kind: "demand",
        category: "Sales",
        occurredAt: new Date("2026-07-27T11:30:00.000Z"),
        price: 15,
        status: "completed",
        dedupeKey: "other-category",
      },
    ];

    const aggregate = buildMarketplaceAggregate(events, {
      category: "Marketing",
      windowStart: new Date("2026-07-27T10:00:00.000Z"),
      windowEnd: new Date("2026-07-27T12:00:00.000Z"),
      version: 2,
      now,
    });

    expect(aggregate.supply).toBe(2);
    expect(aggregate.demand).toBe(1);
    expect(aggregate.capacity).toBe(1);
    expect(aggregate.averagePrice).toBe(20);
    expect(aggregate.fulfillmentRate).toBe(1);
    expect(aggregate.unmetNeeds).toBe(0);
    expect(aggregate.sourceEventCount).toBe(3);
    expect(aggregate.version).toBe(2);
    expect(aggregate.category).toBe("Marketing");
  });

  it("incrementally applies new events without double counting previous state", () => {
    const previous = buildMarketplaceAggregate(
      [
        {
          id: "svc-1",
          kind: "supply",
          category: "Analytics",
          occurredAt: new Date("2026-07-27T09:00:00.000Z"),
          price: 10,
          dedupeKey: "svc-1",
        },
        {
          id: "demand-1",
          kind: "demand",
          category: "Analytics",
          occurredAt: new Date("2026-07-27T09:30:00.000Z"),
          price: 10,
          status: "completed",
          dedupeKey: "demand-1",
        },
      ],
      {
        category: "Analytics",
        windowStart: new Date("2026-07-27T08:00:00.000Z"),
        windowEnd: new Date("2026-07-27T12:00:00.000Z"),
        version: 2,
        now: new Date("2026-07-27T10:00:00.000Z"),
      },
    );

    const next = applyMarketplaceAggregateDelta(
      previous,
      [
        {
          id: "svc-2",
          kind: "supply",
          category: "Analytics",
          occurredAt: new Date("2026-07-27T10:30:00.000Z"),
          price: 20,
          dedupeKey: "svc-2",
        },
        {
          id: "demand-2",
          kind: "demand",
          category: "Analytics",
          occurredAt: new Date("2026-07-27T10:45:00.000Z"),
          price: 20,
          status: "failed",
          dedupeKey: "demand-2",
        },
      ],
      {
        category: "Analytics",
        windowStart: new Date("2026-07-27T08:00:00.000Z"),
        windowEnd: new Date("2026-07-27T12:00:00.000Z"),
        version: 2,
        now: new Date("2026-07-27T10:45:00.000Z"),
      },
    );

    expect(next.supply).toBe(2);
    expect(next.demand).toBe(2);
    expect(next.capacity).toBe(0);
    expect(next.averagePrice).toBe(15);
    expect(next.fulfillmentRate).toBe(0.5);
    expect(next.unmetNeeds).toBe(0);
    expect(next.sourceEventCount).toBe(4);
    expect(next.version).toBe(2);
  });

  it("makes incremental retries equivalent to an authoritative backfill", () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const options = {
      category: "Analytics",
      windowStart: new Date("2026-07-27T08:00:00.000Z"),
      windowEnd: new Date("2026-07-27T12:00:00.000Z"),
      version: 3,
      now,
    };
    const first: MarketplaceAggregateEvent = {
      id: "supply-1",
      kind: "supply",
      category: "Analytics",
      occurredAt: new Date("2026-07-27T09:00:00.000Z"),
      price: 10,
      dedupeKey: "opaque-supply-1",
    };
    const second: MarketplaceAggregateEvent = {
      id: "demand-1",
      kind: "demand",
      category: "Analytics",
      occurredAt: new Date("2026-07-27T10:00:00.000Z"),
      price: 20,
      status: "completed",
      dedupeKey: "opaque-demand-1",
    };

    const backfill = buildMarketplaceAggregate([first, second], options);
    const checkpoint = buildMarketplaceAggregate([first], options);
    const incremental = applyMarketplaceAggregateDelta(
      checkpoint,
      [first, second, second, second],
      options,
    );

    expect(incremental).toEqual(backfill);
    expect(incremental.processedEventDigests).toHaveLength(2);
    expect(incremental.processedEventDigests.join(" ")).not.toContain(
      "opaque-",
    );
  });

  it("requires a source backfill when the aggregate version changes", () => {
    const options = {
      category: "Analytics",
      windowStart: new Date("2026-07-27T08:00:00.000Z"),
      windowEnd: new Date("2026-07-27T12:00:00.000Z"),
      version: 1,
      now: new Date("2026-07-27T12:00:00.000Z"),
    };
    const checkpoint = buildMarketplaceAggregate([], options);

    expect(() =>
      applyMarketplaceAggregateDelta(checkpoint, [], {
        ...options,
        version: 2,
      }),
    ).toThrow(MarketplaceAggregateBackfillRequiredError);

    const migrated = buildMarketplaceAggregate([], {
      ...options,
      version: 2,
    });
    expect(migrated.version).toBe(2);
  });

  it("rejects invalid and unbounded source input", () => {
    const invalidEvent: MarketplaceAggregateEvent = {
      id: "event-1",
      kind: "supply",
      category: "Analytics",
      occurredAt: new Date("2026-07-27T09:00:00.000Z"),
      price: -1,
      dedupeKey: "event-1",
    };
    const options = {
      category: "Analytics",
      windowStart: new Date("2026-07-27T08:00:00.000Z"),
      windowEnd: new Date("2026-07-27T12:00:00.000Z"),
      version: 1,
      now: new Date("2026-07-27T12:00:00.000Z"),
      maxEvents: 1,
    };

    expect(() => buildMarketplaceAggregate([invalidEvent], options)).toThrow(
      MarketplaceAggregateValidationError,
    );
    expect(() =>
      buildMarketplaceAggregate([invalidEvent, invalidEvent], options),
    ).toThrow("event batch exceeds the 1 event limit");
  });

  it("removes private checkpoint fields from public aggregate views", () => {
    const checkpoint = buildMarketplaceAggregate([], {
      category: "Analytics",
      windowStart: new Date("2026-07-27T08:00:00.000Z"),
      windowEnd: new Date("2026-07-27T12:00:00.000Z"),
      version: 1,
      now: new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(toPublicMarketplaceAggregate(checkpoint)).not.toHaveProperty(
      "processedEventDigests",
    );
    expect(toPublicMarketplaceAggregate(checkpoint)).not.toHaveProperty(
      "priceTotal",
    );
  });
});
