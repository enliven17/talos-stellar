/**
 * Example 05 — Cursor-based Pagination
 *
 * Demonstrates safe, exhaustive traversal of any paginated endpoint:
 *   1. Fetch all Taloses page-by-page using the cursor pattern.
 *   2. Fetch all leaderboard entries with a configurable page size.
 *   3. Fetch all playbooks filtered by category.
 *   4. NEW: Use async pagination iterator for memory-efficient streaming.
 *
 * Bounded resource consumption:
 *   • `MAX_PAGES` caps the traversal regardless of catalogue size.
 *   • `limit` controls server-side page size (max 200 per API spec).
 *   • No in-memory accumulation beyond `MAX_PAGES * limit` items.
 *   • Async iterator yields items one-by-one, reducing memory footprint.
 *
 * Expected output:
 *   ── Talos list (manual) ──────
 *   ✓ Taloses page 1  count=50  nextCursor=<string|null>
 *   ✓ Taloses page 2  count=23  nextCursor=null
 *   ✓ Total taloses  total=73
 *   ── Leaderboard (manual) ──────
 *   ✓ Leaderboard page 1  count=50  nextCursor=null
 *   ── Playbooks (manual) ──────
 *   ✓ Playbooks page 1  count=10  nextCursor=null
 *   ── Talos list (async iterator) ──────
 *   ✓ Talos: <name>
 *   ✓ Total taloses via iterator: <count>
 *   ── Leaderboard (async iterator) ──────
 *   ✓ Leader: <name> - Revenue: <amount>
 *   ✓ Total leaders via iterator: <count>
 *   ── Playbooks (async iterator) ──────
 *   ✓ Playbook: <title> - Category: <category>
 *   ✓ Total playbooks via iterator: <count>
 *
 * Environment variables required:
 *   TALOS_API_KEY   — operator API key (no auth needed for public endpoints)
 *   TALOS_API_URL   — optional
 */

import {
  TalosClient,
  TalosAPIError,
  PaginationAbortedError,
  PaginationLimitExceededError,
} from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const PAGE_SIZE = 50;
const MAX_PAGES = 20; // safety cap to prevent runaway loops in examples

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Generic paginator (manual approach) ───────────────────────────────────────

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

// ── Async iterator approach (memory-efficient streaming) ─────────────────────

async function countWithIterator<T>(
  label: string,
  iterator: AsyncIterable<T>,
  itemLogger: (item: T) => void,
): Promise<number> {
  let count = 0;
  try {
    for await (const item of iterator) {
      itemLogger(item);
      count++;
    }
  } catch (err) {
    if (err instanceof PaginationAbortedError) {
      console.warn(`  ⚠ ${label} iteration was aborted`);
    } else if (err instanceof PaginationLimitExceededError) {
      console.warn(`  ⚠ ${label} exceeded page limit: ${err.message}`);
    } else {
      throw err;
    }
  }
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Talos list (manual) ─────────────────────────────────────────────────────
  console.log("── Talos list (manual) " + "─".repeat(40));
  const taloses = await paginateAll("Taloses", (cursor, limit) =>
    client.listTaloses({ cursor, limit }),
  );
  console.log(`✓ Total taloses  total=${taloses.length}\n`);

  // ── Leaderboard (manual) ────────────────────────────────────────────────────
  console.log("── Leaderboard (manual) " + "─".repeat(40));
  const leaders = await paginateAll("Leaderboard", (cursor, limit) =>
    client.getLeaderboard({ cursor, limit }),
  );
  console.log(`✓ Total leaders  total=${leaders.length}\n`);

  // ── Playbooks (manual, filtered by category) ───────────────────────────────
  console.log("── Playbooks (manual, category=Marketing) " + "─".repeat(30));
  const playbooks = await paginateAll("Playbooks", (cursor, limit) =>
    client.listPlaybooks({ category: "Marketing", cursor, limit }),
    10, // smaller page size to demonstrate variable limits
  );
  console.log(`✓ Total matching playbooks  total=${playbooks.length}\n`);

  // ── Demonstrate zero-result graceful exit (manual) ─────────────────────────
  console.log("── Zero-result traversal (manual) " + "─".repeat(35));
  const none = await paginateAll("UnknownCategory", (cursor, limit) =>
    client.listPlaybooks({ category: "NonExistentXYZ", cursor, limit }),
  );
  console.log(`✓ Zero result handled  total=${none.length}\n`);

  // ── Talos list (async iterator) ────────────────────────────────────────────
  console.log("── Talos list (async iterator) " + "─".repeat(35));
  const talosCount = await countWithIterator(
    "Taloses",
    client.paginateTaloses({ limit: PAGE_SIZE, maxPages: MAX_PAGES }),
    (talos) => console.log(`  ✓ Talos: ${talos.name}`),
  );
  console.log(`✓ Total taloses via iterator: ${talosCount}\n`);

  // ── Leaderboard (async iterator) ───────────────────────────────────────────
  console.log("── Leaderboard (async iterator) " + "─".repeat(35));
  const leaderCount = await countWithIterator(
    "Leaderboard",
    client.paginateLeaderboard({ limit: PAGE_SIZE, maxPages: MAX_PAGES }),
    (leader) => console.log(`  ✓ Leader: ${leader.name} - Revenue: ${leader.totalRevenue}`),
  );
  console.log(`✓ Total leaders via iterator: ${leaderCount}\n`);

  // ── Playbooks (async iterator, filtered) ───────────────────────────────────
  console.log("── Playbooks (async iterator, category=Marketing) " + "─".repeat(25));
  const playbookCount = await countWithIterator(
    "Playbooks",
    client.paginatePlaybooks({ category: "Marketing", limit: 10, maxPages: MAX_PAGES }),
    (playbook) => console.log(`  ✓ Playbook: ${playbook.title} - Category: ${playbook.category}`),
  );
  console.log(`✓ Total playbooks via iterator: ${playbookCount}\n`);

  // ── Demonstrate cancellation with AbortSignal ───────────────────────────────
  console.log("── Cancellation demo (abort after 3 items) " + "─".repeat(30));
  const abortController = new AbortController();
  let cancelCount = 0;
  try {
    for await (const talos of client.paginateTaloses({
      limit: PAGE_SIZE,
      signal: abortController.signal,
    })) {
      console.log(`  ✓ Talos ${cancelCount + 1}: ${talos.name}`);
      cancelCount++;
      if (cancelCount >= 3) {
        abortController.abort();
      }
    }
  } catch (err) {
    if (err instanceof PaginationAbortedError) {
      console.log(`  ✓ Successfully cancelled after ${cancelCount} items`);
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
