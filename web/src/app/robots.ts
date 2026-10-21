import type { MetadataRoute } from "next";
import { buildRobots, canonicalSiteUrl } from "@/lib/sitemap";

// The canonical URL comes from the environment, which a container may only
// receive at start-up, so this is rendered per request instead of being baked
// in at build time.
export const dynamic = "force-dynamic";

/** `/robots.txt`: allow the public site, keep crawlers out of `/api/` and `/admin/`. */
export default function robots(): MetadataRoute.Robots {
  return buildRobots(canonicalSiteUrl());
}
