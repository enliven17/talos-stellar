import { NextRequest } from "next/server";
import { withTraceContext } from "@/lib/tracing";
import { resolveTalosFromRequest } from "@/lib/auth";

// GET /api/talos/me — Resolve TALOS from API key (Bearer token)
async function handleGet(request: NextRequest) {
  try {
    const auth = await resolveTalosFromRequest(request);
    if (!auth.ok) return auth.response;

    return Response.json(auth.talos);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
