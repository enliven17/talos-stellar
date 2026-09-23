import {
  decodeActivityCursor,
  fetchActivityStats,
  fetchActivityTransactions,
  InvalidActivityCursorError,
} from "./query";
import { parseLimit, ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from "@/lib/limits";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
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
