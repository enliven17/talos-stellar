import type { JobHandler } from "./types";

/**
 * Queue name → handler. Handlers register themselves at module load time
 * (see src/lib/jobs/handlers/index.ts) rather than the runner importing
 * feature code directly, so adding a new job type never means editing the
 * runner.
 */
const handlers = new Map<string, JobHandler<unknown, unknown>>();

export function registerHandler<TPayload = unknown, TResult = unknown>(
  queue: string,
  handler: JobHandler<TPayload, TResult>,
): void {
  if (handlers.has(queue)) {
    throw new Error(`Job handler already registered for queue "${queue}"`);
  }
  // Handlers are stored type-erased; each queue's payload/result shape is
  // only known at the registerHandler()/enqueue() call sites, which is
  // exactly where TypeScript checks it.
  handlers.set(queue, handler as JobHandler<unknown, unknown>);
}

export function getHandler(queue: string): JobHandler | undefined {
  return handlers.get(queue);
}

export function registeredQueues(): string[] {
  return Array.from(handlers.keys());
}

/** Test-only: clears the registry between test files. */
export function __resetRegistryForTests(): void {
  handlers.clear();
}
