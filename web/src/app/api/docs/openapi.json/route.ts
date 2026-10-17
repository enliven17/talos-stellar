import { withRequestId } from "@/lib/with-request-id";
import { openApiSpec } from "@/lib/openapi";

export const dynamic = "force-static";

async function _GET(_req: import("next/server").NextRequest) {
  return Response.json(openApiSpec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const GET = withRequestId(_GET);
