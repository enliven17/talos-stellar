import type { Consumer } from "./types";

export interface ConsumerRegistrationOptions {
  id?: string;
  name?: string;
}

interface RegisteredConsumer {
  id?: string;
  handler: Consumer<unknown>;
}

/** eventType → consumers. Multiple consumers may subscribe to the same event type. */
const consumers = new Map<string, RegisteredConsumer[]>();

/**
 * Registers a consumer handler for an event type.
 *
 * Registration behavior:
 * - Supports multiple distinct consumers subscribing to the same event type.
 * - Idempotent: Re-registering the same handler function instance (or same ID
 *   with the same handler) is a no-op and does not duplicate dispatch.
 * - Conflict detection at startup: If a consumer with the same ID or name is
 *   already registered for this event type with a conflicting (different)
 *   handler function, an Error is thrown to catch misconfiguration early.
 */
export function registerConsumer<TPayload = unknown>(
  eventType: string,
  consumer: Consumer<TPayload>,
  idOrOptions?: string | ConsumerRegistrationOptions,
): void {
  const list = consumers.get(eventType) ?? [];

  const explicitId =
    typeof idOrOptions === "string"
      ? idOrOptions
      : idOrOptions?.id ?? idOrOptions?.name;

  // Infer ID from function name if meaningful (exclude anonymous/spy/mock names)
  const inferredId =
    consumer.name && !["", "anonymous", "spy", "mockConstructor"].includes(consumer.name)
      ? consumer.name
      : undefined;

  const consumerId = explicitId ?? inferredId;

  // Check if the exact same handler is already registered (idempotent registration)
  const existingByHandler = list.find((entry) => entry.handler === (consumer as Consumer<unknown>));
  if (existingByHandler) {
    if (consumerId && existingByHandler.id && existingByHandler.id !== consumerId) {
      throw new Error(
        `Consumer handler already registered for event type "${eventType}" under ID "${existingByHandler.id}", cannot re-register under conflicting ID "${consumerId}"`,
      );
    }
    if (consumerId && !existingByHandler.id) {
      existingByHandler.id = consumerId;
    }
    return;
  }

  // Check if this ID is already registered for this event type with a conflicting handler
  if (consumerId) {
    const existingById = list.find((entry) => entry.id === consumerId);
    if (existingById) {
      throw new Error(
        `Consumer "${consumerId}" already registered for event type "${eventType}" with a conflicting handler`,
      );
    }
  }

  list.push({ id: consumerId, handler: consumer as Consumer<unknown> });
  consumers.set(eventType, list);
}

export function getConsumers(eventType: string): Consumer<unknown>[] {
  return (consumers.get(eventType) ?? []).map((entry) => entry.handler);
}

/** Test-only: clears the registry between test files. */
export function __resetRegistryForTests(): void {
  consumers.clear();
}
