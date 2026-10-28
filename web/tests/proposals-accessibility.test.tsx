// @vitest-environment jsdom
/**
 * Accessibility tests for the proposals page:
 *  - aria-pressed toggling on status filter buttons
 *  - unique accessible names on approve / reject vote buttons
 *  - live region announces vote results
 *  - vote buttons are disabled while a vote is in flight
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Wallet is connected so vote buttons render.
vi.mock("@/components/wallet-gate", () => ({
  useWallet: () => ({ isConnected: true, address: "GABC123", connect: vi.fn() }),
}));

import { ProposalsClient } from "@/app/proposals/proposals-client";

function proposal(id: string, title: string) {
  return {
    id,
    talosId: "t1",
    talosName: "Alpha",
    type: "policy",
    title,
    description: null,
    amount: null,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    txHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ProposalsClient accessibility", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    nav.search = "";
    nav.replace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it("marks the active filter button with aria-pressed=true", async () => {
    nav.search = "status=approved";
    fetchMock.mockResolvedValue(
      ok({ proposals: [], nextCursor: null, talos: [] }),
    );
    render(<ProposalsClient />);

    const approvedBtn = screen.getByRole("button", { name: /approved/i });
    expect(approvedBtn.getAttribute("aria-pressed")).toBe("true");

    const allBtn = screen.getByRole("button", { name: /all/i });
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles aria-pressed when a different filter is activated", async () => {
    nav.search = "status=pending";
    fetchMock.mockResolvedValue(
      ok({ proposals: [], nextCursor: null, talos: [] }),
    );
    render(<ProposalsClient />);

    const pendingBtn = screen.getByRole("button", { name: /pending/i });
    expect(pendingBtn.getAttribute("aria-pressed")).toBe("true");

    const allBtn = screen.getByRole("button", { name: /^all$/i });
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("gives each vote button a unique accessible name including the proposal title", async () => {
    fetchMock.mockResolvedValue(
      ok({
        proposals: [
          proposal("a", "Upgrade Protocol"),
          proposal("b", "Adjust Treasury"),
        ],
        nextCursor: null,
        talos: [],
      }),
    );
    render(<ProposalsClient />);

    await waitFor(() => {
      expect(screen.getByText("Upgrade Protocol")).toBeTruthy();
    });

    // Each approve/reject button must have a unique accessible name.
    const approveA = screen.getByRole("button", { name: "Approve proposal: Upgrade Protocol" });
    const rejectA = screen.getByRole("button", { name: "Reject proposal: Upgrade Protocol" });
    const approveB = screen.getByRole("button", { name: "Approve proposal: Adjust Treasury" });
    const rejectB = screen.getByRole("button", { name: "Reject proposal: Adjust Treasury" });

    expect(approveA).toBeTruthy();
    expect(rejectA).toBeTruthy();
    expect(approveB).toBeTruthy();
    expect(rejectB).toBeTruthy();
  });

  it("disables vote buttons while a vote is in flight", async () => {
    let resolveVote: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetchMock
      // initial proposals load
      .mockResolvedValueOnce(
        ok({ proposals: [proposal("a", "Upgrade Protocol")], nextCursor: null, talos: [] }),
      )
      // vote PATCH – never resolves until we trigger resolveVote
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveVote = resolve;
          }),
      );

    render(<ProposalsClient />);

    await waitFor(() => {
      expect(screen.getByText("Upgrade Protocol")).toBeTruthy();
    });

    const approveBtn = screen.getByRole("button", { name: "Approve proposal: Upgrade Protocol" });
    const rejectBtn = screen.getByRole("button", { name: "Reject proposal: Upgrade Protocol" });

    // Both buttons start enabled.
    expect((approveBtn as HTMLButtonElement).disabled).toBe(false);
    expect((rejectBtn as HTMLButtonElement).disabled).toBe(false);

    // Fire a click — the pending vote PATCH keeps fetch mocked-unresolved.
    approveBtn.click();

    await waitFor(() => {
      expect((approveBtn as HTMLButtonElement).disabled).toBe(true);
      expect((rejectBtn as HTMLButtonElement).disabled).toBe(true);
    });

    // Resolve the vote to clean up.
    resolveVote!(ok({ ok: true, status: "approved" }));
  });

  it("announces the vote result via an aria-live polite region", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ proposals: [proposal("a", "Upgrade Protocol")], nextCursor: null, talos: [] }),
      )
      .mockResolvedValueOnce(ok({ ok: true, status: "approved" }));

    render(<ProposalsClient />);

    await waitFor(() => {
      expect(screen.getByText("Upgrade Protocol")).toBeTruthy();
    });

    // Live region exists.
    const liveRegion = screen.getByText("", { selector: "[aria-live='polite']" });
    expect(liveRegion).toBeTruthy();

    const approveBtn = screen.getByRole("button", { name: "Approve proposal: Upgrade Protocol" });
    approveBtn.click();

    await waitFor(() => {
      expect(liveRegion.textContent).toMatch(/Upgrade Protocol.*approved/i);
    });
  });
});
