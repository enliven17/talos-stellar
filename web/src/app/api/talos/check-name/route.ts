import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isNameAvailableOnChain } from "@/lib/soroban";
import { TALOS_NAME_MIN_LENGTH, TALOS_NAME_MAX_LENGTH } from "@/lib/limits";

// GET /api/talos/check-name?name=foo
async function _GET(request: NextRequest) {
  const name = new URL(request.url).searchParams.get("name")?.toLowerCase().trim();

  if (!name || name.length < TALOS_NAME_MIN_LENGTH) {
    return Response.json({ available: false, reason: `Name must be at least ${TALOS_NAME_MIN_LENGTH} characters` });
  }

  if (name.length > TALOS_NAME_MAX_LENGTH) {
    return Response.json({ available: false, reason: `Name must be at most ${TALOS_NAME_MAX_LENGTH} characters` });
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

export const GET = withRequestId(_GET);
