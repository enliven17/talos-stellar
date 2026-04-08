import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsCommerceServices } from "@/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { createAgentKeypair, fundTestnetAccount } from "@/lib/stellar";
import { createTalosSchema, parseBody } from "@/lib/schemas";

// GET /api/talos — List TALOS entries with cursor-based pagination
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

    const patronCount = db
      .select({
        talosId: tlsPatrons.talosId,
        count: sql<number>`count(*)::int`.as("count"),
      })
      .from(tlsPatrons)
      .groupBy(tlsPatrons.talosId)
      .as("patronCount");

    const conditions = [];
    if (cursor) {
      const [cursorDate, cursorId] = cursor.split("|");
      if (cursorDate && cursorId) {
        conditions.push(
          or(
            lt(tlsTalos.createdAt, new Date(cursorDate)),
            and(
              eq(tlsTalos.createdAt, new Date(cursorDate)),
              lt(tlsTalos.id, cursorId),
            ),
          )!,
        );
      }
    }

    const entries = await db
      .select({
        id: tlsTalos.id,
        onChainId: tlsTalos.onChainId,
        agentName: tlsTalos.agentName,
        name: tlsTalos.name,
        category: tlsTalos.category,
        description: tlsTalos.description,
        status: tlsTalos.status,
        stellarAssetCode: tlsTalos.stellarAssetCode,
        pulsePrice: tlsTalos.pulsePrice,
        totalSupply: tlsTalos.totalSupply,
        creatorShare: tlsTalos.creatorShare,
        investorShare: tlsTalos.investorShare,
        treasuryShare: tlsTalos.treasuryShare,
        persona: tlsTalos.persona,
        targetAudience: tlsTalos.targetAudience,
        channels: tlsTalos.channels,
        toneVoice: tlsTalos.toneVoice,
        approvalThreshold: tlsTalos.approvalThreshold,
        gtmBudget: tlsTalos.gtmBudget,
        minPatronPulse: tlsTalos.minPatronPulse,
        agentOnline: tlsTalos.agentOnline,
        agentLastSeen: tlsTalos.agentLastSeen,
        walletPublicKey: tlsTalos.walletPublicKey,
        creatorPublicKey: tlsTalos.creatorPublicKey,
        investorPublicKey: tlsTalos.investorPublicKey,
        treasuryPublicKey: tlsTalos.treasuryPublicKey,
        createdAt: tlsTalos.createdAt,
        updatedAt: tlsTalos.updatedAt,
        patrons: patronCount.count,
      })
      .from(tlsTalos)
      .leftJoin(patronCount, eq(tlsTalos.id, patronCount.talosId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tlsTalos.createdAt), desc(tlsTalos.id))
      .limit(limit + 1);

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const data = page.map((c) => ({ ...c, patrons: c.patrons ?? 0 }));

    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem
      ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
      : null;

    return Response.json({ data, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos — Create a new TALOS (Genesis)
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseBody(request, createTalosSchema);
    if (parsed.error) return parsed.error;

    const {
      name,
      category,
      description,
      totalSupply: supply,
      persona,
      targetAudience,
      channels,
      approvalThreshold,
      gtmBudget,
      creatorPublicKey,
      walletPublicKey,
      onChainId,
      agentName,
      toneVoice,
      initialPrice,
      minPatronPulse,
      stellarAssetCode,
      tokenSymbol,
      serviceName,
      serviceDescription,
      servicePrice,
    } = parsed.data;

    // Generate API key (tak_ prefix = TALOS API Key)
    const apiKey = `tak_${randomBytes(24).toString("hex")}`;

    // Create Stellar keypair for the agent wallet
    let agentWalletId: string | null = null;
    let agentWalletAddress: string | null = null;
    try {
      const keypair = await createAgentKeypair();
      agentWalletId = keypair.publicKey;
      agentWalletAddress = keypair.publicKey;
      // Fund testnet account (best-effort, non-blocking)
      fundTestnetAccount(keypair.publicKey).catch(() => {});
    } catch (err) {
      console.error("Stellar keypair creation failed:", err);
    }

    const [talos] = await db
      .insert(tlsTalos)
      .values({
        name,
        category,
        description,
        apiKey,
        totalSupply: supply,
        creatorShare: 0,
        investorShare: 0,
        treasuryShare: 100,
        persona,
        targetAudience,
        channels: channels ?? [],
        toneVoice: toneVoice ?? null,
        approvalThreshold: String(approvalThreshold ?? 10),
        gtmBudget: String(gtmBudget ?? 200),
        pulsePrice: String(initialPrice ?? 0),
        minPatronPulse: minPatronPulse ?? null,
        creatorPublicKey,
        walletPublicKey,
        onChainId: onChainId ?? null,
        agentName: agentName ?? null,
        stellarAssetCode: stellarAssetCode ?? null,
        tokenSymbol: tokenSymbol ?? null,
        agentWalletId,
        agentWalletAddress,
      })
      .returning();

    // Create initial Patron (Creator)
    const CREATOR_GOVERNANCE_FRACTION = 0.6;
    if (creatorPublicKey) {
      await db.insert(tlsPatrons).values({
        talosId: talos.id,
        stellarPublicKey: creatorPublicKey,
        role: "Creator",
        pulseAmount: Math.floor(supply * CREATOR_GOVERNANCE_FRACTION),
        share: "0",
      });
    }

    // Create Commerce Service if provided
    if (serviceName && servicePrice) {
      const serviceWallet = agentWalletAddress || creatorPublicKey || walletPublicKey;
      if (serviceWallet) {
        await db.insert(tlsCommerceServices).values({
          talosId: talos.id,
          serviceName,
          description: serviceDescription ?? description,
          price: String(servicePrice),
          stellarPublicKey: serviceWallet,
        });
      }
    }

    const { apiKey: generatedKey, ...safeTalos } = talos;
    return Response.json(
      { ...safeTalos, apiKeyOnce: generatedKey },
      { status: 201 },
    );
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    console.error("POST /api/talos error:", JSON.stringify({
      message: e?.message,
      code: e?.code,
      detail: e?.detail,
      constraint: e?.constraint,
    }, null, 2));
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
