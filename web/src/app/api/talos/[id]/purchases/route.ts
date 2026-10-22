import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { verifyApiKeyOwnerProof } from "@/lib/api-key-owner-auth";
import { parseLimit } from "@/lib/parse-limit";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * GET /api/talos/:id/purchases
 *
 * List the services bought by (or on behalf of) the TALOS `id`, newest first.
 *
 * A purchase is a `tls_commerce_jobs` row whose `requesterTalosId` belongs to
 * this agent: either the agent itself (agent-to-agent purchase) or the owner's
 * human namespace (`human:<creator|wallet public key>`).
 *
 * Authorization is owner-scoped: the caller must either present an API key for
 * this TALOS (`commerce:read`) or a fresh wallet-ownership proof signed by the
 * agent's creator/wallet key. Non-owners receive 403.
 *
 * Pagination is keyset-based on `createdAt` descending. Pass the previously
 * returned `nextCursor` as the `cursor` query param. When no more rows remain
 * `nextCursor` is null.
 */
async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const cursorRaw = searchParams.get("cursor");

  const parsedLimit = parseLimit(searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = parsedLimit.limit;

  try {
    const talos = await db
      .select({
        id: tlsTalos.id,
        creatorPublicKey: tlsTalos.creatorPublicKey,
        walletPublicKey: tlsTalos.walletPublicKey,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Auth: owner wallet proof OR an owner-scoped API key.
    const walletProof = await verifyApiKeyOwnerProof(request, id, "purchases");
    if (!walletProof) {
      const auth = await verifyAgentApiKey(request, id, ["commerce:read"]);
      if (!auth.ok) return auth.response;
    }

    let cursorDate: Date | null = null;
    if (cursorRaw) {
      const parsed = new Date(cursorRaw);
      if (Number.isNaN(parsed.getTime())) {
        return Response.json(
          { error: "cursor must be a valid ISO-8601 timestamp" },
          { status: 400 },
        );
      }
      cursorDate = parsed;
    }

    // Requester identities that belong to this agent or its owner.
    const requesterIds = [id];
    if (talos.creatorPublicKey) requesterIds.push(`human:${talos.creatorPublicKey}`);
    if (talos.walletPublicKey) requesterIds.push(`human:${talos.walletPublicKey}`);

    const conditions = [inArray(tlsCommerceJobs.requesterTalosId, requesterIds)];
    if (cursorDate) conditions.push(lt(tlsCommerceJobs.createdAt, cursorDate));

    const rows = await db
      .select({
        id: tlsCommerceJobs.id,
        providerId: tlsCommerceJobs.talosId,
        providerName: tlsTalos.name,
        serviceName: tlsCommerceJobs.serviceName,
        status: tlsCommerceJobs.status,
        price: tlsCommerceJobs.amount,
        txHash: tlsCommerceJobs.txHash,
        hasResult: sql<boolean>`${tlsCommerceJobs.result} is not null`,
        createdAt: tlsCommerceJobs.createdAt,
        updatedAt: tlsCommerceJobs.updatedAt,
      })
      .from(tlsCommerceJobs)
      .leftJoin(tlsTalos, eq(tlsCommerceJobs.talosId, tlsTalos.id))
      .where(and(...conditions))
      .orderBy(desc(tlsCommerceJobs.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? page[page.length - 1]?.createdAt.toISOString() ?? null
      : null;

    const purchases = page.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      providerName: row.providerName ?? "Unknown provider",
      serviceName: row.serviceName,
      status: row.status,
      price: Number(row.price),
      txHash: row.txHash,
      hasResult: Boolean(row.hasResult),
      resultUrl: `/api/jobs/${row.id}/result`,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return Response.json({ purchases, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);
