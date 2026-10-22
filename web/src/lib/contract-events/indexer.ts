import { db } from "@/db";
import { tlsContractEvents, tlsEventCursor } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  decodeContractEvent,
  ContractEventError,
  UnknownContractEventError,
  UnsupportedContractVersionError,
  MalformedContractEventError,
  type RawContractEvent,
  type ScVal,
} from "../../../../packages/sdk/src/contract-events";
import { eq } from "drizzle-orm";
import {
  getSorobanClient,
  TALOS_REGISTRY_CONTRACT_ID,
  TALOS_NAME_SERVICE_CONTRACT_ID,
  TALOS_GOVERNANCE_CONTRACT_ID,
  TALOS_DIVIDENDS_CONTRACT_ID,
} from "@/lib/soroban";

export interface EventIndexerConfig {
  cursorId: string;
  defaultStartLedger: number;
  batchLimit: number;
  pollIntervalMs: number;
}

export const defaultIndexerConfig: EventIndexerConfig = {
  cursorId: "default",
  defaultStartLedger: parseInt(process.env.CONTRACT_EVENTS_START_LEDGER ?? "1", 10),
  batchLimit: parseInt(process.env.CONTRACT_EVENTS_BATCH_LIMIT ?? "100", 10),
  pollIntervalMs: parseInt(process.env.CONTRACT_EVENTS_POLL_INTERVAL_MS ?? "5000", 10),
};

export function getMonitoredContractIds(): string[] {
  return [
    TALOS_REGISTRY_CONTRACT_ID,
    TALOS_NAME_SERVICE_CONTRACT_ID,
    TALOS_GOVERNANCE_CONTRACT_ID,
    TALOS_DIVIDENDS_CONTRACT_ID,
  ].filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

export async function getPersistedCursor(cursorId: string = "default"): Promise<number | null> {
  const rows = await db
    .select({ lastLedger: tlsEventCursor.lastLedger })
    .from(tlsEventCursor)
    .where(eq(tlsEventCursor.id, cursorId))
    .limit(1);

  if (rows.length > 0) {
    return rows[0].lastLedger;
  }
  return null;
}

export async function saveCursor(lastLedger: number, cursorId: string = "default"): Promise<void> {
  await db
    .insert(tlsEventCursor)
    .values({
      id: cursorId,
      lastLedger,
      updatedAt: new Date().toISOString(),
    } as any)
    .onConflictDoUpdate({
      target: tlsEventCursor.id,
      set: {
        lastLedger,
        updatedAt: new Date().toISOString(),
      } as any,
    });
}

/**
 * Normalized raw event interface matching Soroban RPC getEvents response item.
 */
export interface SorobanRpcEventResponse {
  id: string;
  type?: string;
  ledger: number;
  ledgerClosedAt?: string;
  contractId: string;
  txHash?: string;
  topic?: string[] | ScVal[];
  value?: {
    xdr?: string;
    [key: string]: unknown;
  } | ScVal[] | unknown;
  topics?: ScVal[] | string[];
  data?: ScVal[] | unknown;
  // If native or parsed representation is available
  tx_index_in_ledger?: number;
  event_index_in_tx?: number;
}

/**
 * Normalize an RPC event response into RawContractEvent for @talos/sdk decoder.
 */
export function normalizeRpcEvent(raw: SorobanRpcEventResponse): RawContractEvent | null {
  try {
    // If topics is an array of ScVal objects
    let topics: ScVal[] = [];
    if (Array.isArray(raw.topics) && raw.topics.length > 0 && typeof raw.topics[0] === "object" && "type" in (raw.topics[0] as object)) {
      topics = raw.topics as ScVal[];
    } else if (Array.isArray(raw.topic) && raw.topic.length > 0 && typeof raw.topic[0] === "object" && "type" in (raw.topic[0] as object)) {
      topics = raw.topic as ScVal[];
    } else {
      // Fallback: If not ScVal array, cannot safely decode with SDK decoder
      return null;
    }

    let data: ScVal[] = [];
    if (Array.isArray(raw.data)) {
      data = raw.data as ScVal[];
    } else if (Array.isArray(raw.value)) {
      data = raw.value as ScVal[];
    }

    return {
      contract: raw.contractId,
      topics,
      data,
      ledger_sequence: raw.ledger,
      tx_index_in_ledger: raw.tx_index_in_ledger ?? 0,
      event_index_in_tx: raw.event_index_in_tx ?? 0,
      tx_hash: raw.txHash ?? "",
    };
  } catch {
    return null;
  }
}

export interface IngestEventsResult {
  processed: number;
  stored: number;
  skipped: number;
  lastLedger: number;
}

/**
 * Ingest and process a list of raw Soroban RPC events.
 * Idempotently saves to tls_contract_events and updates cursor.
 */
export async function ingestEvents(
  events: SorobanRpcEventResponse[],
  cursorId: string = "default",
  newCursorLedger?: number,
): Promise<IngestEventsResult> {
  let stored = 0;
  let skipped = 0;
  let maxLedgerSeen = 0;

  for (const raw of events) {
    if (raw.ledger > maxLedgerSeen) {
      maxLedgerSeen = raw.ledger;
    }

    const eventId = raw.id;
    if (!eventId) {
      skipped++;
      continue;
    }

    const normalized = normalizeRpcEvent(raw);
    let decodedPayload: Record<string, unknown> | null = null;
    let topicSymbol = "unknown";
    let eventVersion: number | null = null;

    if (normalized && normalized.topics.length > 0) {
      topicSymbol = String(normalized.topics[0].value ?? "unknown");
      try {
        const decoded = decodeContractEvent(normalized);
        decodedPayload = decoded as unknown as Record<string, unknown>;
        if (decoded.data && typeof decoded.data === "object" && "version" in decoded.data && typeof decoded.data.version === "number") {
          eventVersion = decoded.data.version;
        }
      } catch (err) {
        if (err instanceof UnknownContractEventError) {
          logger.warn(
            { event: "contract_event_unknown_type", eventId, symbol: err.symbol },
            `Skipping unknown contract event type: ${err.symbol}`,
          );
          skipped++;
        } else if (err instanceof UnsupportedContractVersionError) {
          logger.warn(
            { event: "contract_event_unsupported_version", eventId, version: err.version },
            `Skipping unsupported contract event version: ${err.version}`,
          );
          skipped++;
        } else if (err instanceof MalformedContractEventError || err instanceof ContractEventError) {
          logger.warn(
            { event: "contract_event_decode_error", eventId, err: (err as Error).message },
            `Skipping malformed contract event: ${(err as Error).message}`,
          );
          skipped++;
        } else {
          logger.error(
            { event: "contract_event_unexpected_error", eventId, err: String(err) },
            `Unexpected error decoding event: ${String(err)}`,
          );
          skipped++;
        }
      }
    } else {
      skipped++;
    }

    // Insert into DB if decoded or raw event is valid
    try {
      await db
        .insert(tlsContractEvents)
        .values({
          id: eventId,
          contractId: raw.contractId,
          ledger: raw.ledger,
          ledgerClosedAt: raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt).toISOString() : null,
          txHash: raw.txHash ?? "",
          topic: topicSymbol,
          topics: (normalized?.topics ?? raw.topics ?? raw.topic ?? null) as unknown as Record<string, unknown>,
          data: (normalized?.data ?? raw.data ?? raw.value ?? null) as unknown as Record<string, unknown>,
          decodedPayload: decodedPayload as unknown as Record<string, unknown>,
          eventVersion,
          createdAt: new Date().toISOString(),
        } as any)
        .onConflictDoNothing({ target: tlsContractEvents.id });


      stored++;
    } catch (dbErr) {
      logger.error(
        { event: "contract_event_db_insert_failed", eventId, err: String(dbErr) },
        "Failed to insert contract event into DB",
      );
    }
  }

  const targetLedger = newCursorLedger ?? (maxLedgerSeen > 0 ? maxLedgerSeen : null);
  if (targetLedger !== null) {
    await saveCursor(targetLedger, cursorId);
  }

  return {
    processed: events.length,
    stored,
    skipped,
    lastLedger: targetLedger ?? 0,
  };
}

