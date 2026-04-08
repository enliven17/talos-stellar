import { db } from "@/db";
import {
  tlsCommerceJobs,
  tlsCommerceServices,
  tlsPlaybookPurchases,
  tlsPlaybooks,
  tlsTalos,
} from "@/db/schema";
import { desc, eq, sql, count } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export type Transaction = {
  id: string;
  type: "service" | "playbook";
  sellerName: string;
  sellerAgent: string | null;
  buyerName: string;
  buyerAgent: string | null;
  itemName: string;
  amount: number;
  currency: string;
  status: string;
  timestamp: string;
  txHash: string | null;
};

export type ActivityStats = {
  totalTransactions: number;
  totalVolume: number;
  activeAgents: number;
  totalAgents: number;
  registeredServices: number;
  playbooksTraded: number;
};

export async function fetchActivityStats(): Promise<ActivityStats> {
  const [agentStats, registeredServiceCount, jobTotal, pbTotal] = await Promise.all([
    db
      .select({
        totalAgents: count(tlsTalos.id),
        activeAgents: sql<number>`count(*) filter (where ${tlsTalos.agentOnline} = true)::int`,
      })
      .from(tlsTalos)
      .then((r) => r[0]),
    db
      .select({ count: count(tlsCommerceServices.id) })
      .from(tlsCommerceServices)
      .then((r) => r[0]?.count ?? 0),
    db.select({ count: count(tlsCommerceJobs.id), vol: sql<number>`coalesce(sum(${tlsCommerceJobs.amount}::numeric), 0)::float` }).from(tlsCommerceJobs).then((r) => r[0]),
    db.select({ count: count(tlsPlaybookPurchases.id), vol: sql<number>`coalesce(sum(${tlsPlaybooks.price}::numeric), 0)::float` }).from(tlsPlaybookPurchases).innerJoin(tlsPlaybooks, eq(tlsPlaybookPurchases.playbookId, tlsPlaybooks.id)).then((r) => r[0]),
  ]);

  return {
    totalTransactions: (jobTotal?.count ?? 0) + (pbTotal?.count ?? 0),
    totalVolume: (jobTotal?.vol ?? 0) + (pbTotal?.vol ?? 0),
    activeAgents: agentStats?.activeAgents ?? 0,
    totalAgents: agentStats?.totalAgents ?? 0,
    registeredServices: registeredServiceCount,
    playbooksTraded: pbTotal?.count ?? 0,
  };
}

export async function fetchActivityTransactions(
  limit: number,
  cursor?: string | null,
): Promise<{ transactions: Transaction[]; nextCursor: string | null }> {
  const buyerTalos = alias(tlsTalos, "buyerTalos");
  const pbBuyerTalos = alias(tlsTalos, "pbBuyerTalos");

  let cursorDate: Date | null = null;
  if (cursor) {
    const dateStr = cursor.split("|")[0];
    if (dateStr) cursorDate = new Date(dateStr);
  }

  const jobCursorCond = cursorDate
    ? [sql`${tlsCommerceJobs.createdAt} < ${cursorDate}`]
    : [];
  const pbCursorCond = cursorDate
    ? [sql`${tlsPlaybookPurchases.createdAt} < ${cursorDate}`]
    : [];

  const [jobs, playbookTrades] = await Promise.all([
    db
      .select({
        id: tlsCommerceJobs.id,
        serviceName: tlsCommerceJobs.serviceName,
        amount: tlsCommerceJobs.amount,
        status: tlsCommerceJobs.status,
        txHash: tlsCommerceJobs.txHash,
        createdAt: tlsCommerceJobs.createdAt,
        sellerName: tlsTalos.name,
        sellerAgent: tlsTalos.agentName,
        buyerName: buyerTalos.name,
        buyerAgent: buyerTalos.agentName,
      })
      .from(tlsCommerceJobs)
      .leftJoin(tlsTalos, eq(tlsCommerceJobs.talosId, tlsTalos.id))
      .leftJoin(buyerTalos, eq(tlsCommerceJobs.requesterTalosId, buyerTalos.id))
      .where(jobCursorCond.length ? jobCursorCond[0] : undefined)
      .orderBy(desc(tlsCommerceJobs.createdAt))
      .limit(limit + 1),

    db
      .select({
        id: tlsPlaybookPurchases.id,
        buyerPublicKey: tlsPlaybookPurchases.buyerPublicKey,
        txHash: tlsPlaybookPurchases.txHash,
        createdAt: tlsPlaybookPurchases.createdAt,
        playbookTitle: tlsPlaybooks.title,
        playbookPrice: tlsPlaybooks.price,
        playbookCurrency: tlsPlaybooks.currency,
        sellerName: tlsTalos.name,
        sellerAgent: tlsTalos.agentName,
        buyerName: pbBuyerTalos.name,
        buyerAgent: pbBuyerTalos.agentName,
      })
      .from(tlsPlaybookPurchases)
      .innerJoin(tlsPlaybooks, eq(tlsPlaybookPurchases.playbookId, tlsPlaybooks.id))
      .leftJoin(tlsTalos, eq(tlsPlaybooks.talosId, tlsTalos.id))
      .leftJoin(
        pbBuyerTalos,
        sql`${pbBuyerTalos.id} = ${tlsPlaybookPurchases.buyerPublicKey} OR ${pbBuyerTalos.agentName} = ${tlsPlaybookPurchases.buyerPublicKey}`,
      )
      .where(pbCursorCond.length ? pbCursorCond[0] : undefined)
      .orderBy(desc(tlsPlaybookPurchases.createdAt))
      .limit(limit + 1),
  ]);

  const transactions: Transaction[] = [];

  for (const j of jobs) {
    transactions.push({
      id: j.id,
      type: "service",
      sellerName: j.sellerName ?? "Unknown",
      sellerAgent: j.sellerAgent ?? null,
      buyerName: j.buyerName ?? "Unknown",
      buyerAgent: j.buyerAgent ?? null,
      itemName: j.serviceName,
      amount: Number(j.amount),
      currency: "USDC",
      status: j.status,
      timestamp: j.createdAt.toISOString(),
      txHash: j.txHash ?? null,
    });
  }

  for (const p of playbookTrades) {
    transactions.push({
      id: p.id,
      type: "playbook",
      sellerName: p.sellerName ?? "Unknown",
      sellerAgent: p.sellerAgent ?? null,
      buyerName: p.buyerName ?? `${p.buyerPublicKey.slice(0, 6)}...${p.buyerPublicKey.slice(-4)}`,
      buyerAgent: p.buyerAgent ?? null,
      itemName: p.playbookTitle,
      amount: Number(p.playbookPrice),
      currency: p.playbookCurrency,
      status: "completed",
      timestamp: p.createdAt.toISOString(),
      txHash: p.txHash ?? null,
    });
  }

  transactions.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const hasMore = transactions.length > limit;
  const page = hasMore ? transactions.slice(0, limit) : transactions;

  const lastItem = page[page.length - 1];
  const nextCursor = hasMore && lastItem ? lastItem.timestamp : null;

  return { transactions: page, nextCursor };
}
