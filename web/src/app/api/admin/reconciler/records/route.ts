import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { tlsStellarTxRecords } from "@/db/schema";
import { verifyAdminKey } from "@/lib/admin-auth";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const ALLOWED_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
  "mismatch",
] as const;

type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

export type ReconcilerRecordDTO = {
  id: string;
  txHashTruncated: string;
  sourceType: string;
  sourceId: string;
  finalityStatus: string;
  pollCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordsResponse = {
  records: ReconcilerRecordDTO[];
  nextCursor: string | null;
};

function truncateHash(hash: string | null | undefined): string {
  if (!hash) return "";
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id })).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
      u?: unknown;
      i?: unknown;
    };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    const updatedAt = new Date(parsed.u);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id: parsed.i };
  } catch {
    return null;
  }
}

function isAllowedStatus(value: string): value is AllowedStatus {
  return (ALLOWED_STATUSES as readonly string[]).includes(value);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await verifyAdminKey(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const cursorParam = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");

  if (statusParam && !isAllowedStatus(statusParam)) {
    return NextResponse.json(
      { error: "invalid status filter", allowed: ALLOWED_STATUSES },
      { status: 400 },
    );
  }

  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const conditions = [];
  if (statusParam) {
    conditions.push(eq(tlsStellarTxRecords.finalityStatus, statusParam));
  }

  if (cursorParam) {
    const decoded = decodeCursor(cursorParam);
    if (!decoded) {
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    }
    conditions.push(
      or(
        lt(tlsStellarTxRecords.updatedAt, decoded.updatedAt),
        and(
          eq(tlsStellarTxRecords.updatedAt, decoded.updatedAt),
          lt(tlsStellarTxRecords.id, decoded.id),
        ),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: tlsStellarTxRecords.id,
      txHash: tlsStellarTxRecords.txHash,
      sourceType: tlsStellarTxRecords.sourceType,
      sourceId: tlsStellarTxRecords.sourceId,
      finalityStatus: tlsStellarTxRecords.finalityStatus,
      pollCount: tlsStellarTxRecords.pollCount,
      lastError: tlsStellarTxRecords.lastError,
      createdAt: tlsStellarTxRecords.createdAt,
      updatedAt: tlsStellarTxRecords.updatedAt,
    })
    .from(tlsStellarTxRecords)
    .where(where)
    .orderBy(desc(tlsStellarTxRecords.updatedAt), desc(tlsStellarTxRecords.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  const records: ReconcilerRecordDTO[] = page.map((row) => ({
    id: row.id,
    txHashTruncated: truncateHash(row.txHash),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    finalityStatus: row.finalityStatus,
    pollCount: row.pollCount ?? 0,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  const body: RecordsResponse = { records, nextCursor };
  return NextResponse.json(body, { status: 200 });
}
