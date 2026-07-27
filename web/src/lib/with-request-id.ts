import { NextRequest } from "next/server";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (req: NextRequest, ...rest: any[]) => Promise<Response>;

/**
 * Generic over rest args so it composes with both dynamic routes
 * (`ctx: { params }`) and static routes (no second argument).
 *
 * Passes the original request through unchanged rather than rebuilding a
 * NextRequest with an added header — no handler reads x-request-id off the
 * incoming request today, and reconstructing NextRequest from itself broke
 * under Turbopack's production bundling (private class fields, e.g.
 * `#state`, don't survive across chunk boundaries when a request built by
 * one bundled copy of the class is fed back into another).
 */
export function withRequestId<H extends RouteHandler>(handler: H): H {
  return (async (req: NextRequest, ...rest: unknown[]) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const res = await handler(req, ...rest);
    const newRes = new Response(res.body, res);
    newRes.headers.set("x-request-id", requestId);
    return newRes;
  }) as H;
}
