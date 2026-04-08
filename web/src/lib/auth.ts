import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Verify API key from Authorization header against the TALOS's stored key.
 * Returns the talos record if valid, or a Response error to return early.
 */
export async function verifyAgentApiKey(
  request: NextRequest,
  talosId: string,
): Promise<
  | { ok: true; talos: { id: string; apiKey: string | null } }
  | { ok: false; response: Response }
> {
  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 },
      ),
    };
  }

  const token = authHeader.slice(7);

  const talos = await db
    .select({ id: tlsTalos.id, apiKey: tlsTalos.apiKey })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, talosId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!talos) {
    return {
      ok: false,
      response: Response.json({ error: "TALOS not found" }, { status: 404 }),
    };
  }

  if (
    !talos.apiKey ||
    talos.apiKey.length !== token.length ||
    !timingSafeEqual(Buffer.from(talos.apiKey), Buffer.from(token))
  ) {
    return {
      ok: false,
      response: Response.json({ error: "Invalid API key" }, { status: 403 }),
    };
  }

  return { ok: true, talos };
}
