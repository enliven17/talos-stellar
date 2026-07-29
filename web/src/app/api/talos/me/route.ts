import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withTraceContext } from "@/lib/tracing";

// GET /api/talos/me — Resolve TALOS from API key (Bearer token)
async function handleGet(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header. Use: Bearer <api_key>" },
      { status: 401 }
    );
  }

  const apiKey = authHeader.slice(7);

  try {
    const auth = await resolveTalosFromRequest(request);
    if (!auth.ok) return auth.response;

    return Response.json(auth.talos);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
