import { db } from "@/db";
import { tlsContractEvents } from "@/db/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";

export interface ListContractEventsParams {
  contractId?: string;
  topic?: string;
  cursor?: string;
  limit?: number;
}

export interface ContractEventItem {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date | string | null;
  txHash: string;
  topic: string;
  topics: unknown;
  data: unknown;
  decodedPayload: unknown;
  eventVersion: number | null;
  createdAt: Date | string;
}

export interface ListContractEventsResult {
  events: ContractEventItem[];
  nextCursor: string | null;
}

/**
 * Query indexed contract events with cursor pagination.
 *
 * Cursor format: `${ledger}_${id}` or simply `id` (or base64 encoded cursor).
 * By default, sorts descending by ledger, then by id to ensure deterministic pagination.
 */
export async function listContractEvents(
  params: ListContractEventsParams = {},
): Promise<ListContractEventsResult> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const conditions = [];

  if (params.contractId) {
    conditions.push(eq(tlsContractEvents.contractId, params.contractId));
  }

  if (params.topic) {
    conditions.push(eq(tlsContractEvents.topic, params.topic));
  }

  if (params.cursor) {
    let cursorLedger: number | null = null;
    let cursorId: string | null = null;

    if (params.cursor.includes("_")) {
      const [ledgerStr, ...rest] = params.cursor.split("_");
      const parsedLedger = parseInt(ledgerStr, 10);
      if (!isNaN(parsedLedger)) {
        cursorLedger = parsedLedger;
        cursorId = rest.join("_");
      }
    }

    if (cursorLedger !== null && cursorId !== null) {
      conditions.push(
        sql`(${tlsContractEvents.ledger} < ${cursorLedger} OR (${tlsContractEvents.ledger} = ${cursorLedger} AND ${tlsContractEvents.id} < ${cursorId}))`,
      );
    } else {
      // Look up ledger for the cursor id
      const cursorRow = await db
        .select({ ledger: tlsContractEvents.ledger, id: tlsContractEvents.id })
        .from(tlsContractEvents)
        .where(eq(tlsContractEvents.id, params.cursor))
        .limit(1);

      if (cursorRow.length > 0) {
        conditions.push(
          sql`(${tlsContractEvents.ledger} < ${cursorRow[0].ledger} OR (${tlsContractEvents.ledger} = ${cursorRow[0].ledger} AND ${tlsContractEvents.id} < ${cursorRow[0].id}))`,
        );
      }
    }
  }

  const query = db
    .select()
    .from(tlsContractEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tlsContractEvents.ledger), desc(tlsContractEvents.id))
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;

  const nextCursor =
    hasMore && events.length > 0
      ? `${events[events.length - 1].ledger}_${events[events.length - 1].id}`
      : null;

  return {
    events,
    nextCursor,
  };
}
