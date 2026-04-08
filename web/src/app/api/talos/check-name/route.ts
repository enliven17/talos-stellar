import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isNameAvailableOnChain } from "@/lib/soroban";

// GET /api/talos/check-name?name=foo
export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.toLowerCase().trim();

  if (!name || name.length < 3) {
    return Response.json({ available: false, reason: "Name must be at least 3 characters" });
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || /--/.test(name)) {
    return Response.json({ available: false, reason: "Invalid format" });
  }

  // Check DB first (fast path)
  const existing = await db
    .select({ id: tlsTalos.id })
    .from(tlsTalos)
    .where(eq(tlsTalos.agentName, name))
    .limit(1);

  if (existing.length > 0) {
    return Response.json({ available: false, reason: "Name already taken" });
  }

  // Check Stellar Soroban TalosNameService on-chain
  try {
    const onChainAvailable = await isNameAvailableOnChain(name);
    if (!onChainAvailable) {
      return Response.json({ available: false, reason: "Name already registered on-chain" });
    }
  } catch {
    // On-chain check failed — fall back to DB result
  }

  return Response.json({ available: true });
}
