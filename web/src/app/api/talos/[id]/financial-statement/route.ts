import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { tlsTalos, tlsRevenues, tlsApprovals } from "@/db/schema";
import { verifyApiKeyOwnerProof } from "@/lib/api-key-owner-auth";
import {
  buildOwnerFinancialStatement,
  financialStatementToCsv,
  FINANCIAL_STATEMENT_MAX_ROWS,
} from "@/lib/financial-statement";

async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authorized = await verifyApiKeyOwnerProof(request, id, "financial-statement");
  if (!authorized) {
    return Response.json(
      { error: "Owner wallet proof required for financial statement" },
      { status: 401 },
    );
  }

  const talos = await db
    .select({
      id: tlsTalos.id,
      name: tlsTalos.name,
      agentName: tlsTalos.agentName,
      createdAt: tlsTalos.createdAt,
    })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!talos) {
    return Response.json({ error: "TALOS not found" }, { status: 404 });
  }

  const revenues = await db
    .select({
      id: tlsRevenues.id,
      amount: tlsRevenues.amount,
      source: tlsRevenues.source,
      txHash: tlsRevenues.txHash,
      createdAt: tlsRevenues.createdAt,
    })
    .from(tlsRevenues)
    .where(eq(tlsRevenues.talosId, id))
    .orderBy(desc(tlsRevenues.createdAt))
    .limit(FINANCIAL_STATEMENT_MAX_ROWS + 1);

  const approvals = await db
    .select({
      id: tlsApprovals.id,
      amount: tlsApprovals.amount,
      type: tlsApprovals.type,
      title: tlsApprovals.title,
      status: tlsApprovals.status,
      txHash: tlsApprovals.txHash,
      createdAt: tlsApprovals.createdAt,
      updatedAt: tlsApprovals.updatedAt,
    })
    .from(tlsApprovals)
    .where(eq(tlsApprovals.talosId, id))
    .orderBy(desc(tlsApprovals.createdAt))
    .limit(FINANCIAL_STATEMENT_MAX_ROWS + 1);

  const format = new URL(request.url).searchParams.get("format");
  if (format != null && format !== "json" && format !== "csv") {
    return Response.json(
      { error: "Invalid format; expected 'json' or 'csv'" },
      { status: 400 },
    );
  }

  const statement = buildOwnerFinancialStatement({
    talos,
    revenues,
    approvals,
    network: process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet",
  });

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const headers = {
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "X-Financial-Statement-Digest": statement.digest,
  };

  if (format === "csv") {
    return new Response(financialStatementToCsv(statement), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="talos-${safeId}-financial-statement.csv"`,
      },
    });
  }

  return Response.json(statement, {
    status: 200,
    headers: {
      ...headers,
      "Content-Disposition": `attachment; filename="talos-${safeId}-financial-statement.json"`,
    },
  });
}

export const GET = withRequestId(_GET);
