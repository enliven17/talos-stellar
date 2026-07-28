import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApiKeys } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { parseBody } from "@/lib/schemas";
import { updateApiKeySchema } from "@/lib/schemas";

// PATCH /api/talos/:id/api-keys/:keyId — Update scopes, name, expiry
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const { id, keyId } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["admin"]);
    if (!auth.ok) return auth.response;

    const key = await db
      .select()
      .from(tlsApiKeys)
      .where(and(eq(tlsApiKeys.id, keyId), eq(tlsApiKeys.talosId, id)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!key) {
      return Response.json({ error: "API key not found" }, { status: 404 });
    }

    const parsed = await parseBody(request, updateApiKeySchema);
    if (parsed.error) return parsed.error;

    const { name, scopes, expiresAt } = parsed.data;
    const updates: Record<string, unknown> = {};

    if (name !== undefined) updates.name = name;
    if (scopes !== undefined) updates.scopes = scopes;
    if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No fields to update" }, { status: 400 });
    }

    const [updated] = await db
      .update(tlsApiKeys)
      .set(updates)
      .where(eq(tlsApiKeys.id, keyId))
      .returning({
        id: tlsApiKeys.id,
        name: tlsApiKeys.name,
        scopes: tlsApiKeys.scopes,
        expiresAt: tlsApiKeys.expiresAt,
        status: tlsApiKeys.status,
        createdAt: tlsApiKeys.createdAt,
        updatedAt: tlsApiKeys.updatedAt,
      });

    return Response.json(updated);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/talos/:id/api-keys/:keyId — Revoke a key (soft-delete)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; keyId: string }> }
) {
  const { id, keyId } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["admin"]);
    if (!auth.ok) return auth.response;

    const key = await db
      .select()
      .from(tlsApiKeys)
      .where(and(eq(tlsApiKeys.id, keyId), eq(tlsApiKeys.talosId, id)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!key) {
      return Response.json({ error: "API key not found" }, { status: 404 });
    }

    await db
      .update(tlsApiKeys)
      .set({ status: "revoked" })
      .where(eq(tlsApiKeys.id, keyId));

    return Response.json({ success: true, message: "API key revoked" });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
