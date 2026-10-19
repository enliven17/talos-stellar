import type { MetadataRoute } from "next";
import { getPublicBaseUrl } from "@/lib/public-url";

/**
 * Pure helpers behind `app/robots.ts` and `app/sitemap.ts`.
 *
 * Nothing here touches the database or the request, so the output is easy to
 * test: the route files only fetch the agents and hand them to these builders.
 */

/** Path prefixes crawlers must not index: the HTTP API and the admin console. */
export const ROBOTS_DISALLOW = ["/api/", "/admin/"] as const;

/**
 * The most agent pages one sitemap lists. The sitemap protocol allows 50,000
 * URLs per file; stopping well below that keeps the response small. Past this
 * point the most recently updated agents are listed, and the file should be
 * split with Next's `generateSitemaps()`.
 */
export const MAX_SITEMAP_AGENT_URLS = 10_000;

/** How many agents one database round trip loads while building the list. */
export const SITEMAP_PAGE_SIZE = 1_000;

interface StaticPage {
  path: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  priority: number;
}

/** Public pages with a fixed address. Admin and API routes are not listed. */
export const STATIC_PAGES: readonly StaticPage[] = [
  { path: "/", changeFrequency: "daily", priority: 1 },
  { path: "/agents", changeFrequency: "hourly", priority: 0.9 },
  { path: "/marketplace", changeFrequency: "daily", priority: 0.8 },
  { path: "/leaderboard", changeFrequency: "daily", priority: 0.7 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.7 },
  { path: "/playbooks", changeFrequency: "weekly", priority: 0.6 },
  { path: "/proposals", changeFrequency: "daily", priority: 0.6 },
];

/** An agent as the sitemap needs it. `updatedAt` is an ISO 8601 timestamp. */
export interface SitemapAgent {
  id: string;
  updatedAt: string;
}

/**
 * The canonical origin for absolute URLs, or `null` when there is none to use.
 *
 * It comes from `APP_URL` (or `NEXT_PUBLIC_APP_URL`) through the same resolver
 * the rest of the app uses, so redirects and the sitemap agree. In production
 * with nothing configured it returns `null` instead of falling back to
 * localhost: a sitemap full of `http://localhost:3000` URLs would be worse for
 * a search engine than no sitemap.
 */
export function canonicalSiteUrl(): string | null {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured && process.env.NODE_ENV === "production") {
    return null;
  }

  const base = getPublicBaseUrl(new Headers());
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return base.replace(/\/+$/, "");
}

/** The `robots.txt` content: crawl everything public, skip the API and admin. */
export function buildRobots(base: string | null): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...ROBOTS_DISALLOW],
      },
    ],
    // Only advertise a sitemap when there is an address to put in front of it.
    ...(base ? { sitemap: `${base}/sitemap.xml` } : {}),
  };
}

/** The sitemap entries: the fixed public pages, then one per agent page. */
export function buildSitemap(
  base: string,
  agents: readonly SitemapAgent[],
): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = STATIC_PAGES.map((page) => ({
    url: page.path === "/" ? `${base}/` : `${base}${page.path}`,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  const seen = new Set<string>();
  for (const agent of agents) {
    const id = typeof agent.id === "string" ? agent.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      url: `${base}/agents/${encodeURIComponent(id)}`,
      lastModified: agent.updatedAt,
      changeFrequency: "weekly",
      priority: 0.5,
    });
  }

  return entries;
}
