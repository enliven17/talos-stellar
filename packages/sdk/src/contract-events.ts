/**
 * Typed contract event decoder for Talos Soroban contract events.
 *
 * Decodes raw Soroban event envelopes into strongly-typed, discriminated
 * union payloads keyed by the `topics[0]` symbol. Driven by the versioned
 * event catalog defined in `contracts/EVENTS.md` and
 * `contracts/fixtures/event_fixtures.json`.
 *
 * Design properties:
 * - Pure functions, no side effects, no I/O — safe for browser and Node.
 * - Malformed payloads (empty topics, wrong types, wrong arity) throw
 *   explicitly rather than silently mis-decoding.
 * - Secrets, seeds, payment proofs, and sensitive media are never logged
 *   or surfaced through decoded payloads or error messages.
 * - The catalog is the single source of truth; no parallel definitions.
 *
 * @module contract-events
 */

// ── Soroban value representation ──────────────────────────────────────────────

/** A single Soroban ScVal in its JSON-serialisable wire form. */
export interface ScVal {
  type: string;
  value: string | number | boolean;
}

// ── Catalog types (mirrors contracts/fixtures/event-query.ts) ─────────────────

/** A single positional field descriptor in the event catalog. */
export interface CatalogFieldDescriptor {
  position: number;
  type: string;
  name: string;
  description?: string;
}

/** A catalog entry describing one event type's expected shape. */
export interface CatalogEventDescriptor {
  contract: string;
  topics: CatalogFieldDescriptor[];
  data: CatalogFieldDescriptor[];
}

/**
 * The four event families defined in the Talos event specification.
 * Mirrors `contracts/EVENTS.md` §3.
 */
export type ContractEventFamily =
  | "creation"
  | "update"
  | "governance"
  | "payment";

/**
 * A full event catalog: family → event-symbol → descriptor.
 * Matches the `event_catalog` key in `event_fixtures.json`.
 */
export type EventCatalog = Record<
  ContractEventFamily,
  Record<string, CatalogEventDescriptor>
>;

// ── Raw event envelope ────────────────────────────────────────────────────────

/**
 * A raw Soroban contract event as received from the RPC / Horizon envelope.
 * This is what callers feed into `decodeContractEvent`.
 */
export interface RawContractEvent {
  /** Emitting contract identifier (e.g. `"talos_registry"`). */
  contract: string;
  /** Ordered topics array — `topics[0]` is always the event-type symbol. */
  topics: ScVal[];
  /** Positional data tuple — decoded left-to-right per the catalog. */
  data: ScVal[];
  /** Ledger sequence from the RPC envelope. */
  ledger_sequence: number;
  /** Zero-based transaction position within the ledger. */
  tx_index_in_ledger?: number;
  /** Zero-based event position within the transaction. */
  event_index_in_tx?: number;
  /** Transaction hash from the envelope. */
  tx_hash?: string;
}

// ── Decoded event types (discriminated union by `event` field) ─────────────────

/** Cursor tuple for ordering — `(ledger_sequence, tx_index_in_ledger, event_index_in_tx)`. */
export interface EventCursor {
  ledger_sequence: number;
  tx_index_in_ledger: number;
  event_index_in_tx: number;
}

/** Base fields shared by all decoded contract events. */
export interface DecodedContractEventBase {
  /** The event-type symbol (e.g. `"tls_crt"`, `"vote"`). */
  event: string;
  /** The event family (e.g. `"creation"`, `"governance"`). */
  family: ContractEventFamily;
  /** Emitting contract name. */
  contract: string;
  /** Ordering cursor. */
  cursor: EventCursor;
  /** Decoded topic fields keyed by catalog name. */
  topics: Record<string, string | number>;
  /** Decoded data fields keyed by catalog name. */
  data: Record<string, string | number>;
}

// ── Per-event typed interfaces ────────────────────────────────────────────────

/** `tls_crt` — new Talos registered (v1). */
export interface TalosCrtEvent extends DecodedContractEventBase {
  event: "tls_crt";
  family: "creation";
  data: { talos_id: number; name: string; category: string };
}

