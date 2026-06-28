import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getAccountInfo, verifyStellarSignature } from "@/lib/stellar";
import { becomePatronSchema, revokePatronSchema, parseBody } from "@/lib/schemas";

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
// Caller must sign a message containing both the TALOS id and the literal
// "register-patron" with their Stellar wallet, proving control of the key.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const parsed = await parseBody(request, becomePatronSchema);
    if (parsed.error) return parsed.error;

    const { stellarPublicKey, pulseAmount, signature, message } = parsed.data;

    // Bind the signature to this TALOS and this action to prevent replay
    // across TALOSes and across the register/revoke endpoints.
    if (!message.includes(id) || !message.includes("register-patron")) {
      return Response.json(
        {
          error:
            "Signature message must contain the TALOS id and the action 'register-patron'",
        },
        { status: 400 }
      );
    }

    const sigOk = await verifyStellarSignature(
      stellarPublicKey,
      message,
      signature
    );
    if (!sigOk) {
      return Response.json({ error: "Invalid signature" }, { status: 403 });
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
// Caller must sign a message containing both the TALOS id and the literal
// "revoke-patron" with their Stellar wallet, proving control of the key.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const parsed = await parseBody(request, revokePatronSchema);
    if (parsed.error) return parsed.error;

    const { stellarPublicKey, signature, message } = parsed.data;

    if (!message.includes(id) || !message.includes("revoke-patron")) {
      return Response.json(
        {
          error:
            "Signature message must contain the TALOS id and the action 'revoke-patron'",
        },
        { status: 400 }
      );
    }

    const sigOk = await verifyStellarSignature(
      stellarPublicKey,
      message,
      signature
    );
    if (!sigOk) {
      return Response.json({ error: "Invalid signature" }, { status: 403 });
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
