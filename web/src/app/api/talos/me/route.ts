import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";

// GET /api/talos/me — Resolve TALOS from API key (Bearer token)
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header. Use: Bearer <api_key>" },
      { status: 401 }
    );
  }

  const apiKey = authHeader.slice(7);

  try {
    const talos = await db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.apiKey, apiKey),
    });

    if (!talos) {
      return Response.json({ error: "Invalid API key" }, { status: 401 });
    }

    const { apiKey: _key, ...safeTalos } = talos;
    return Response.json(safeTalos);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
