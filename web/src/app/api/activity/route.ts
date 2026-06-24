import { fetchActivityStats, fetchActivityTransactions } from "./query";
import { withRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = withRateLimit(
  async (request: Request) => {
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
},
{ limit: 120, windowMs: 60 * 1000 }, // 120/min
"activity",
);
