import {
  decodeActivityCursor,
  fetchActivityStats,
  fetchActivityTransactions,
  InvalidActivityCursorError,
} from "./query";
import { parseLimit } from "@/lib/parse-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsedLimit = parseLimit(searchParams.get("limit"), 25, 100);
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = parsedLimit.limit;
  const cursor = searchParams.get("cursor");
  const statsOnly = searchParams.get("statsOnly") === "true";

  if (cursor) {
    try {
      decodeActivityCursor(cursor);
    } catch (error) {
      if (error instanceof InvalidActivityCursorError) {
        return Response.json({ error: "Invalid cursor" }, { status: 400 });
      }
      throw error;
    }
  }

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
    return internalError(request);
  }
}
