/**
 * Bounded event-query helper for Talos Soroban indexers.
 *
 * Companion to `contracts/EVENTS.md` and `contracts/fixtures/event_fixtures.json`.
 * Provides:
 *   - fixture parsing + per-event-family end-to-end decoding
 *   - bounded queries over a ledger range (inclusive bounds, bounded page size)
 *
 * Design rules (mirror the acceptance criteria in issue #423):
 *   - A query MUST supply both `fromLedger` and `toLedger` (inclusive). An
 *     unbounded range is rejected.
 *   - The requested span (toLedger - fromLedger + 1) cannot exceed
 *     `max_ledger_span` from the fixture `bounds`.
 *   - A query MUST supply a page size within `[min_page_size, max_page_size]`.
 *     An unbounded or out-of-range page size is rejected.
 *   - Decoding is driven by the versioned `event_catalog` in the fixture file;
 *     unknown events or mismatched topic/data shapes throw.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface Bounds {
  min_page_size: number;
  max_page_size: number;
  max_ledger_span: number;
}

export interface CatalogField {
  position: number;
  type: string;
  name?: string;
  description?: string;
}

export interface CatalogEvent {
  contract: string;
  topics: CatalogField[];
  data: CatalogField[];
}

export type EventFamily = "creation" | "update" | "governance" | "payment";

export interface ScValJson {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
}

export interface EventFixture {
  id: string;
  family: EventFamily;
  event: string;
  contract: string;
  ledger_sequence: number;
  tx_hash: string;
  event_index_in_tx: number;
  topics: ScValJson[];
  data: ScValJson[];
  decoded: Record<string, unknown>;
}

export interface FixtureSet {
  spec_version: string;
  format: string;
  bounds: Bounds;
  event_catalog: Record<EventFamily, Record<string, CatalogEvent>>;
  fixtures: EventFixture[];
  empty_ranges: Array<{
    id: string;
    family: EventFamily;
    contract: string;
    topic: string;
    start_ledger: number;
    end_ledger: number;
  }>;
  malformed: Array<{ id: string; reason: string; fixture: Json }>;
}

export interface EventQuery {
  /** Optional contract filter (e.g. "talos_registry"). */
  contract?: string;
  /** Optional topic[0] symbol filter (e.g. "tls_crt"). */
  topic?: string;
  /** Inclusive lower ledger bound. Required. */
  fromLedger?: number;
  /** Inclusive upper ledger bound. Required. */
  toLedger?: number;
  /** Page size, clamped to fixture bounds. Required. */
  pageSize?: number;
  /** 1-based page number. Defaults to 1. */
  page?: number;
}

