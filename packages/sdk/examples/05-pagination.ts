/**
 * Example 05 — Cursor-based Pagination
 *
 * Demonstrates safe, exhaustive traversal of any paginated endpoint:
 *   1. Fetch all Taloses page-by-page using the cursor pattern.
 *   2. Fetch all leaderboard entries with a configurable page size.
 *   3. Fetch all playbooks filtered by category.
 *
 * Bounded resource consumption:
 *   • `MAX_PAGES` caps the traversal regardless of catalogue size.
 *   • `limit` controls server-side page size (max 200 per API spec).
 *   • No in-memory accumulation beyond `MAX_PAGES * limit` items.
 *
 * Expected output:
 *   ── Talos list ──────
 *   ✓ Taloses page 1  count=50  nextCursor=<string|null>
 *   ✓ Taloses page 2  count=23  nextCursor=null
 *   ✓ Total taloses  total=73
 *   ── Leaderboard ──────
 *   ✓ Leaderboard page 1  count=50  nextCursor=null
 *   ── Playbooks ──────
 *   ✓ Playbooks page 1  count=10  nextCursor=null
 *
 * Environment variables required:
 *   TALOS_API_KEY   — operator API key (no auth needed for public endpoints)
 *   TALOS_API_URL   — optional
 */

import { TalosClient, TalosAPIError } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const PAGE_SIZE = 50;
const MAX_PAGES = 20; // safety cap to prevent runaway loops in examples

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Generic paginator ─────────────────────────────────────────────────────────

type PageFetcher<T> = (cursor?: string, limit?: number) => Promise<{ data: T[]; nextCursor: string | null }>;

async function paginateAll<T>(
  label: string,
  fetcher: PageFetcher<T>,
  limit = PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let page = 1;

  while (page <= MAX_PAGES) {
    const resp = await fetcher(cursor, limit);
    console.log(`✓ ${label} page ${page}  count=${resp.data.length}  nextCursor=${resp.nextCursor ?? "null"}`);
    all.push(...resp.data);
    if (!resp.nextCursor) break;
    cursor = resp.nextCursor;
    page++;
  }

  if (page > MAX_PAGES) {
    console.warn(`  ⚠ Reached MAX_PAGES=${MAX_PAGES} — truncating traversal`);
  }

  return all;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Talos list ────────────────────────────────────────────────────────────
  console.log("── Talos list " + "─".repeat(50));
  const taloses = await paginateAll("Taloses", (cursor, limit) =>
    client.listTaloses({ cursor, limit }),
  );
  console.log(`✓ Total taloses  total=${taloses.length}\n`);

  // ── Leaderboard ───────────────────────────────────────────────────────────
  console.log("── Leaderboard " + "─".repeat(50));
  const leaders = await paginateAll("Leaderboard", (cursor, limit) =>
    client.getLeaderboard({ cursor, limit }),
  );
  console.log(`✓ Total leaders  total=${leaders.length}\n`);

  // ── Playbooks (filtered by category) ─────────────────────────────────────
  console.log("── Playbooks (category=Marketing) " + "─".repeat(30));
  const playbooks = await paginateAll("Playbooks", (cursor, limit) =>
    client.listPlaybooks({ category: "Marketing", cursor, limit }),
    10, // smaller page size to demonstrate variable limits
  );
  console.log(`✓ Total matching playbooks  total=${playbooks.length}\n`);

  // ── Demonstrate zero-result graceful exit ─────────────────────────────────
  console.log("── Zero-result traversal " + "─".repeat(40));
  const none = await paginateAll("UnknownCategory", (cursor, limit) =>
    client.listPlaybooks({ category: "NonExistentXYZ", cursor, limit }),
  );
  console.log(`✓ Zero result handled  total=${none.length}`);
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
