import { expect, test, describe, beforeEach } from "vitest";
import { registerConsumer, getConsumers, __resetRegistryForTests } from "./registry";
import type { OutboxEvent } from "./types";

beforeEach(() => {
  __resetRegistryForTests();
});

describe("outbox/registry — registerConsumer", () => {
  test("should register a consumer for an event type", () => {
    const handler = async (_event: OutboxEvent) => {};
    registerConsumer("order.created", handler);

    const consumers = getConsumers("order.created");
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toBe(handler);
  });

  test("should preserve idempotent registration: identical handler is not duplicated or rejected", () => {
    const handler = async (_event: OutboxEvent) => {};
    registerConsumer("order.created", handler);
    registerConsumer("order.created", handler);

    const consumers = getConsumers("order.created");
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toBe(handler);
  });

  test("should allow registering multiple different consumers for the same event type", () => {
    const handler1 = async (_event: OutboxEvent) => {};
    const handler2 = async (_event: OutboxEvent) => {};

    registerConsumer("order.created", handler1);
    registerConsumer("order.created", handler2);

    const consumers = getConsumers("order.created");
    expect(consumers).toHaveLength(2);
    expect(consumers[0]).toBe(handler1);
    expect(consumers[1]).toBe(handler2);
  });

  test("should preserve idempotent registration when using explicit ID", () => {
    const handler = async (_event: OutboxEvent) => {};
    registerConsumer("order.created", handler, "primary_order_handler");
    registerConsumer("order.created", handler, "primary_order_handler");
    registerConsumer("order.created", handler, { id: "primary_order_handler" });

    const consumers = getConsumers("order.created");
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toBe(handler);
  });

  test("should reject duplicate consumer registration with conflicting handlers for explicit ID", () => {
    const handler1 = async (_event: OutboxEvent) => {};
    const handler2 = async (_event: OutboxEvent) => {};

    registerConsumer("order.created", handler1, "order_processor");

    expect(() => {
      registerConsumer("order.created", handler2, "order_processor");
    }).toThrowError(
      'Consumer "order_processor" already registered for event type "order.created" with a conflicting handler',
    );

    // Ensure the original handler is preserved and second handler was rejected
    const consumers = getConsumers("order.created");
    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toBe(handler1);
  });

  test("should reject duplicate consumer registration with conflicting handlers for inferred function name", () => {
    function processPayment(_event: OutboxEvent): Promise<void> {
      return Promise.resolve();
    }
    function conflictingProcessPayment(_event: OutboxEvent): Promise<void> {
      return Promise.resolve();
    }
    Object.defineProperty(conflictingProcessPayment, "name", { value: "processPayment" });

    registerConsumer("payment.processed", processPayment);

    expect(() => {
      registerConsumer("payment.processed", conflictingProcessPayment);
    }).toThrowError(
      'Consumer "processPayment" already registered for event type "payment.processed" with a conflicting handler',
    );
  });

  test("should reject re-registering same handler under a conflicting ID", () => {
    const handler = async (_event: OutboxEvent) => {};
    registerConsumer("order.created", handler, "id_alpha");

    expect(() => {
      registerConsumer("order.created", handler, "id_beta");
    }).toThrowError(
      'Consumer handler already registered for event type "order.created" under ID "id_alpha", cannot re-register under conflicting ID "id_beta"',
    );
  });

  test("should allow the same consumer ID across different event types without conflict", () => {
    const handlerA = async (_event: OutboxEvent) => {};
    const handlerB = async (_event: OutboxEvent) => {};

    registerConsumer("event.one", handlerA, "shared_logger");
    registerConsumer("event.two", handlerB, "shared_logger");

    expect(getConsumers("event.one")).toHaveLength(1);
    expect(getConsumers("event.two")).toHaveLength(1);
  });

  test("should return empty list for event type with no consumers", () => {
    expect(getConsumers("non_existent")).toEqual([]);
  });

  test("__resetRegistryForTests clears all registered consumers", () => {
    registerConsumer("order.created", async () => {});
    registerConsumer("order.updated", async () => {});

    __resetRegistryForTests();

    expect(getConsumers("order.created")).toEqual([]);
    expect(getConsumers("order.updated")).toEqual([]);
  });
});
