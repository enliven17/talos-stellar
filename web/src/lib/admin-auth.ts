import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

/**
 * Verifies the `Authorization: Bearer <ADMIN_API_KEY>` header used by
 * operator-only endpoints (outbox admin inspection).
 *
 * Distinct from verifyAgentApiKey() in auth.ts, which checks a per-TALOS
 * key stored in the database — ADMIN_API_KEY is a single operator secret
 * from the environment, never persisted or scoped to an agent.
 *
 * Secure by default: if ADMIN_API_KEY isn't configured, every request is
 * rejected (500) rather than silently allowing access.
 */
export function verifyAdminKey(
  request: NextRequest,
): { ok: true } | { ok: false; response: Response } {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return {
      ok: false,
      response: Response.json({ error: "Admin API is not configured" }, { status: 500 }),
    };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <admin_api_key>" },
        { status: 401 },
      ),
    };
  }

  const token = authHeader.slice(7);
  if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return { ok: false, response: Response.json({ error: "Invalid admin API key" }, { status: 403 }) };
  }

  return { ok: true };
}

/**
 * Verifies a shared-secret header used by scheduler-triggered internal
 * endpoints (e.g. the outbox drain route) — not a human operator, hence a
 * narrower-scoped secret than ADMIN_API_KEY.
 */
export function verifyInternalSecret(
  request: NextRequest,
  envVar: string,
  headerName: string,
): { ok: true } | { ok: false; response: Response } {
  const expected = process.env[envVar];
  if (!expected) {
    return {
      ok: false,
      response: Response.json({ error: "Internal trigger is not configured" }, { status: 500 }),
    };
  }

  const token = request.headers.get(headerName) ?? "";
  if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return { ok: false, response: Response.json({ error: "Invalid or missing secret" }, { status: 403 }) };
  }

  return { ok: true };
}
