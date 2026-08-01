export type OutboxStatus = "pending" | "leased" | "dispatched" | "dead_letter";

export interface OutboxEvent<TPayload = unknown> {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  status: OutboxStatus;
  runAt: Date;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
}

export interface WriteEventInput<TPayload = unknown> {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: TPayload;
  maxAttempts?: number;
  dedupeKey?: string;
}

export type Consumer<TPayload = unknown> = (event: OutboxEvent<TPayload>) => Promise<void>;

export interface DispatchSummary {
  leased: number;
  dispatched: number;
  retried: number;
  deadLettered: number;
  reaped: number;
  pruned: number;
}
