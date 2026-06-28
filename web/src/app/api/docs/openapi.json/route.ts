import { openApiSpec } from "@/lib/openapi";

export const dynamic = "force-static";

export function GET() {
  return Response.json(openApiSpec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}
