import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getAccountInfo } from "@/lib/stellar";

// GET /api/talos/:id/patrons — List patrons for a TALOS
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const talos = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const patrons = await db
      .select()
      .from(tlsPatrons)
      .where(and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.status, "active")))
      .orderBy(desc(tlsPatrons.createdAt));

    return Response.json(patrons);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/patrons — Register as patron (requires min Pulse holding)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await request.json();
    const { stellarPublicKey, pulseAmount } = body;

    if (!stellarPublicKey) {
      return Response.json(
        { error: "stellarPublicKey is required" },
        { status: 400 }
      );
    }

    if (pulseAmount == null || typeof pulseAmount !== "number" || pulseAmount <= 0) {
      return Response.json(
        { error: "pulseAmount must be a positive number" },
        { status: 400 }
      );
    }

    const talos = await db
      .select({
        id: tlsTalos.id,
        totalSupply: tlsTalos.totalSupply,
        minPatronPulse: tlsTalos.minPatronPulse,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Calculate minimum threshold: explicit setting or 0.1% of totalSupply
    const minRequired = talos.minPatronPulse ?? Math.floor(talos.totalSupply * 0.001);

    if (pulseAmount < minRequired) {
      return Response.json(
        {
          error: `Minimum ${minRequired} Pulse required to become Patron`,
          minRequired,
          current: pulseAmount,
        },
        { status: 403 }
      );
    }

    // Verify on-chain token balance via Horizon
    // Check if the user actually holds the Pulse token
    const accountInfo = await getAccountInfo(stellarPublicKey);
    if (!accountInfo.exists) {
      return Response.json(
        { error: `Stellar account ${stellarPublicKey} does not exist` },
        { status: 400 }
      );
    }

    // Check if user has a trustline to the Pulse token
    // For now, we verify they have sufficient USDC as proof of funds
    // Once Soroban contracts are deployed, this will query the Pulse token balance
    const hasUsdc = parseFloat(accountInfo.usdcBalance) > 0;
    if (!hasUsdc) {
      return Response.json(
        { error: "Account has no USDC trustline. Establish USDC trustline first." },
        { status: 400 }
      );
    }

    // Check for existing active patron
    const existing = await db
      .select()
      .from(tlsPatrons)
      .where(
        and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.stellarPublicKey, stellarPublicKey))
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing && existing.status === "active") {
      return Response.json(
        { error: "Already a Patron of this TALOS" },
        { status: 409 }
      );
    }

    // Calculate share based on holdings
    const sharePercent = ((pulseAmount / talos.totalSupply) * 100).toFixed(2);

    // Re-activate revoked patron or create new one
    if (existing && existing.status === "revoked") {
      const [patron] = await db
        .update(tlsPatrons)
        .set({ status: "active", pulseAmount, role: "Investor", share: sharePercent })
        .where(eq(tlsPatrons.id, existing.id))
        .returning();
      return Response.json(patron, { status: 200 });
    }

    const [patron] = await db
      .insert(tlsPatrons)
      .values({
        talosId: id,
        stellarPublicKey,
        role: "Investor",
        pulseAmount,
        share: sharePercent,
      })
      .returning();

    return Response.json(patron, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/talos/:id/patrons — Withdraw patron status
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await request.json();
    const { stellarPublicKey } = body;

    if (!stellarPublicKey) {
      return Response.json(
        { error: "stellarPublicKey is required" },
        { status: 400 }
      );
    }

    const patron = await db
      .select()
      .from(tlsPatrons)
      .where(
        and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.stellarPublicKey, stellarPublicKey))
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!patron || patron.status !== "active") {
      return Response.json(
        { error: "No active Patron found for this wallet" },
        { status: 404 }
      );
    }

    // Creator cannot withdraw
    if (patron.role === "Creator") {
      return Response.json(
        { error: "Creator cannot withdraw Patron status" },
        { status: 403 }
      );
    }

    const [updated] = await db
      .update(tlsPatrons)
      .set({ status: "revoked" })
      .where(eq(tlsPatrons.id, patron.id))
      .returning();

    return Response.json(updated);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
