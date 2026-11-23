import { unstable_cache } from "next/cache";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { AGENTS_LIST_TAG } from "@/lib/cache-tags";
import {
  MAX_SITEMAP_AGENT_URLS,
  SITEMAP_PAGE_SIZE,
  type SitemapAgent,
} from "@/lib/sitemap";

/** Only an agent with this status has a public page worth indexing. */
const LISTED_STATUS = "Active";

/** How long the cached list is reused before it is read again. */
export const SITEMAP_AGENTS_REVALIDATE_SECONDS = 3_600;

/**
 * Loads the agents the sitemap lists: active and not deleted, most recently
 * updated first, at most `limit` of them.
 *
 * The agents come in pages of `pageSize` using a keyset cursor on
 * `(updatedAt, id)`, so a large table is never loaded in one query and a page
 * does not slow down as the offset grows. `id` breaks ties between agents
 * updated in the same millisecond, so no agent is skipped or repeated.
 */
export async function fetchActiveAgentsForSitemap(
  limit: number = MAX_SITEMAP_AGENT_URLS,
  pageSize: number = SITEMAP_PAGE_SIZE,
): Promise<SitemapAgent[]> {
  const agents: SitemapAgent[] = [];
  let cursor: { updatedAt: Date; id: string } | null = null;

  while (agents.length < limit) {
    const take = Math.min(pageSize, limit - agents.length);
    const conditions = [
      eq(tlsTalos.status, LISTED_STATUS),
      isNull(tlsTalos.deletedAt),
    ];
    if (cursor) {
      const after = or(
        lt(tlsTalos.updatedAt, cursor.updatedAt),
        and(
          eq(tlsTalos.updatedAt, cursor.updatedAt),
          lt(tlsTalos.id, cursor.id),
        ),
      );
      if (after) conditions.push(after);
    }

    const rows: { id: string; updatedAt: Date }[] = await db
      .select({ id: tlsTalos.id, updatedAt: tlsTalos.updatedAt })
      .from(tlsTalos)
      .where(and(...conditions))
      .orderBy(desc(tlsTalos.updatedAt), desc(tlsTalos.id))
      .limit(take);

    for (const row of rows) {
      agents.push({ id: row.id, updatedAt: row.updatedAt.toISOString() });
    }

    if (rows.length < take) break;
    const last = rows[rows.length - 1];
    cursor = { updatedAt: last.updatedAt, id: last.id };
  }

  return agents;
}

/**
 * The same list, cached under the agents tag. Routes that create, change or
 * delete an agent already invalidate `AGENTS_LIST_TAG`, so the sitemap follows
 * them straight away instead of waiting for the hour to pass, and a deleted
 * agent drops out as soon as its delete route runs.
 */
export const getCachedActiveAgents = unstable_cache(
  () => fetchActiveAgentsForSitemap(),
  ["sitemap-agents"],
  { tags: [AGENTS_LIST_TAG], revalidate: SITEMAP_AGENTS_REVALIDATE_SECONDS },
);
