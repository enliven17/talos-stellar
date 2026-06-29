import { NextRequest } from "next/server";
import { randomUUID } from "crypto";

type RouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> }
) => Promise<Response>;

export function withRequestId(handler: RouteHandler): RouteHandler {
  return async (req, ctx) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const headers = new Headers(req.headers);
    headers.set("x-request-id", requestId);
    const newReq = new NextRequest(req, { headers });

    const res = await handler(newReq, ctx);
    const newRes = new Response(res.body, res);
    newRes.headers.set("x-request-id", requestId);
    return newRes;
  };
}
