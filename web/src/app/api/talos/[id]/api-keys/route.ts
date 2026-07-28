import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApiKeys } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey, generateApiKey } from "@/lib/auth";
import { parseBody } from "@/lib/schemas";
import { createApiKeySchema } from "@/lib/schemas";

// GET /api/talos/:id/api-keys — List all keys (metadata only, no hashes)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["admin"]);
    if (!auth.ok) return auth.response;

    const keys = await db
      .select({
        id: tlsApiKeys.id,
        name: tlsApiKeys.name,
        scopes: tlsApiKeys.scopes,
        expiresAt: tlsApiKeys.expiresAt,
        lastUsedAt: tlsApiKeys.lastUsedAt,
        status: tlsApiKeys.status,
        createdAt: tlsApiKeys.createdAt,
        updatedAt: tlsApiKeys.updatedAt,
      })
      .from(tlsApiKeys)
      .where(eq(tlsApiKeys.talosId, id));

    return Response.json({ keys });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/api-keys — Create a new scoped key
// Returns the raw key ONCE. It cannot be retrieved again.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["admin"]);
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request, createApiKeySchema);
    if (parsed.error) return parsed.error;

    const { name, scopes, expiresAt } = parsed.data;

    const { raw, hash } = generateApiKey();

    const [key] = await db
      .insert(tlsApiKeys)
      .values({
        talosId: id,
        name,
        keyHash: hash,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .returning({
        id: tlsApiKeys.id,
        name: tlsApiKeys.name,
        scopes: tlsApiKeys.scopes,
        expiresAt: tlsApiKeys.expiresAt,
        status: tlsApiKeys.status,
        createdAt: tlsApiKeys.createdAt,
      });

    return Response.json(
      { ...key, apiKey: raw },
      { status: 201 }
    );
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
