import {
  decodeActivityCursor,
  fetchActivityStats,
  fetchActivityTransactions,
  InvalidActivityCursorError,
} from "./query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "25", 10) || 25, 1), 100);
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
}
