// @vitest-environment jsdom
/**
 * Component + helper tests for the proposals page URL state.
 * next/navigation and the wallet context are mocked; fetch is stubbed.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/components/wallet-gate", () => ({
  useWallet: () => ({ isConnected: false, address: null, connect: vi.fn() }),
}));

import { ProposalsClient } from "@/app/proposals/proposals-client";
import {
  buildProposalsApiUrl,
  buildProposalsPageUrl,
  parseProposalFilters,
} from "@/lib/proposals-filters";

function proposal(id: string) {
  return {
    id, talosId: "t1", talosName: "Alpha", type: "policy", title: `Title ${id}`,
    description: null, amount: null, status: "pending", decidedBy: null,
    decidedAt: null, txHash: null, createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("proposals filter helpers", () => {
  it("round-trips filters through the URL", () => {
    const filters = { status: "pending", talosId: "t1", type: "policy" } as const;
    const url = buildProposalsPageUrl(filters);
    expect(url).toBe("/proposals?status=pending&talosId=t1&type=policy");
    expect(parseProposalFilters(new URL(url, "http://x").searchParams)).toEqual(filters);
  });

  it("omits default values from the URL", () => {
    expect(buildProposalsPageUrl({ status: "all", talosId: "all", type: "all" })).toBe("/proposals");
  });

  it("falls back to 'all' for garbage values", () => {
    expect(parseProposalFilters(new URLSearchParams("status=zzz&type=nope"))).toEqual({
      status: "all", talosId: "all", type: "all",
    });
  });

  it("builds API urls with limit and cursor", () => {
    const url = buildProposalsApiUrl({ status: "all", talosId: "t1", type: "all" }, "abc", 20);
    expect(new URL(url, "http://x").searchParams.toString()).toBe("talosId=t1&limit=20&cursor=abc");
  });
});

describe("ProposalsClient URL state", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  beforeEach(() => {
    nav.search = "";
    nav.replace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it("hydrates the controls from the URL (survives reload)", () => {
    nav.search = "status=approved&talosId=t1&type=policy";
    fetchMock.mockResolvedValue(ok({ proposals: [], nextCursor: null, talos: [] }));
    const markup = renderToStaticMarkup(<ProposalsClient />);
    expect(markup).toMatch(/<option value="policy" selected/);
    expect(markup).toMatch(/<option value="t1" selected/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>approved</);
  });

  it("requests the first page using the URL filters", async () => {
    nav.search = "status=pending&talosId=t1&type=policy";
    fetchMock.mockResolvedValue(ok({ proposals: [], nextCursor: null, talos: [] }));
    await act(async () => root.render(<ProposalsClient />));
    const url = new URL(fetchMock.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/api/proposals");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("talosId")).toBe("t1");
    expect(url.searchParams.get("type")).toBe("policy");
  });

  it("writes a changed filter back to the URL", async () => {
    fetchMock.mockResolvedValue(
      ok({ proposals: [proposal("a")], nextCursor: null, talos: [{ id: "t1", name: "Alpha" }] }),
    );
    await act(async () => root.render(<ProposalsClient />));

    const typeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(typeSelect, "strategy");
      typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(nav.replace).toHaveBeenCalledWith("/proposals?type=strategy", { scroll: false });
  });

  it("'Load more' appends the next page using the cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ proposals: [proposal("a")], nextCursor: "CUR1", talos: [] }))
      .mockResolvedValueOnce(ok({ proposals: [proposal("b")], nextCursor: null }));
    await act(async () => root.render(<ProposalsClient />));
    expect(container.textContent).toContain("Title a");

    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load more")!;
    await act(async () => btn.click());

    expect(new URL(fetchMock.mock.calls[1][0], "http://x").searchParams.get("cursor")).toBe("CUR1");
    expect(container.textContent).toContain("Title a");
    expect(container.textContent).toContain("Title b");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(false);
  });
});
