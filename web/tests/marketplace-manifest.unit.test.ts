import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/marketplace/manifest/route";
import {
  STELLAR_NETWORK,
  STELLAR_NETWORK_PASSPHRASE,
} from "../src/lib/stellar-config";

function request(ifNoneMatch?: string): Request {
  const headers = new Headers();
  if (ifNoneMatch !== undefined) headers.set("If-None-Match", ifNoneMatch);
  return new Request("http://localhost/api/marketplace/manifest", { headers });
}

describe("GET /api/marketplace/manifest", () => {
  it("publishes service schemas and public Stellar network identity without operator configuration", async () => {
    const response = GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.network).toEqual({
      name: STELLAR_NETWORK,
      passphrase: STELLAR_NETWORK_PASSPHRASE,
    });
    expect(body.endpoints).toMatchObject({
      services: "/api/services",
      marketplaceSearch: "/api/marketplace/search",
      storefront: "/api/talos/{id}/service",
      openApi: "/api/docs/openapi.json",
    });
    expect(body.schemas).toEqual({
      service: "/api/docs/openapi.json#/components/schemas/CommerceService",
      registerService: "/api/docs/openapi.json#/components/schemas/RegisterServiceRequest",
      storefront: "/api/docs/openapi.json#/components/schemas/ServiceStorefront",
      purchaseService: "/api/docs/openapi.json#/components/schemas/PurchaseServiceRequest",
    });
    expect(JSON.stringify(body)).not.toMatch(/operator|secret|rpc|facilitator|api.?key/i);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("returns an empty 304 for a matching weak validator in a validator list", async () => {
    const initialResponse = GET(request());
    const etag = initialResponse.headers.get("etag");
    expect(etag).not.toBeNull();

    const response = GET(request(`"stale", W/${etag}`));

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(await response.text()).toBe("");
  });

  it("returns the manifest when the supplied validator is stale", async () => {
    const response = GET(request('W/"stale"'));

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("network");
  });
});