/** `tls_crt2` — new Talos registered (v2, with version field). */
export interface TalosCrt2Event extends DecodedContractEventBase {
  event: "tls_crt2";
  family: "creation";
  data: { version: number; talos_id: number; name: string; category: string };
}

/** `pat_upd` — patron split changed. */
export interface PatUpdEvent extends DecodedContractEventBase {
  event: "pat_upd";
  family: "update";
  data: {
    creator_addr: string;
    creator_share: number;
    investor_share: number;
  };
}

/** `reg_upd` — registry address changed. */
export interface RegUpdEvent extends DecodedContractEventBase {
  event: "reg_upd";
  family: "update";
  data: { old_registry: string; new_registry: string };
}

/** `prop_crt` — governance proposal created. */
export interface PropCrtEvent extends DecodedContractEventBase {
  event: "prop_crt";
  family: "governance";
  data: { talos_id: number; proposer: string };
}

/** `vote` — governance vote cast. */
export interface VoteEvent extends DecodedContractEventBase {
  event: "vote";
  family: "governance";
  data: { voter: string; choice: string; weight: number };
}

/** `prop_stat` — governance proposal status change. */
export interface PropStatEvent extends DecodedContractEventBase {
  event: "prop_stat";
  family: "governance";
  data: { status: string };
}

/** `ep_cmt` — epoch committed (dividends). */
export interface EpCmtEvent extends DecodedContractEventBase {
  event: "ep_cmt";
  family: "payment";
  data: { epoch_id: number; total: number; expiry_secs: number };
}

/** `div_clm` — dividend claimed. */
export interface DivClmEvent extends DecodedContractEventBase {
  event: "div_clm";
  family: "payment";
  data: { talos_id: number; amount: number; role: string };
}

/**
 * Discriminated union of all known decoded contract events.
 * Callers can narrow with `switch (decoded.event)`.
 */
export type DecodedContractEvent =
  | TalosCrtEvent
  | TalosCrt2Event
  | PatUpdEvent
  | RegUpdEvent
  | PropCrtEvent
  | VoteEvent
  | PropStatEvent
  | EpCmtEvent
  | DivClmEvent;

// ── Error hierarchy ───────────────────────────────────────────────────────────

/** Base error for contract event decoding failures. */
export class ContractEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractEventError";
  }
}

/** Thrown when `topics[0]` names an event not present in the catalog. */
export class UnknownContractEventError extends ContractEventError {
  constructor(
    public readonly symbol: string,
    message?: string,
  ) {
    super(message ?? `Unknown contract event symbol: ${symbol}`);
    this.name = "UnknownContractEventError";
  }
}

/**
 * Thrown when the raw event's topics or data don't match the catalog
 * entry's expected shape (wrong arity, wrong type, non-symbol topic[0]).
 */
export class MalformedContractEventError extends ContractEventError {
  constructor(message: string) {
    super(message);
    this.name = "MalformedContractEventError";
  }
}

/**
 * Thrown when a versioned event (e.g. `tls_crt2`) carries a version
 * value the SDK does not support.
 */
export class UnsupportedContractVersionError extends ContractEventError {
  constructor(
    public readonly version: number,
    message?: string,
  ) {
    super(message ?? `Unsupported contract event version: ${version}`);
    this.name = "UnsupportedContractVersionError";
  }
}

// ── Built-in catalog ──────────────────────────────────────────────────────────

/**
 * The built-in event catalog matching spec_version 1.2.0 from
 * `contracts/EVENTS.md` and `contracts/fixtures/event_fixtures.json`.
 *
 * This is the single source of truth for the SDK — it exactly mirrors
 * the `event_catalog` key in the canonical fixture file. Changes to the
 * on-chain event shapes go through the fixture's `spec_version` bump
 * and are reflected here.
 */
