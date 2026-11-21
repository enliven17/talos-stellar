import type { Consumer, RegisterConsumerOptions, RegisteredConsumer } from "./types";

/** eventType → registered consumers. Multiple consumers may subscribe to the same event type. */
const consumers = new Map<string, RegisteredConsumer<unknown>[]>();

export function registerConsumer<TPayload = unknown>(
  eventType: string,
  consumer: Consumer<TPayload>,
  options?: RegisterConsumerOptions,
): void;
export function registerConsumer<TPayload = unknown>(
  eventType: string,
  consumerId: string,
  consumer: Consumer<TPayload>,
): void;
export function registerConsumer<TPayload = unknown>(
  eventType: string,
  consumerOrId: Consumer<TPayload> | string,
  consumerOrOptions?: Consumer<TPayload> | RegisterConsumerOptions,
): void {
  let explicitId: string | undefined;
  let handler: Consumer<TPayload>;

  if (typeof consumerOrId === "string") {
    explicitId = consumerOrId;
    handler = consumerOrOptions as Consumer<TPayload>;
  } else {
    handler = consumerOrId;
    explicitId = (consumerOrOptions as RegisterConsumerOptions | undefined)?.id;
  }

  const list = consumers.get(eventType) ?? [];
  let id: string;

  if (explicitId !== undefined) {
    const trimmed = explicitId.trim();
    if (!trimmed) {
      throw new Error(`Consumer id for event type "${eventType}" must be a non-empty string`);
    }
    if (list.some((entry) => entry.id === trimmed)) {
      throw new Error(`Consumer "${trimmed}" is already registered for event type "${eventType}"`);
    }
    id = trimmed;
  } else {
    const fnName = handler.name?.trim();
    const canUseFnName = Boolean(fnName && fnName !== "spy" && !list.some((entry) => entry.id === fnName));
    id = canUseFnName ? fnName! : `consumer#${list.length}`;
  }

  list.push({ id, handler: handler as Consumer<unknown> });
  consumers.set(eventType, list);
}

export function getRegisteredConsumers(eventType: string): RegisteredConsumer<unknown>[] {
  return consumers.get(eventType) ?? [];
}

export function getConsumers(eventType: string): Consumer<unknown>[] {
  return getRegisteredConsumers(eventType).map((entry) => entry.handler);
}

/** Test-only: clears the registry between test files. */
export function __resetRegistryForTests(): void {
  consumers.clear();
}
