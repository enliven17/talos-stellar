/**
 * Example 02 — Service Discovery
 *
 * Demonstrates full service catalogue traversal:
 *   1. Fetch the first page of all available commerce services.
 *   2. Filter by category.
 *   3. Paginate until no more pages remain.
 *   4. Inspect an individual service record.
 *
 * Expected output (values vary per run):
 *   ✓ Page 1  count=20  nextCursor=<string|null>
 *   ✓ Page 2  count=12  nextCursor=null
 *   ✓ Total services discovered  total=32
 *   ✓ Sample service  name=<string>  price=<string>
 *
 * Environment variables required:
 *   TALOS_API_KEY   — operator or agent API key
 *   TALOS_API_URL   — optional
 */

import { TalosClient, TalosAPIError, type CommerceService } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const CATEGORY_FILTER = process.env.SERVICE_CATEGORY; // optional

if (!API_KEY) {
  console.error("ERROR: TALOS_API_KEY is required.");
  process.exit(1);
}

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all pages from a paginated discovery call.
 *
 * The loop is bounded by the server-controlled cursor mechanism — when
 * `nextCursor` is null the traversal terminates deterministically regardless
 * of catalogue size.
 */
async function collectAllServices(category?: string): Promise<CommerceService[]> {
  const allServices: CommerceService[] = [];
  let cursor: string | undefined;
  let page = 1;

  while (true) {
    const resp = await client.discoverServices({
      category,
      cursor,
      limit: 20,
    });

    console.log(`✓ Page ${page}  count=${resp.data.length}  nextCursor=${resp.nextCursor ?? "null"}`);
    allServices.push(...resp.data);

    if (!resp.nextCursor) break;
    cursor = resp.nextCursor;
    page++;
  }

  return allServices;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Paginate all services (optionally filtered by category)
  const services = await collectAllServices(CATEGORY_FILTER);
  console.log(`✓ Total services discovered  total=${services.length}`);

  // Step 2: Inspect the first result if any
  if (services.length > 0) {
    const sample = services[0];
    console.log(`✓ Sample service  name=${sample.serviceName}  price=${sample.price}  currency=${sample.currency}`);
    console.log(`  fulfillmentMode=${sample.fulfillmentMode}  chains=${sample.chains.join(",")}`);
  } else {
    console.log("  (no services found — try without category filter)");
  }

  // Step 3: Demonstrate category filtering  
  const analytics = await client.discoverServices({ category: "Analytics", limit: 5 });
  console.log(`✓ Analytics filter  count=${analytics.data.length}`);
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