export const BUILTIN_EVENT_CATALOG: EventCatalog = {
  creation: {
    tls_crt: {
      contract: "talos_registry",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "address", name: "creator" },
      ],
      data: [
        { position: 0, type: "u32", name: "talos_id" },
        { position: 1, type: "string", name: "name" },
        { position: 2, type: "string", name: "category" },
      ],
    },
    tls_crt2: {
      contract: "talos_registry",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "address", name: "creator" },
      ],
      data: [
        { position: 0, type: "u32", name: "version" },
        { position: 1, type: "u32", name: "talos_id" },
        { position: 2, type: "string", name: "name" },
        { position: 3, type: "string", name: "category" },
      ],
    },
  },
  update: {
    pat_upd: {
      contract: "talos_registry",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u32", name: "talos_id" },
      ],
      data: [
        { position: 0, type: "address", name: "creator_addr" },
        { position: 1, type: "u32", name: "creator_share" },
        { position: 2, type: "u32", name: "investor_share" },
      ],
    },
    reg_upd: {
      contract: "talos_name_service",
      topics: [
        { position: 0, type: "symbol", name: "event" },
      ],
      data: [
        { position: 0, type: "address", name: "old_registry" },
        { position: 1, type: "address", name: "new_registry" },
      ],
    },
  },
  governance: {
    prop_crt: {
      contract: "talos_governance",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u32", name: "proposal_id" },
      ],
      data: [
        { position: 0, type: "u32", name: "talos_id" },
        { position: 1, type: "address", name: "proposer" },
      ],
    },
    vote: {
      contract: "talos_governance",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u32", name: "proposal_id" },
      ],
      data: [
        { position: 0, type: "address", name: "voter" },
        { position: 1, type: "symbol", name: "choice" },
        { position: 2, type: "i128", name: "weight" },
      ],
    },
    prop_stat: {
      contract: "talos_governance",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u32", name: "proposal_id" },
      ],
      data: [
        { position: 0, type: "symbol", name: "status" },
      ],
    },
  },
  payment: {
    ep_cmt: {
      contract: "talos_dividends",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u32", name: "talos_id" },
      ],
      data: [
        { position: 0, type: "u64", name: "epoch_id" },
        { position: 1, type: "i128", name: "total" },
        { position: 2, type: "u64", name: "expiry_secs" },
      ],
    },
    div_clm: {
      contract: "talos_dividends",
      topics: [
        { position: 0, type: "symbol", name: "event" },
        { position: 1, type: "u64", name: "epoch_id" },
        { position: 2, type: "address", name: "patron" },
      ],
      data: [
        { position: 0, type: "u32", name: "talos_id" },
        { position: 1, type: "i128", name: "amount" },
        { position: 2, type: "symbol", name: "role" },
      ],
    },
  },
};

/**
 * The spec version this SDK's built-in catalog is aligned with.
 * Consumers should assert this matches the fixture file they consume.
 */
export const CATALOG_SPEC_VERSION = "1.2.0";

// ── Reverse lookup (symbol → family) ──────────────────────────────────────────

type SymbolFamilyMap = Map<string, ContractEventFamily>;

function buildSymbolMap(catalog: EventCatalog): SymbolFamilyMap {
  const map: SymbolFamilyMap = new Map();
  for (const family of Object.keys(catalog) as ContractEventFamily[]) {
    for (const symbol of Object.keys(catalog[family])) {
      map.set(symbol, family);
    }
  }
  return map;
}

let cachedSymbolMap: SymbolFamilyMap | undefined;

function symbolMap(catalog: EventCatalog): SymbolFamilyMap {
  if (catalog === BUILTIN_EVENT_CATALOG && cachedSymbolMap) {
    return cachedSymbolMap;
  }
  const map = buildSymbolMap(catalog);
  if (catalog === BUILTIN_EVENT_CATALOG) {
    cachedSymbolMap = map;
  }
  return map;
}

// ── Decoder options ───────────────────────────────────────────────────────────

export interface DecodeContractEventOptions {
  /**
   * Event catalog to decode against. Defaults to the built-in catalog
   * aligned with spec_version 1.2.0.
   */
  catalog?: EventCatalog;

