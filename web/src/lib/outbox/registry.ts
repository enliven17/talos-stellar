import type { Consumer } from "./types";

/** eventType → consumers. Multiple consumers may subscribe to the same event type. */
const consumers = new Map<string, Consumer<unknown>[]>();

export function registerConsumer<TPayload = unknown>(eventType: string, consumer: Consumer<TPayload>): void {
  const list = consumers.get(eventType) ?? [];
  list.push(consumer as Consumer<unknown>);
  consumers.set(eventType, list);
}

export function getConsumers(eventType: string): Consumer<unknown>[] {
  return consumers.get(eventType) ?? [];
}

/** Test-only: clears the registry between test files. */
export function __resetRegistryForTests(): void {
  consumers.clear();
}
