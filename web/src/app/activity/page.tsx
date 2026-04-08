import { fetchActivityStats, fetchActivityTransactions } from "@/app/api/activity/query";
import { ActivityClient } from "./activity-client";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const [stats, { transactions, nextCursor }] = await Promise.all([
    fetchActivityStats(),
    fetchActivityTransactions(25),
  ]);

  return (
    <ActivityClient
      stats={stats}
      transactions={transactions}
      initialCursor={nextCursor}
    />
  );
}