  /**
   * Maximum supported version for versioned events (e.g. `tls_crt2`).
   * Events with a `version` data field above this value are rejected.
   * @default 1
   */
  maxSupportedVersion?: number;
}

// ── Core decoder ──────────────────────────────────────────────────────────────

/**
 * Decode a raw Soroban contract event into a typed {@link DecodedContractEvent}.
 *
 * The decoder validates topics and data against the event catalog, rejects
 * malformed payloads with explicit errors, and returns a discriminated union
 * that callers can narrow with `switch (result.event)`.
 *
 * @throws {MalformedContractEventError} if the raw event has structural issues
 *   (empty topics, topic[0] not a symbol, wrong arity, wrong types).
 * @throws {UnknownContractEventError} if topic[0] names an event not in the catalog.
 * @throws {UnsupportedContractVersionError} if a versioned event carries an
 *   unsupported version number.
 *
 * @example
 * ```ts
 * const decoded = decodeContractEvent({
 *   contract: "talos_registry",
 *   topics: [
 *     { type: "symbol", value: "tls_crt" },
 *     { type: "address", value: "GDC2T..." },
 *   ],
 *   data: [
 *     { type: "u32", value: 1 },
 *     { type: "string", value: "Genesis" },
 *     { type: "string", value: "Marketing" },
 *   ],
 *   ledger_sequence: 100000,
 * });
 *
 * if (decoded.event === "tls_crt") {
 *   console.log(decoded.data.talos_id); // 1 — fully typed
 * }
 * ```
 */
export function decodeContractEvent(
  raw: RawContractEvent,
  options?: DecodeContractEventOptions,
): DecodedContractEvent {
  const catalog = options?.catalog ?? BUILTIN_EVENT_CATALOG;
  const maxVersion = options?.maxSupportedVersion ?? 1;

  // ── Validate envelope ───────────────────────────────────────────────────
  if (!raw || typeof raw !== "object") {
    throw new MalformedContractEventError(
      "Raw event must be a non-null object",
    );
  }
  if (!Array.isArray(raw.topics) || raw.topics.length < 1) {
    throw new MalformedContractEventError(
      "Event topics must be a non-empty array",
    );
  }
  if (raw.topics[0].type !== "symbol") {
    throw new MalformedContractEventError(
      `topics[0] must be a symbol, got ${raw.topics[0].type}`,
    );
  }
  if (!Array.isArray(raw.data)) {
    throw new MalformedContractEventError("Event data must be an array");
  }

  // ── Resolve catalog entry ───────────────────────────────────────────────
  const eventSymbol = String(raw.topics[0].value);
  const sMap = symbolMap(catalog);
  const family = sMap.get(eventSymbol);
  if (family === undefined) {
    throw new UnknownContractEventError(eventSymbol);
  }
  const entry = catalog[family][eventSymbol];
  if (!entry) {
    throw new UnknownContractEventError(eventSymbol);
  }

  // ── Validate topics shape ───────────────────────────────────────────────
  if (raw.topics.length !== entry.topics.length) {
    throw new MalformedContractEventError(
      `Event ${eventSymbol}: expected ${entry.topics.length} topics, got ${raw.topics.length}`,
    );
  }
  for (let i = 0; i < entry.topics.length; i++) {
    if (raw.topics[i].type !== entry.topics[i].type) {
      throw new MalformedContractEventError(
        `Event ${eventSymbol}: topic[${i}] expected type ${entry.topics[i].type}, got ${raw.topics[i].type}`,
      );
    }
  }

  // ── Validate data shape ─────────────────────────────────────────────────
  if (raw.data.length !== entry.data.length) {
    throw new MalformedContractEventError(
      `Event ${eventSymbol}: expected ${entry.data.length} data fields, got ${raw.data.length}`,
    );
  }
  for (let i = 0; i < entry.data.length; i++) {
    if (raw.data[i].type !== entry.data[i].type) {
      throw new MalformedContractEventError(
        `Event ${eventSymbol}: data[${i}] expected type ${entry.data[i].type}, got ${raw.data[i].type}`,
      );
    }
  }

  // ── Decode topics ───────────────────────────────────────────────────────
  const decodedTopics: Record<string, string | number> = {};
  for (let i = 0; i < entry.topics.length; i++) {
    decodedTopics[entry.topics[i].name] = raw.topics[i].value as
      | string
      | number;
  }

  // ── Decode data ─────────────────────────────────────────────────────────
  const decodedData: Record<string, string | number> = {};
  for (let i = 0; i < entry.data.length; i++) {
    decodedData[entry.data[i].name] = raw.data[i].value as string | number;
  }

  // ── Version gate (e.g. tls_crt2 carries a version field) ────────────────
  if (
    "version" in decodedData &&
    typeof decodedData.version === "number" &&
    decodedData.version > maxVersion
  ) {
    throw new UnsupportedContractVersionError(decodedData.version);
  }

  // ── Assemble result ─────────────────────────────────────────────────────
  const cursor: EventCursor = {
    ledger_sequence: raw.ledger_sequence,
    tx_index_in_ledger: raw.tx_index_in_ledger ?? 0,
    event_index_in_tx: raw.event_index_in_tx ?? 0,
  };

  return {
    event: eventSymbol,
    family,
    contract: raw.contract,
    cursor,
    topics: decodedTopics,
    data: decodedData,
  } as DecodedContractEvent;
}

