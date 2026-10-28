import {
  decodeActivityCursor,
  fetchActivityStats,
  fetchActivityTransactions,
  InvalidActivityCursorError,
} from "./query";
import { parseLimit, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from "@/lib/limits";
import { errorResponse } from "@/lib/api-response";
import { withRequestId } from "@/lib/with-request-id";

export const dynamic = "force-dynamic";

const ACTIVITY_EXPORT_MAX_ROWS = 10_000;
const ACTIVITY_EXPORT_BATCH_SIZE = ACTIVITY_MAX_LIMIT;
const ACTIVITY_EXPORT_TYPES = ["all", "service", "playbook"] as const;
type ActivityExportType = (typeof ACTIVITY_EXPORT_TYPES)[number];

function escapeCsvCell(value: string | number): string {
  const text = String(value);
  const safeText = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function activityCsv(transactions: Awaited<ReturnType<typeof fetchActivityTransactions>>["transactions"]): string {
  const header = "timestamp,type,buyer,seller,item,amount,currency,status";
  const rows = transactions.map((transaction) => [
    transaction.timestamp,
    transaction.type,
    transaction.buyerName,
    transaction.sellerName,
    transaction.itemName,
    transaction.amount,
    transaction.currency,
    transaction.status,
  ].map(escapeCsvCell).join(","));

  return [header, ...rows].join("\r\n") + "\r\n";
}

async function exportActivityCsv(request: Request, type: ActivityExportType) {
  let cursor: string | null = null;
  const transactions: Awaited<ReturnType<typeof fetchActivityTransactions>>["transactions"] = [];

  try {
    do {
      const page = await fetchActivityTransactions(
        ACTIVITY_EXPORT_BATCH_SIZE,
        cursor,
        type === "all" ? null : type,
      );
      transactions.push(...page.transactions);

      if (
        transactions.length > ACTIVITY_EXPORT_MAX_ROWS ||
        (transactions.length === ACTIVITY_EXPORT_MAX_ROWS && page.nextCursor)
      ) {
        return errorResponse(request, 413, "EXPORT_TOO_LARGE", "Activity export exceeds the 10,000 row limit");
      }

      if (page.nextCursor && (!page.transactions.length || page.nextCursor === cursor)) {
        throw new Error("Activity export pagination did not advance");
      }
      cursor = page.nextCursor;
    } while (cursor);

    return new Response(activityCsv(transactions), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="activity.csv"',
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return errorResponse(request, 500, "INTERNAL_ERROR", "An unexpected error occurred");
  }
}

async function _GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format");
  if (format !== null && format !== "csv") {
    return errorResponse(request, 400, "BAD_REQUEST", "Invalid activity format");
  }

  if (format === "csv") {
    if (searchParams.has("limit") || searchParams.has("cursor") || searchParams.has("statsOnly")) {
      return errorResponse(request, 400, "BAD_REQUEST", "CSV exports do not accept pagination parameters");
    }
    const rawType = searchParams.get("type") ?? "all";
    if (!ACTIVITY_EXPORT_TYPES.includes(rawType as ActivityExportType)) {
      return errorResponse(request, 400, "BAD_REQUEST", "Invalid activity type");
    }
    return exportActivityCsv(request, rawType as ActivityExportType);
  }

  const parsedLimit = parseLimit(searchParams.get("limit"), ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT);
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = parsedLimit.limit;
  const cursor = searchParams.get("cursor");
  const statsOnly = searchParams.get("statsOnly") === "true";

  if (cursor) {
    try {
      decodeActivityCursor(cursor);
    } catch (error) {
      if (error instanceof InvalidActivityCursorError) {
        return errorResponse(request, 400, "BAD_REQUEST", "Invalid cursor");
      }
      throw error;
    }
  }

  try {
    if (statsOnly) {
      const stats = await fetchActivityStats();
      return Response.json({ stats });
    }

    const [stats, { transactions, nextCursor }] = await Promise.all([
      fetchActivityStats(),
      fetchActivityTransactions(limit, cursor),
    ]);

    return Response.json({ stats, transactions, nextCursor });
  } catch {
    return errorResponse(request, 500, "INTERNAL_ERROR", "An unexpected error occurred");
  }
}

export const GET = withRequestId(_GET);
