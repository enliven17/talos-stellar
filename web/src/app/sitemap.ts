import type { MetadataRoute } from "next";
import { logger } from "@/lib/logger";
import { buildSitemap, canonicalSiteUrl, type SitemapAgent } from "@/lib/sitemap";
import { getCachedActiveAgents } from "@/lib/sitemap-agents";

// Rendered per request so the canonical URL is read at run time and the build
// never needs a database. The agent list itself is cached (see
// `getCachedActiveAgents`), which is what keeps repeated crawls cheap.
export const dynamic = "force-dynamic";

/**
 * `/sitemap.xml`: the public pages plus one entry per active, non-deleted
 * agent, using the canonical base URL.
 *
 * If the agents cannot be loaded the fixed pages are still served, so a
 * database outage costs the agent entries and not the whole sitemap.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = canonicalSiteUrl();
  if (!base) {
    logger.warn(
      { event: "sitemap_no_canonical_url" },
      "APP_URL is not set, so the sitemap is empty rather than listing localhost URLs",
    );
    return [];
  }

  let agents: SitemapAgent[] = [];
  try {
    agents = await getCachedActiveAgents();
  } catch (error) {
    logger.error(
      {
        event: "sitemap_agents_unavailable",
        message: error instanceof Error ? error.message : "unknown error",
      },
      "Could not load agents for the sitemap; serving the fixed pages only",
    );
  }

  return buildSitemap(base, agents);
}
