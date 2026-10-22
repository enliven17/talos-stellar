import { withRequestId } from "@/lib/with-request-id";
import { openApiSpec } from "@/lib/openapi";

export const dynamic = "force-static";

function _GET(_req?: import("next/server").NextRequest) {
  return Response.json(openApiSpec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}

const wrappedGet = withRequestId(_GET);

export function GET(): Response;
export function GET(request: import("next/server").NextRequest): Response;
export function GET(request?: import("next/server").NextRequest): Response {
  return wrappedGet(request);
}

