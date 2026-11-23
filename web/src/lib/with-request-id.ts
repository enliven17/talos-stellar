import { NextRequest } from "next/server";
import { getRequestId } from "./api-response";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRouteHandler = (...args: any[]) => any;

/**
 * Wraps a route handler to ensure every response includes an x-request-id header.
 * Supports both Request and NextRequest, async and synchronous handlers.
 */
export function withRequestId<H extends AnyRouteHandler>(handler: H): H {
  return ((req?: Request | NextRequest, ...rest: unknown[]) => {
    const requestId = getRequestId(req);
    const request = req ?? new NextRequest("http://localhost");
    const result = handler(request, ...rest);
    if (result && typeof (result as Promise<Response>).then === "function") {
      return (result as Promise<Response>).then((res: Response) => {
        const newRes = new Response(res.body, res);
        newRes.headers.set("x-request-id", requestId);
        return newRes;
      });
    }
    const res = result as Response;
    const newRes = new Response(res?.body, res);
    newRes.headers.set("x-request-id", requestId);
    return newRes;
  }) as unknown as H;
}
