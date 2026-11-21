export type OutboxStatus = "pending" | "leased" | "dispatched" | "dead_letter" | "quarantined";

/** One structural problem found when validating a payload against its declared schema. */
export interface PayloadValidationIssue {
  /** Dotted path into the payload, e.g. "amount" or "items.0.id" ("" = root). */
  path: string;
  /** Machine-readable code (e.g. "invalid_type"). */
  code: string;
  /** Short, bounded human-readable message. Never contains payload values. */
  message: string;
}

/** Bounded validation summary persisted on a quarantined event. */
export interface PayloadValidationSummary {
  schemaVersion: number;
  /** Total issues found (may exceed `issues.length` when truncated). */
  issueCount: number;
  issues: PayloadValidationIssue[];
  truncated: boolean;
}

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
  /** Declared payload schema version the event was validated against (null = no schema registered). */
  schemaVersion?: number | null;
  /** Bounded validation summary; set only when the event was quarantined. */
  validationSummary?: PayloadValidationSummary | null;
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
  /** Events whose payload violated the declared schema; never retried. */
  quarantined: number;
  reaped: number;
  pruned: number;
}
