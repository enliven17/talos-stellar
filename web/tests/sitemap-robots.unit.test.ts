/**
 * Unit tests for GET /robots.txt and GET /sitemap.xml (issue #995).
 *
 * The database is faked at `@/db`: the fake records the real drizzle query, and
 * the tests render it to SQL with drizzle's own dialect, so what is asserted is
 * the query the app would send (deleted and non-active agents excluded, newest
 * first, paged by a keyset cursor, bounded) without needing a database. The
 * output is also run through Next's own renderers, so the text and XML checked
 * here are what a crawler receives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  resolveRobots,
  resolveSitemap,
} from "next/dist/build/webpack/loaders/metadata/resolve-route-data";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  updatedAt: Date;
}

interface RecordedQuery {
  where: SQL;
  orderBy: SQL[];
  limit: number;
}

const mocks = vi.hoisted(() => ({
  /** Pages the fake database returns, one per query, in order. */
  pages: [] as (unknown[] | Error)[],
  queries: [] as unknown[],
  /** What `unstable_cache` was asked to wrap. */
  cacheCalls: [] as { keys: string[]; options: Record<string, unknown> }[],
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/db", () => {
  const select = () => {
    const query: Record<string, unknown> = {};
    const chain = {
      from: () => chain,
      where: (condition: unknown) => {
        query.where = condition;
        return chain;
      },
      orderBy: (...order: unknown[]) => {
        query.orderBy = order;
        return chain;
      },
      limit: (n: number) => {
        query.limit = n;
        mocks.queries.push(query);
        const next = mocks.pages.shift();
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next ?? []);
      },
    };
    return chain;
  };
  return { db: { select } };
});

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: unknown,
    keys: string[],
    options: Record<string, unknown>,
  ) => {
    mocks.cacheCalls.push({ keys, options });
    return fn;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: vi.fn() },
}));

import robots, { dynamic as robotsDynamic } from "@/app/robots";
import sitemap, { dynamic as sitemapDynamic } from "@/app/sitemap";
import {
  MAX_SITEMAP_AGENT_URLS,
  ROBOTS_DISALLOW,
  SITEMAP_PAGE_SIZE,
  STATIC_PAGES,
  buildRobots,
  buildSitemap,
  canonicalSiteUrl,
} from "@/lib/sitemap";
import {
  SITEMAP_AGENTS_REVALIDATE_SECONDS,
  fetchActiveAgentsForSitemap,
  getCachedActiveAgents,
} from "@/lib/sitemap-agents";
import { AGENTS_LIST_TAG } from "@/lib/cache-tags";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dialect = new PgDialect();
const render = (sql: SQL) => dialect.sqlToQuery(sql);

function recorded(index: number): RecordedQuery {
  return mocks.queries[index] as RecordedQuery;
}

