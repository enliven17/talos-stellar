// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { ProposalDetail } from "../src/components/proposals/proposal-detail";
import type { VotesSection } from "../src/components/proposals/vote-list";
import {
  buildTimeline,
  viewFromChain,
  viewFromDatabase,
  type ProposalView,
} from "../src/lib/proposal-detail";
import { databaseRows, proposals, quorums, votes, TX_A, TX_B } from "./fixtures/governance/proposals";

type ChainStatus = keyof typeof proposals;
const AGENT = { name: "Growth Agent", id: "talos-1" };

function render(view: ProposalView, votesSection: VotesSection, latestLedger: number | null = 5_000, notices: string[] = []) {
  const html = renderToStaticMarkup(
    React.createElement(ProposalDetail, {
      view,
      timeline: buildTimeline(view, latestLedger),
      votes: votesSection,
      notices,
    }),
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.innerHTML = "";
  document.body.appendChild(container);
  return container;
}

async function violations(container: HTMLElement) {
  // jsdom has no layout engine, so colour contrast cannot be computed here.
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const okVotes: VotesSection = { kind: "ok", votes, nextHref: null, firstHref: null, incomplete: false };

describe.each(["Active", "Approved", "Rejected", "Executed"] as ChainStatus[])(
  "on-chain proposal, %s",
  (status) => {
    const view = viewFromChain(proposals[status], quorums[status], AGENT);

    it("shows the title, status, agent link and a heading outline", () => {
      const page = render(view, okVotes);
      expect(page.querySelector("h1")?.textContent).toBe(proposals[status].title);
      expect(page.textContent).toContain(`Status: ${status}`);
      expect(page.querySelector('a[href="/agents/talos-1"]')?.textContent).toBe("Growth Agent");
      expect(Array.from(page.querySelectorAll("h2")).map((h) => h.textContent)).toEqual([
        "Status timeline",
        "Quorum and consensus",
        "Votes",
      ]);
    });

    it("shows two named progress bars whose values are the contract's", () => {
      const page = render(view, okVotes);
      const bars = Array.from(page.querySelectorAll('[role="progressbar"]'));
      expect(bars).toHaveLength(2);
      const [quorumBar, approvalBar] = bars;
      const q = quorums[status];

      expect(quorumBar.getAttribute("aria-valuenow")).toBe(String(q.quorumFractionBps / 100));
      expect(approvalBar.getAttribute("aria-valuenow")).toBe(String(q.approvalBps / 100));
      for (const bar of bars) {
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
        const labelId = bar.getAttribute("aria-labelledby") ?? "";
        expect(page.querySelector(`#${labelId}`)?.textContent).toBeTruthy();
        expect(bar.getAttribute("aria-valuetext")).toBeTruthy();
      }
      expect(page.textContent).toContain(q.quorumMet ? "Quorum reached" : "Quorum not reached");
    });

    it("lists the votes in a labelled table with links to the explorer", () => {
      const page = render(view, okVotes);
      const table = page.querySelector("table");
      expect(table?.querySelector("caption")?.textContent).toMatch(/votes/i);
      expect(Array.from(table?.querySelectorAll("th") ?? []).every((th) => th.getAttribute("scope") === "col")).toBe(true);
      expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
      const links = Array.from(table?.querySelectorAll("a") ?? []).map((a) => a.getAttribute("href"));
      expect(links).toEqual([
        `https://stellar.expert/explorer/testnet/tx/${TX_A}`,
        `https://stellar.expert/explorer/testnet/tx/${TX_B}`,
      ]);
    });

    it("has no axe violations", async () => {
      expect(await violations(render(view, okVotes))).toEqual([]);
    });
  },
);

describe("on-chain proposal states", () => {
  it("marks exactly the right timeline step as current while active", () => {
    const view = viewFromChain(proposals.Active, quorums.Active, AGENT);
    const page = render(view, okVotes, 5_000);
    const current = page.querySelectorAll('ol li[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Voting open");
    expect(current[0].textContent).toContain("In progress");
  });

  it("has no current step once the proposal is decided", () => {
    const view = viewFromChain(proposals.Executed, quorums.Executed, AGENT);
    expect(render(view, okVotes).querySelectorAll('[aria-current="step"]')).toHaveLength(0);
  });

  it("shows where the consensus threshold sits and whether it was reached", () => {
    const approved = render(viewFromChain(proposals.Approved, quorums.Approved, AGENT), okVotes);
    expect(approved.textContent).toContain("Consensus reached");
    expect(approved.textContent).toContain("60% needed to pass");

    const rejected = render(viewFromChain(proposals.Rejected, quorums.Rejected, AGENT), okVotes);
    expect(rejected.textContent).toContain("Below the approval needed");
  });

  it("shows the weights exactly as the contract reports them", () => {
    const page = render(viewFromChain(proposals.Approved, quorums.Approved, AGENT), okVotes);
    expect(page.textContent).toContain("1,700 of 1,000 voting weight cast");
    expect(page.textContent).toContain("Voters6");
  });

  it("falls back to a plain agent label when the agent is not in the database", () => {
    const view = viewFromChain(proposals.Active, quorums.Active, { name: "Agent #3", id: null });
    const page = render(view, okVotes);
    expect(page.querySelector('a[href^="/agents/"]')).toBeNull();
    expect(page.textContent).toContain("Agent #3");
  });

  it("says so when quorum or votes could not be read, instead of showing zeros", async () => {
    const view = viewFromChain(proposals.Active, null, AGENT);
    const page = render(view, { kind: "unavailable" }, null, [
      "Quorum details could not be read from the network right now.",
    ]);
    expect(page.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(page.textContent).toContain("Quorum details are not available right now.");
    expect(page.textContent).toContain("could not be read from the network");
    expect(page.querySelectorAll('[role="status"]').length).toBeGreaterThanOrEqual(2);
    expect(await violations(page)).toEqual([]);
  });

  it("shows an empty vote list and the retention note", async () => {
    const view = viewFromChain(proposals.Active, quorums.Active, AGENT);
    const empty = render(view, { kind: "ok", votes: [], nextHref: null, firstHref: null, incomplete: true });
    expect(empty.querySelector("table")).toBeNull();
    expect(empty.textContent).toContain("No votes to show yet");
    expect(empty.textContent).toContain("only keeps recent events");
  });

  it("links to the next and first pages of votes", async () => {
    const view = viewFromChain(proposals.Active, quorums.Active, AGENT);
    const page = render(view, {
      kind: "ok",
      votes,
      nextHref: "/proposals/7?cursor=abc-1",
      firstHref: "/proposals/7",
      incomplete: false,
    });
    const nav = page.querySelector('nav[aria-label="Vote pages"]');
    expect(Array.from(nav?.querySelectorAll("a") ?? []).map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["First page", "/proposals/7"],
      ["Next page", "/proposals/7?cursor=abc-1"],
    ]);
    expect(await violations(page)).toEqual([]);
  });
});

describe.each(["pending", "approved", "rejected"] as const)("database proposal, %s", (status) => {
  const view = viewFromDatabase(databaseRows[status]);

  it("renders the request, its status and agent without quorum bars or a vote table", () => {
    const page = render(view, { kind: "not-applicable" });
    expect(page.querySelector("h1")?.textContent).toBe(databaseRows[status].title);
    expect(page.textContent).toContain(`Status: ${view.stateLabel}`);
    expect(page.textContent).toContain("Agent approval request");
    expect(page.querySelector('a[href="/agents/talos-1"]')).not.toBeNull();
    expect(page.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(page.querySelector("table")).toBeNull();
    expect(page.textContent).toContain("single patron decision");
  });

  it("shows the amount and the timeline for the stored decision", () => {
    const page = render(view, { kind: "not-applicable" });
    expect(page.textContent).toContain(`$${Number(databaseRows[status].amount).toFixed(2)} USDC`);
    const steps = Array.from(page.querySelectorAll("ol li")).map((li) => li.textContent ?? "");
    expect(steps[0]).toContain("Submitted");
    if (status === "pending") {
      expect(page.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
      expect(steps[1]).toContain("Waiting for a patron");
    } else {
      expect(page.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
      expect(steps[1]).toContain(view.stateLabel);
    }
  });

  it("links the recorded transaction when there is one", () => {
    const page = render(view, { kind: "not-applicable" });
    const link = page.querySelector('ol a[href*="stellar.expert"]');
    if (databaseRows[status].txHash) {
      expect(link?.getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${TX_A}`);
    } else {
      expect(link).toBeNull();
    }
  });

  it("has no axe violations", async () => {
    expect(await violations(render(view, { kind: "not-applicable" }))).toEqual([]);
  });
});

describe("untrusted text", () => {
  it("renders a hostile title and description as text, not markup", () => {
    const view = viewFromDatabase({
      ...databaseRows.pending,
      title: '<img src=x onerror="alert(1)">',
      description: "<script>alert(1)</script>",
    });
    const page = render(view, { kind: "not-applicable" });
    expect(page.querySelector("img")).toBeNull();
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector("h1")?.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("does not link a transaction hash that is not a hash", () => {
    const view = viewFromDatabase({ ...databaseRows.approved, txHash: "javascript:alert(1)" });
    const page = render(view, { kind: "not-applicable" });
    expect(page.querySelector('a[href^="javascript"]')).toBeNull();
    expect(page.querySelector('ol a[target="_blank"]')).toBeNull();
  });
});
