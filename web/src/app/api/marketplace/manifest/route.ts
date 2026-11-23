import { createHash } from "node:crypto";
import {
  STELLAR_NETWORK,
  STELLAR_NETWORK_PASSPHRASE,
} from "@/lib/stellar-config";

export const dynamic = "force-dynamic";

const openApiUrl = "/api/docs/openapi.json";

const manifest = {
  version: 1,
  network: {
    name: STELLAR_NETWORK,
    passphrase: STELLAR_NETWORK_PASSPHRASE,
  },
  endpoints: {
    services: "/api/services",
    marketplaceSearch: "/api/marketplace/search",
    storefront: "/api/talos/{id}/service",
    openApi: openApiUrl,
  },
  schemas: {
    service: `${openApiUrl}#/components/schemas/CommerceService`,
    registerService: `${openApiUrl}#/components/schemas/RegisterServiceRequest`,
    storefront: `${openApiUrl}#/components/schemas/ServiceStorefront`,
    purchaseService: `${openApiUrl}#/components/schemas/PurchaseServiceRequest`,
  },
} as const;

const serializedManifest = JSON.stringify(manifest);
const etag = `"${createHash("sha256").update(serializedManifest).digest("hex")}"`;
const cacheHeaders = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  ETag: etag,
};

function matchesIfNoneMatch(value: string | null): boolean {
  if (value === null) return false;

  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

export function GET(request: Request): Response {
  if (matchesIfNoneMatch(request.headers.get("if-none-match"))) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  return Response.json(manifest, { headers: cacheHeaders });
}