function row(n: number): Row {
  return { id: `agent-${n}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, n)) };
}

function rows(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => row(from + i));
}

beforeEach(() => {
  mocks.pages.length = 0;
  mocks.queries.length = 0;
  mocks.warn.mockClear();
  mocks.error.mockClear();
  vi.stubEnv("APP_URL", "https://talos.example");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// canonicalSiteUrl
// ---------------------------------------------------------------------------

describe("canonicalSiteUrl", () => {
  it("uses APP_URL", () => {
    expect(canonicalSiteUrl()).toBe("https://talos.example");
  });

  it("drops trailing slashes", () => {
    vi.stubEnv("APP_URL", "https://talos.example///");
    expect(canonicalSiteUrl()).toBe("https://talos.example");
  });

  it("falls back to NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://public.example/");
    expect(canonicalSiteUrl()).toBe("https://public.example");
  });

  it("prefers APP_URL over NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://public.example");
    expect(canonicalSiteUrl()).toBe("https://talos.example");
  });

  it("has no canonical URL in production when none is configured", () => {
    vi.stubEnv("APP_URL", "");
    expect(canonicalSiteUrl()).toBeNull();
  });

  it("falls back to localhost outside production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(canonicalSiteUrl()).toBe("http://localhost:3000");
  });

  it("rejects a value that is not an http(s) URL", () => {
    vi.stubEnv("APP_URL", "not a url");
    expect(canonicalSiteUrl()).toBeNull();
    vi.stubEnv("APP_URL", "ftp://talos.example");
    expect(canonicalSiteUrl()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

describe("robots", () => {
  it("allows the site and disallows /api/ and /admin/", () => {
    const result = robots();
    expect(result.rules).toEqual([
      { userAgent: "*", allow: "/", disallow: ["/api/", "/admin/"] },
    ]);
    expect([...ROBOTS_DISALLOW]).toEqual(["/api/", "/admin/"]);
  });

  it("points at the sitemap on the canonical URL", () => {
    expect(robots().sitemap).toBe("https://talos.example/sitemap.xml");
  });

  it("omits the sitemap line when there is no canonical URL", () => {
    vi.stubEnv("APP_URL", "");
    expect(robots()).not.toHaveProperty("sitemap");
    expect(buildRobots(null)).not.toHaveProperty("sitemap");
  });

  it("renders valid robots.txt", () => {
    const text = resolveRobots(robots());
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Disallow: /admin/");
    expect(text).toContain("Sitemap: https://talos.example/sitemap.xml");
    // Nothing public is blocked.
    expect(text).not.toMatch(/^Disallow: \/$/m);
    expect(text).not.toMatch(/^Disallow: \/agents/m);
  });

  it("is rendered per request so the environment is read at run time", () => {
    expect(robotsDynamic).toBe("force-dynamic");
    expect(sitemapDynamic).toBe("force-dynamic");
  });
});

// ---------------------------------------------------------------------------
// buildSitemap
// ---------------------------------------------------------------------------

describe("buildSitemap", () => {
  const base = "https://talos.example";

  it("lists the fixed public pages with absolute URLs", () => {
    const urls = buildSitemap(base, []).map((entry) => entry.url);
    expect(urls).toEqual([
      "https://talos.example/",
      "https://talos.example/agents",
      "https://talos.example/marketplace",
      "https://talos.example/leaderboard",
      "https://talos.example/docs",
      "https://talos.example/playbooks",
      "https://talos.example/proposals",
    ]);
    expect(STATIC_PAGES).toHaveLength(7);
  });

  it("never lists API or admin routes", () => {
    const entries = buildSitemap(base, [{ id: "a1", updatedAt: "2026-10-01T00:00:00.000Z" }]);
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/(api|admin)(\/|$)/);
    }
  });

  it("adds one page per agent with its last update", () => {
    const entries = buildSitemap(base, [
      { id: "a1", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "a2", updatedAt: "2026-10-02T00:00:00.000Z" },
    ]);
    const agentEntries = entries.filter((e) => e.url.includes("/agents/"));
    expect(agentEntries.map((e) => e.url)).toEqual([
      "https://talos.example/agents/a1",
      "https://talos.example/agents/a2",
    ]);
    expect(agentEntries[0].lastModified).toBe("2026-10-01T00:00:00.000Z");
    expect(entries).toHaveLength(STATIC_PAGES.length + 2);
  });

  it("percent-encodes ids that are not URL-safe", () => {
    const entries = buildSitemap(base, [
      { id: "a b/c?d&e", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(entries.at(-1)?.url).toBe(
      "https://talos.example/agents/a%20b%2Fc%3Fd%26e",
    );
  });

  it("lists an agent once and skips blank ids", () => {
    const entries = buildSitemap(base, [
      { id: "a1", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "a1", updatedAt: "2026-10-05T00:00:00.000Z" },
      { id: "  ", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(entries.filter((e) => e.url.includes("/agents/"))).toHaveLength(1);
    expect(entries.at(-1)?.lastModified).toBe("2026-10-01T00:00:00.000Z");
  });

  it("renders valid sitemap XML with one <loc> per entry", () => {
    const entries = buildSitemap(base, [
      { id: "a&b", updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    const xml = resolveSitemap(entries);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect((xml.match(/<loc>/g) ?? []).length).toBe(entries.length);
    expect(xml).toContain("<loc>https://talos.example/agents/a%26b</loc>");
    // An id with an ampersand must not leak a raw "&" into the XML.
    expect(xml.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, "")).not.toContain("&");
    expect(xml).toContain("<lastmod>2026-10-01T00:00:00.000Z</lastmod>");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchActiveAgentsForSitemap (the query)
// ---------------------------------------------------------------------------

describe("fetchActiveAgentsForSitemap", () => {
  it("only asks for active agents that are not deleted", async () => {
    mocks.pages.push([]);
    await fetchActiveAgentsForSitemap();
    const { sql, params } = render(recorded(0).where);
    expect(sql).toContain('"status" = $1');
    expect(sql).toContain('"deletedAt" is null');
    expect(params).toEqual(["Active"]);
  });

  it("returns newest first, with the id as a tie-break", async () => {
    mocks.pages.push([]);
    await fetchActiveAgentsForSitemap();
    const order = recorded(0).orderBy.map((o) => render(o).sql);
    expect(order).toEqual(['"tls_talos"."updatedAt" desc', '"tls_talos"."id" desc']);
  });

  it("maps each row to an id and an ISO timestamp", async () => {
    mocks.pages.push(rows(1, 2));
    const agents = await fetchActiveAgentsForSitemap();
    expect(agents).toEqual([
      { id: "agent-1", updatedAt: "2026-10-01T00:00:00.001Z" },
      { id: "agent-2", updatedAt: "2026-10-01T00:00:00.002Z" },
    ]);
  });

  it("returns an empty list, in one query, when there are no agents", async () => {
    expect(await fetchActiveAgentsForSitemap()).toEqual([]);
    expect(mocks.queries).toHaveLength(1);
  });

  it("stops after a page that is not full", async () => {
    mocks.pages.push(rows(1, 2));
    await fetchActiveAgentsForSitemap(100, 3);
    expect(mocks.queries).toHaveLength(1);
    expect(recorded(0).limit).toBe(3);
  });

  it("continues from the last row of a full page with a keyset cursor", async () => {
    const first = rows(1, 3);
    mocks.pages.push(first, rows(4, 2));

    const agents = await fetchActiveAgentsForSitemap(100, 3);

    expect(agents.map((a) => a.id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
    ]);
    expect(mocks.queries).toHaveLength(2);

    const second = render(recorded(1).where);
    // Active and not deleted still apply on every page.
    expect(second.sql).toContain('"status" = $1');
    expect(second.sql).toContain('"deletedAt" is null');
    // Rows after the cursor: older, or the same instant with a smaller id.
    expect(second.sql).toContain('"updatedAt" < $');
    expect(second.sql).toContain('"updatedAt" = $');
    expect(second.sql).toContain('"id" < $');
    expect(second.sql).toContain(" or ");
    const last = first[first.length - 1];
    expect(second.params).toContain(last.id);
    // The cursor timestamp is used twice (older than it, or equal to it). The
    // driver value for a timestamp column is its ISO string.
    const iso = last.updatedAt.toISOString();
    expect(
      second.params.filter(
        (p) =>
          p === iso ||
          (p instanceof Date && p.getTime() === last.updatedAt.getTime()),
      ),
    ).toHaveLength(2);
    // The first page has no cursor.
    expect(render(recorded(0).where).sql).not.toContain(" or ");
  });

  it("asks once more after an exact multiple of the page size", async () => {
    mocks.pages.push(rows(1, 3), []);
    const agents = await fetchActiveAgentsForSitemap(100, 3);
    expect(agents).toHaveLength(3);
    expect(mocks.queries).toHaveLength(2);
  });

  it("is bounded: it never returns more than the limit and shrinks the last page", async () => {
    mocks.pages.push(rows(1, 3), rows(4, 2), rows(6, 3));
    const agents = await fetchActiveAgentsForSitemap(5, 3);
    expect(agents).toHaveLength(5);
    expect(mocks.queries.map((_, i) => recorded(i).limit)).toEqual([3, 2]);
  });

  it("stops at the default cap for a very large table", async () => {
    const pages = MAX_SITEMAP_AGENT_URLS / SITEMAP_PAGE_SIZE;
    for (let page = 0; page < pages + 2; page++) {
      mocks.pages.push(rows(page * SITEMAP_PAGE_SIZE, SITEMAP_PAGE_SIZE));
    }
    const agents = await fetchActiveAgentsForSitemap();
    expect(agents).toHaveLength(MAX_SITEMAP_AGENT_URLS);
    expect(mocks.queries).toHaveLength(pages);
    expect(recorded(0).limit).toBe(SITEMAP_PAGE_SIZE);
    expect(MAX_SITEMAP_AGENT_URLS).toBeLessThan(50_000);
  });

  it("propagates a database failure", async () => {
    mocks.pages.push(new Error("db is down"));
    await expect(fetchActiveAgentsForSitemap()).rejects.toThrow("db is down");
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("getCachedActiveAgents", () => {
  it("is cached under the agents tag, so agent mutations refresh the sitemap", () => {
    expect(mocks.cacheCalls).toHaveLength(1);
    const [call] = mocks.cacheCalls;
    expect(call.keys).toEqual(["sitemap-agents"]);
    expect(call.options).toEqual({
      tags: [AGENTS_LIST_TAG],
      revalidate: SITEMAP_AGENTS_REVALIDATE_SECONDS,
    });
    expect(SITEMAP_AGENTS_REVALIDATE_SECONDS).toBe(3_600);
  });

  it("loads through the same query", async () => {
    mocks.pages.push(rows(1, 1));
    expect(await getCachedActiveAgents()).toEqual([
      { id: "agent-1", updatedAt: "2026-10-01T00:00:00.001Z" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// sitemap.xml route
// ---------------------------------------------------------------------------

describe("sitemap", () => {
  it("lists the fixed pages and every active agent", async () => {
    mocks.pages.push(rows(1, 2));
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual([
      ...STATIC_PAGES.map((p) =>
        p.path === "/" ? "https://talos.example/" : `https://talos.example${p.path}`,
      ),
      "https://talos.example/agents/agent-1",
      "https://talos.example/agents/agent-2",
    ]);
  });

  it("asks the database only for active, non-deleted agents", async () => {
    mocks.pages.push([]);
    await sitemap();
    const { sql, params } = render(recorded(0).where);
    expect(sql).toContain('"deletedAt" is null');
    expect(sql).toContain('"status" = $1');
    expect(params).toEqual(["Active"]);
  });

  it("renders valid XML for the whole sitemap", async () => {
    mocks.pages.push(rows(1, 3));
    const xml = resolveSitemap(await sitemap());
    expect((xml.match(/<url>/g) ?? []).length).toBe(STATIC_PAGES.length + 3);
    expect(xml).toContain("<loc>https://talos.example/agents/agent-3</loc>");
  });

  it("serves the fixed pages when the agents cannot be loaded", async () => {
    mocks.pages.push(new Error("db is down"));
    const entries = await sitemap();
    expect(entries).toHaveLength(STATIC_PAGES.length);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error.mock.calls[0][0]).toMatchObject({
      event: "sitemap_agents_unavailable",
      message: "db is down",
    });
  });

  it("is empty, and says why, when there is no canonical URL", async () => {
    vi.stubEnv("APP_URL", "");
    expect(await sitemap()).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    // No query is made for a sitemap that will not be served.
    expect(mocks.queries).toHaveLength(0);
  });
});