/**
 * Single polling pass: checks getEvents from the persisted cursor ledger.
 */
export async function pollContractEventsOnce(
  config: EventIndexerConfig = defaultIndexerConfig,
  customClient?: { getEvents: (params: unknown) => Promise<{ events?: SorobanRpcEventResponse[]; latestLedger?: number }> },
): Promise<IngestEventsResult | null> {
  const currentCursor = await getPersistedCursor(config.cursorId);
  const startLedger = currentCursor !== null ? currentCursor + 1 : config.defaultStartLedger;

  const contractIds = getMonitoredContractIds();
  const server = customClient ?? (await getSorobanClient());

  let response: { events?: SorobanRpcEventResponse[]; latestLedger?: number };
  try {
    const params: {
      startLedger: number;
      filters?: Array<{ type?: string; contractIds?: string[] }>;
      limit?: number;
    } = {
      startLedger,
      limit: config.batchLimit,
    };

    if (contractIds.length > 0) {
      params.filters = [
        {
          type: "contract",
          contractIds,
        },
      ];
    }

    response = (await (server as any).getEvents(params as any)) as any;
  } catch (rpcErr) {
    logger.error(
      { event: "contract_events_get_events_failed", startLedger, err: String(rpcErr) },
      "Soroban RPC getEvents call failed",
    );
    return null;
  }

  const events = response.events ?? [];
  const latestLedger = response.latestLedger;

  // Even if 0 events returned, update cursor forward if latestLedger advanced
  const newCursor = latestLedger && latestLedger >= startLedger ? latestLedger : (events.length > 0 ? Math.max(...events.map((e) => e.ledger)) : startLedger - 1);

  return await ingestEvents(events, config.cursorId, newCursor > 0 ? newCursor : undefined);
}
