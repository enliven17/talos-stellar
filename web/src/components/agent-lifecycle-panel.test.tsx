import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLifecyclePanel } from "./agent-lifecycle-panel";

const wallet = vi.hoisted(() => ({
  address: "GOWNER",
  network: "testnet" as "testnet" | "mainnet",
  refreshAddress: vi.fn<() => Promise<string | null>>(),
  signMessage: vi.fn<(message: string) => Promise<string>>(),
}));

vi.mock("@/components/wallet-gate", () => ({
  useWallet: () => ({
    ...wallet,
    isConnected: Boolean(wallet.address),
    connect: vi.fn(),
  }),
}));

vi.mock("@/components/agent-lifecycle-checklist", () => ({
  AgentLifecycleChecklist: () => null,
}));

const lifecycleSnapshot = (allowedActions: ("pause" | "retire")[]) => ({
  talosId: "talos-1",
  state: "active",
  observedAt: new Date().toISOString(),
  stateChangedAt: null,
  agentOnline: true,
  allowedActions,
  viewerRoles: allowedActions.length ? ["creator"] : [],
  inFlightJobs: 0,
  pendingProposals: [],
  run: null,
  events: [],
  nextCursor: null,
});

const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  json: async () => body,
});

describe("AgentLifecyclePanel wallet authorization", () => {
  beforeEach(() => {
    wallet.address = "GOWNER";
    wallet.network = "testnet";
    wallet.refreshAddress.mockReset().mockImplementation(async () => wallet.address);
    wallet.signMessage.mockReset().mockResolvedValue("signature");
  });

  it("clears owner action eligibility and confirmation when the account changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot(["retire"])))
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot([])));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AgentLifecyclePanel talosId="talos-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "retire" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    wallet.address = "GOTHER";
    rerender(<AgentLifecyclePanel talosId="talos-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/holds no governance role/i)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "retire" })).toBeNull();
  });

  it("clears owner action eligibility when the Stellar network changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot(["retire"])))
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot([])));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AgentLifecyclePanel talosId="talos-1" />);

    expect(await screen.findByRole("button", { name: "retire" })).toBeTruthy();

    wallet.network = "mainnet";
    rerender(<AgentLifecyclePanel talosId="talos-1" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/holds no governance role/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "retire" })).toBeNull();
  });

  it("refreshes authorization before signing and refuses a no-longer-allowed action", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot(["pause"])))
      .mockResolvedValueOnce(jsonResponse(lifecycleSnapshot([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentLifecyclePanel talosId="talos-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "pause" }));

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
    expect(wallet.refreshAddress).toHaveBeenCalledOnce();
    expect(wallet.signMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
