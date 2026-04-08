import { fetchActivityStats, fetchActivityTransactions } from "./query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "25", 10) || 25, 1), 100);
  const cursor = searchParams.get("cursor");
  const statsOnly = searchParams.get("statsOnly") === "true";

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