// ── Batch decoder ─────────────────────────────────────────────────────────────

/**
 * Result of a batch decode — events that decoded successfully plus
 * structured errors for those that failed.
 */
export interface BatchDecodeResult {
  /** Successfully decoded events, in input order. */
  decoded: DecodedContractEvent[];
  /** Events that failed decoding, with the original index and error. */
  errors: Array<{ index: number; error: ContractEventError }>;
}

/**
 * Decode a batch of raw events, collecting successes and failures separately.
 * This never throws — individual decode failures are captured in `errors`.
 */
export function decodeContractEvents(
  rawEvents: RawContractEvent[],
  options?: DecodeContractEventOptions,
): BatchDecodeResult {
  const decoded: DecodedContractEvent[] = [];
  const errors: Array<{ index: number; error: ContractEventError }> = [];

  for (let i = 0; i < rawEvents.length; i++) {
    try {
      decoded.push(decodeContractEvent(rawEvents[i], options));
    } catch (err) {
      if (err instanceof ContractEventError) {
        errors.push({ index: i, error: err });
      } else {
        errors.push({
          index: i,
          error: new MalformedContractEventError(
            err instanceof Error ? err.message : "Unknown decode error",
          ),
        });
      }
    }
  }

  return { decoded, errors };
}

// ── Type guard helpers ────────────────────────────────────────────────────────

/** Type guard: narrow a decoded event to a specific event symbol. */
export function isContractEvent<E extends DecodedContractEvent["event"]>(
  decoded: DecodedContractEvent,
  event: E,
): decoded is Extract<DecodedContractEvent, { event: E }> {
  return decoded.event === event;
}

/** Type guard: narrow a decoded event to a specific event family. */
export function isContractEventFamily<
  F extends ContractEventFamily,
>(
  decoded: DecodedContractEvent,
  family: F,
): decoded is Extract<DecodedContractEvent, { family: F }> {
  return decoded.family === family;
}

// ── Cursor comparison ─────────────────────────────────────────────────────────

/**
 * Compare two event cursors. Returns negative if `a < b`, zero if equal,
 * positive if `a > b`. Suitable as a `Array.prototype.sort` comparator.
 */
export function compareEventCursors(a: EventCursor, b: EventCursor): number {
  if (a.ledger_sequence !== b.ledger_sequence) {
    return a.ledger_sequence < b.ledger_sequence ? -1 : 1;
  }
  if (a.tx_index_in_ledger !== b.tx_index_in_ledger) {
    return a.tx_index_in_ledger < b.tx_index_in_ledger ? -1 : 1;
  }
  if (a.event_index_in_tx !== b.event_index_in_tx) {
    return a.event_index_in_tx < b.event_index_in_tx ? -1 : 1;
  }
  return 0;
}
