import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { createApiKeyOwnerMessage } from "@/lib/api-key-owner-message";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

export { createApiKeyOwnerMessage };

/**
 * Verify a wallet-ownership proof for any owner-scoped resource.
 *
 * The caller signs `talos:<id>:<resource>:<method>:<timestamp>` with the agent
 * owner's wallet; the address must match the agent's creator or wallet public
 * key and the signature must be fresh. `resource` defaults to `api-keys` for
 * backwards compatibility with the original scoped-key flow.
 */
export async function verifyApiKeyOwnerProof(
  request: NextRequest,
  talosId: string,
  resource = "api-keys",
): Promise<boolean> {
  const address = request.headers.get("x-talos-owner-address");
  const message = request.headers.get("x-talos-owner-message");
  const signature = request.headers.get("x-talos-owner-signature");
  if (!address || !message || !signature) return false;

  const escapedResource = resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = message.match(
    new RegExp(`^talos:([^:]+):${escapedResource}:(GET|POST|PATCH|DELETE):(\\d{13})$`),
  );
  if (!match || match[1] !== talosId || match[2] !== request.method) return false;

  const timestamp = Number(match[3]);
  if (Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) return false;

  const agent = await db
    .select({
      creatorPublicKey: tlsTalos.creatorPublicKey,
      walletPublicKey: tlsTalos.walletPublicKey,
    })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, talosId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (
    !agent ||
    (agent.creatorPublicKey !== address && agent.walletPublicKey !== address)
  ) {
    return false;
  }

  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    return Keypair.fromPublicKey(address).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export async function authorizeApiKeyManagement(
  request: NextRequest,
  talosId: string,
): Promise<Response | null> {
  if (await verifyApiKeyOwnerProof(request, talosId)) return null;
  const auth = await verifyAgentApiKey(request, talosId, ["admin"]);
  return auth.ok ? null : auth.response;
}