export interface QueryResult {
  events: EventFixture[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export class EventQueryError extends Error {}

/** Unknown event symbol (not present in the versioned catalog). */
export class UnknownEventError extends EventQueryError {}

/** Event payload does not match its catalog entry (topics/data shape). */
export class MalformedEventError extends EventQueryError {}

export class UnboundedRangeError extends EventQueryError {}
export class UnboundedPageSizeError extends EventQueryError {}

function fail(err: typeof EventQueryError, message: string): never {
  throw new err(message);
}

/**
 * Load + structurally validate a fixture set. Ensures the file is a versioned
 * `talos-event-fixtures` document with a valid catalog, bounds, and event rows.
 */
export function parseFixtureSet(raw: Json): FixtureSet {
  if (!raw || typeof raw !== "object") {
    fail(MalformedEventError, "fixture document must be a JSON object");
  }
  if (raw.format !== "talos-event-fixtures") {
    fail(MalformedEventError, `unexpected fixture format: ${raw.format}`);
  }
  if (typeof raw.spec_version !== "string") {
    fail(MalformedEventError, "spec_version is required");
  }
  const bounds = raw.bounds as Bounds | undefined;
  if (!bounds || typeof bounds !== "object") {
    fail(MalformedEventError, "bounds are required");
  }
  for (const key of ["min_page_size", "max_page_size", "max_ledger_span"] as const) {
    const v = bounds[key];
    if (!Number.isInteger(v) || v < 1) {
      fail(MalformedEventError, `bounds.${key} must be a positive integer`);
    }
  }
  if (bounds.min_page_size > bounds.max_page_size) {
    fail(MalformedEventError, "bounds.min_page_size cannot exceed max_page_size");
  }

  const catalog = raw.event_catalog as Record<EventFamily, Record<string, CatalogEvent>> | undefined;
  if (!catalog || typeof catalog !== "object") {
    fail(MalformedEventError, "event_catalog is required");
  }
  for (const family of Object.keys(catalog) as EventFamily[]) {
    if (!["creation", "update", "governance", "payment"].includes(family)) {
      fail(MalformedEventError, `unknown event family: ${family}`);
    }
    for (const [event, entry] of Object.entries(catalog[family])) {
      validateCatalogEvent(event, entry as CatalogEvent);
    }
  }

  if (!Array.isArray(raw.fixtures)) {
    fail(MalformedEventError, "fixtures must be an array");
  }
  if (!Array.isArray(raw.empty_ranges)) {
    fail(MalformedEventError, "empty_ranges must be an array");
  }
  if (!Array.isArray(raw.malformed)) {
    fail(MalformedEventError, "malformed must be an array");
  }
  return raw as FixtureSet;
}

function validateCatalogEvent(event: string, entry: CatalogEvent): void {
  if (!entry || typeof entry !== "object") {
    fail(MalformedEventError, `catalog entry for ${event} is invalid`);
  }
  if (typeof entry.contract !== "string") {
    fail(MalformedEventError, `catalog entry ${event} requires a contract`);
  }
  if (!Array.isArray(entry.topics) || entry.topics.length < 1) {
    fail(MalformedEventError, `catalog entry ${event} requires >=1 topic field`);
  }
  if (entry.topics[0]?.type !== "symbol") {
    fail(MalformedEventError, `catalog entry ${event} topic[0] must be a symbol`);
  }
  if (!Array.isArray(entry.data)) {
    fail(MalformedEventError, `catalog entry ${event} requires a data array`);
  }
}

export function catalogEntry(set: FixtureSet, family: EventFamily, event: string): CatalogEvent {
  const entry = set.event_catalog[family]?.[event];
  if (!entry) {
    fail(UnknownEventError, `unknown event ${event} in family ${family} (spec ${set.spec_version})`);
  }
  return entry;
}

/**
 * Parse a single event fixture against the catalog. Throws `MalformedEventError`
 * when topics or data don't match the catalog entry's shape and types. Returns a
 * typed `EventFixture` that always carries a valid `decoded` payload.
 */
export function parseEventFixture(raw: Json, set: FixtureSet): EventFixture {
  if (!raw || typeof raw !== "object") fail(MalformedEventError, "event fixture must be an object");
  const family = raw.family as EventFamily;
  const event = raw.event as string;
  const entry = catalogEntry(set, family, event);

  const topics = raw.topics as ScValJson[];
  if (!Array.isArray(topics) || topics.length < 1) {
    fail(MalformedEventError, `event ${event}: topics must be a non-empty array`);
  }
  if (topics[0].type !== "symbol") {
    fail(MalformedEventError, `event ${event}: topic[0] must be a symbol`);
  }
  if (topics[0].value !== event) {
    fail(
      MalformedEventError,
      `event ${event}: topic[0] symbol '${topics[0].value}' does not match event name`,
    );
  }
  if (topics.length !== entry.topics.length) {
    fail(
      MalformedEventError,
      `event ${event}: expected ${entry.topics.length} topics, got ${topics.length}`,
    );
  }
  entry.topics.forEach((field, i) => {
    if (topics[i].type !== field.type) {
      fail(
        MalformedEventError,
        `event ${event}: topic[${i}] expected ${field.type}, got ${topics[i].type}`,
      );
    }
  });

  const data = raw.data as ScValJson[];
  if (!Array.isArray(data)) fail(MalformedEventError, `event ${event}: data must be an array`);
  if (data.length !== entry.data.length) {
    fail(
      MalformedEventError,
      `event ${event}: expected ${entry.data.length} data fields, got ${data.length}`,
    );
  }
  entry.data.forEach((field, i) => {
    if (data[i].type !== field.type) {
      fail(MalformedEventError, `event ${event}: data[${i}] expected ${field.type}, got ${data[i].type}`);
    }
  });

  const decoded = decodeData(set, family, event, data);
  return {
    id: raw.id as string,
    family,
    event,
    contract: raw.contract as string,
    ledger_sequence: raw.ledger_sequence as number,
    tx_hash: raw.tx_hash as string,
    event_index_in_tx: raw.event_index_in_tx as number,
    topics,
    data,
    decoded: {
      event,
      contract: raw.contract,
      ledger_sequence: raw.ledger_sequence,
      topics: decodeTopics(set, family, event, topics),
      data: decoded,
    },
  };
}

function decodeTopics(set: FixtureSet, family: EventFamily, event: string, topics: ScValJson[]): Record<string, unknown> {
  const entry = catalogEntry(set, family, event);
  const out: Record<string, unknown> = {};
  entry.topics.forEach((field, i) => {
    out[field.name ?? `topic${i}`] = topics[i].value;
  });
  return out;
}

function decodeData(set: FixtureSet, family: EventFamily, event: string, data: ScValJson[]): Record<string, unknown> {
  const entry = catalogEntry(set, family, event);
  const out: Record<string, unknown> = {};
  entry.data.forEach((field, i) => {
    out[field.name ?? `data${i}`] = data[i].value;
  });
  return out;
}

export interface ValidatedQuery {
  contract?: string;
  topic?: string;
  fromLedger: number;
  toLedger: number;
  pageSize: number;
  page: number;
}

/**
 * Validate a query and clamp nothing — invalid queries throw. Rules:
 *   - `fromLedger` and `toLedger` are required (unbounded range rejected).
 *   - `fromLedger <= toLedger` and span <= max_ledger_span.
 *   - `pageSize` required and within `[min_page_size, max_page_size]`.
 *   - `page >= 1`.
 */
export function validateQuery(set: FixtureSet, query: EventQuery): ValidatedQuery {
  const { min_page_size, max_page_size, max_ledger_span } = set.bounds;

  if (query.fromLedger === undefined || query.toLedger === undefined) {
    fail(UnboundedRangeError, "fromLedger and toLedger are required (unbounded ranges are not allowed)");
  }
  if (!Number.isInteger(query.fromLedger) || query.fromLedger < 0) {
    fail(EventQueryError, "fromLedger must be a non-negative integer");
  }
  if (!Number.isInteger(query.toLedger) || query.toLedger < 0) {
    fail(EventQueryError, "toLedger must be a non-negative integer");
  }
  if (query.fromLedger > query.toLedger) {
    fail(EventQueryError, `fromLedger (${query.fromLedger}) cannot exceed toLedger (${query.toLedger})`);
  }
  const span = query.toLedger - query.fromLedger + 1;
  if (span > max_ledger_span) {
    fail(
      EventQueryError,
      `ledger span ${span} exceeds max_ledger_span ${max_ledger_span}`,
    );
  }

  if (query.pageSize === undefined) {
    fail(UnboundedPageSizeError, "pageSize is required (unbounded page sizes are not allowed)");
  }
  if (!Number.isInteger(query.pageSize)) {
    fail(EventQueryError, "pageSize must be an integer");
  }
  if (query.pageSize < min_page_size || query.pageSize > max_page_size) {
    fail(
      EventQueryError,
      `pageSize ${query.pageSize} outside [${min_page_size}, ${max_page_size}]`,
    );
  }

  const page = query.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    fail(EventQueryError, "page must be a positive integer");
  }

  return {
    contract: query.contract,
    topic: query.topic,
    fromLedger: query.fromLedger,
    toLedger: query.toLedger,
    pageSize: query.pageSize,
    page,
  };
}

function matches(query: ValidatedQuery, fixture: EventFixture): boolean {
  if (query.topic && fixture.event !== query.topic) return false;
  if (query.contract && fixture.contract !== query.contract) return false;
  if (fixture.ledger_sequence < query.fromLedger || fixture.ledger_sequence > query.toLedger) {
    return false;
  }
  return true;
}

/**
 * Run a bounded query over a fixture set's normal `fixtures` array.
 * `fromLedger`/`toLedger` are inclusive. Pagination is 1-based with a bounded
 * page size enforced by `validateQuery`.
 */
export function queryEvents(set: FixtureSet, query: EventQuery): QueryResult {
  const q = validateQuery(set, query);
  const all = set.fixtures.filter((f) => matches(q, f));

  const pageSize = q.pageSize;
  const total = all.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const start = (q.page - 1) * pageSize;
  const events = all.slice(start, start + pageSize);

  return {
    events,
    page: q.page,
    pageSize,
    total,
    totalPages,
    hasMore: q.page < totalPages,
  };
}

/** Convenience: an empty-range fixture is one whose query returns zero events. */
export function isRangeEmpty(set: FixtureSet, range: { topic?: string; contract?: string; start_ledger: number; end_ledger: number }): boolean {
  const result = queryEvents(set, {
    topic: range.topic,
    contract: range.contract,
    fromLedger: range.start_ledger,
    toLedger: range.end_ledger,
    pageSize: set.bounds.max_page_size,
  });
  return result.total === 0;
}
