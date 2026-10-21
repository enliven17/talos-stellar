import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { LeaderboardClient } from "@/app/leaderboard/leaderboard-client";

// Setup JSDOM environment globals for React client testing
let dom: JSDOM;
let container: HTMLElement;

beforeEach(() => {
  dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost:3000",
  });
  global.window = dom.window as unknown as Window & typeof globalThis;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLTableElement = dom.window.HTMLTableElement;
  global.Node = dom.window.Node;

  container = dom.window.document.getElementById("root")!;

  global.fetch = vi.fn().mockResolvedValue({
    json: async () => ({
      data: [
        {
          id: "talos-1",
          name: "Vega",
          category: "marketing",
          status: "Active",
          pulsePrice: "1.0",
          totalSupply: 1000,
          patronCount: 5,
          activityCount: 10,
          totalRevenue: 5000,
          marketCap: 250000,
        },
      ],
      nextCursor: null,
    }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mockProps = {
  topPatrons: [
    {
      rank: 1,
      wallet: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGWEBUSBPGDDIS2U6DW",
      totalPulse: 10000,
      talosCount: 4,
      roles: ["Creator"],
    },
  ],
  topAgents: [
    {
      rank: 1,
      id: "agent-1",
      name: "Atlas",
      category: "research",
      activityCount: 42,
      posts: 20,
      replies: 15,
      commerce: 7,
      revenue: 1250.5,
      online: true,
    },
  ],
  trending: [
    {
      rank: 1,
      id: "trending-1",
      name: "Helios",
      category: "operations",
      recentRevenue: 850.0,
      recentPatrons: 12,
      recentActivity: 35,
      pulsePrice: 2.5,
    },
  ],
};

/**
 * RTL-standard getByRole query implementation for tables based on accessible name computation.
 */
function getByRole(
  root: ParentNode,
  role: string,
  options?: { name?: string | RegExp },
): HTMLElement {
  if (role === "table") {
    const tables = Array.from(root.querySelectorAll("table"));
    const matched = tables.filter((table) => {
      if (!options?.name) return true;
      const caption = table.querySelector("caption")?.textContent?.trim() || "";
      const ariaLabel = table.getAttribute("aria-label") || "";
      const accessibleName = ariaLabel || caption;
      if (typeof options.name === "string") {
        return accessibleName.toLowerCase() === options.name.toLowerCase();
      }
      return options.name.test(accessibleName);
    });

    if (matched.length === 0) {
      throw new Error(
        `Unable to find an accessible element with the role "${role}" and name "${options?.name}"`,
      );
    }
    return matched[0] as unknown as HTMLElement;
  }

  if (role === "button") {
    const buttons = Array.from(root.querySelectorAll("button"));
    const matched = buttons.filter((button) => {
      if (!options?.name) return true;
      const text = button.textContent?.trim() || "";
      if (typeof options.name === "string") {
        return text.toLowerCase() === options.name.toLowerCase();
      }
      return options.name.test(text);
    });
    if (matched.length === 0) {
      throw new Error(
        `Unable to find an accessible element with the role "${role}" and name "${options?.name}"`,
      );
    }
    return matched[0] as unknown as HTMLElement;
  }

  throw new Error(`Role "${role}" not supported in RTL helper`);
}

describe("LeaderboardClient table accessibility", () => {
  it("renders both Top TALOS and Top Patrons tables with captions and scoped headers", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<LeaderboardClient {...mockProps} />);
    });

    // 1. First Table: Top TALOS
    const topTalosTable = getByRole(container, "table", { name: /top talos/i });
    expect(topTalosTable).toBeTruthy();

    // Verify visually-hidden caption
    const topTalosCaption = topTalosTable.querySelector("caption");
    expect(topTalosCaption).not.toBeNull();
    expect(topTalosCaption?.classList.contains("sr-only")).toBe(true);
    expect(topTalosCaption?.textContent).toBe("Top TALOS");

    // Verify scope="col" on all header cells
    const topTalosHeaders = Array.from(topTalosTable.querySelectorAll("thead th"));
    expect(topTalosHeaders.length).toBe(6);
    topTalosHeaders.forEach((th) => {
      expect(th.getAttribute("scope")).toBe("col");
    });
    expect(topTalosHeaders.map((th) => th.textContent?.trim())).toEqual([
      "#",
      "Name",
      "Category",
      "Revenue",
      "Mitos MCap",
      "Patrons",
    ]);

    // 2. Switch Tab to Top Patrons
    const patronsTab = getByRole(container, "button", { name: "Top Patrons" });
    await act(async () => {
      patronsTab.click();
    });

    // Second Table: Top Patrons
    const topPatronsTable = getByRole(container, "table", { name: /top patrons/i });
    expect(topPatronsTable).toBeTruthy();

    // Verify visually-hidden caption
    const topPatronsCaption = topPatronsTable.querySelector("caption");
    expect(topPatronsCaption).not.toBeNull();
    expect(topPatronsCaption?.classList.contains("sr-only")).toBe(true);
    expect(topPatronsCaption?.textContent).toBe("Top Patrons");

    // Verify scope="col" on all header cells
    const topPatronsHeaders = Array.from(topPatronsTable.querySelectorAll("thead th"));
    expect(topPatronsHeaders.length).toBe(5);
    topPatronsHeaders.forEach((th) => {
      expect(th.getAttribute("scope")).toBe("col");
    });
    expect(topPatronsHeaders.map((th) => th.textContent?.trim())).toEqual([
      "#",
      "Wallet",
      "Roles",
      "Total Mitos",
      "TALOS Agents",
    ]);

    // Verify scope="row" on body rank cell
    const patronRankCell = topPatronsTable.querySelector("tbody tr td");
    expect(patronRankCell?.getAttribute("scope")).toBe("row");
    expect(patronRankCell?.textContent?.trim()).toBe("1");
  });

  it("renders Top Agents and Trending tables with captions and scoped headers", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<LeaderboardClient {...mockProps} />);
    });

    // Switch to Top Agents
    const agentsTab = getByRole(container, "button", { name: "Top Agents" });
    await act(async () => {
      agentsTab.click();
    });

    const topAgentsTable = getByRole(container, "table", { name: /top agents/i });
    expect(topAgentsTable).toBeTruthy();
    expect(topAgentsTable.querySelector("caption")?.classList.contains("sr-only")).toBe(true);
    Array.from(topAgentsTable.querySelectorAll("thead th")).forEach((th) => {
      expect(th.getAttribute("scope")).toBe("col");
    });
    expect(topAgentsTable.querySelector("tbody tr td")?.getAttribute("scope")).toBe("row");

    // Switch to Trending
    const trendingTab = getByRole(container, "button", { name: "Trending" });
    await act(async () => {
      trendingTab.click();
    });

    const trendingTable = getByRole(container, "table", { name: /trending/i });
    expect(trendingTable).toBeTruthy();
    expect(trendingTable.querySelector("caption")?.classList.contains("sr-only")).toBe(true);
    Array.from(trendingTable.querySelectorAll("thead th")).forEach((th) => {
      expect(th.getAttribute("scope")).toBe("col");
    });
    expect(trendingTable.querySelector("tbody tr td")?.getAttribute("scope")).toBe("row");
  });
});
