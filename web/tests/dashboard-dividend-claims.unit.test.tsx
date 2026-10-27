// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  useWallet: vi.fn(),
  getEpoch: vi.fn(),
  getNextEpochId: vi.fn(),
  getTalosPatron: vi.fn(),
  hasClaimed: vi.fn(),
  submitDividendClaim: vi.fn(),
}));

vi.mock("@/components/wallet-gate", () => ({
  useWallet: mocks.useWallet,
}));

vi.mock("@/lib/soroban", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/soroban")>();
  return {
    ...actual,
    TALOS_DIVIDENDS_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    getEpoch: mocks.getEpoch,
    getNextEpochId: mocks.getNextEpochId,
    getTalosPatron: mocks.getTalosPatron,
    hasClaimed: mocks.hasClaimed,
    submitDividendClaim: mocks.submitDividendClaim,
  };
});

import {
  DashboardDividendClaims,
  type DividendClaimTalos,
} from "../src/components/dashboard-dividend-claims";

const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const talos: DividendClaimTalos = {
  id: "talos-1",
  name: "Example Talos",
  onChainId: 12,
};

const patron = {
  creatorAddress: address,
  investorAddress: address,
  treasuryAddress: address,
  creatorShare: 60,
  investorShare: 25,
  treasuryShare: 15,
};

function setupDashboard(epochs: DividendClaimTalos[] = [talos]) {
  return render(<DashboardDividendClaims talos={epochs} />);
}

function setOneClaimableEpoch() {
  mocks.getNextEpochId.mockResolvedValue(BigInt(2));
  mocks.getEpoch.mockResolvedValue({
    epochId: BigInt(1),
    talosId: 12,
    totalAmount: BigInt(10_000_000),
    claimedAmount: BigInt(0),
    createdAt: BigInt(Math.floor(Date.now() / 1_000)),
    expirySecs: BigInt(86_400),
  });
  mocks.getTalosPatron.mockResolvedValue(patron);
  mocks.hasClaimed.mockResolvedValue(false);
}

describe("Dashboard dividend claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useWallet.mockReturnValue({
      address,
      signTransaction: vi.fn(async (xdr: string) => xdr),
    });
    mocks.getNextEpochId.mockResolvedValue(BigInt(1));
    mocks.getEpoch.mockResolvedValue(null);
    mocks.getTalosPatron.mockResolvedValue(patron);
    mocks.hasClaimed.mockResolvedValue(false);
  });

  afterEach(() => cleanup());

  it("shows a loading state while checking the chain", () => {
    mocks.getNextEpochId.mockReturnValue(new Promise(() => {}));
    setupDashboard();

    expect(screen.getByRole("status").textContent).toContain(
      "Checking for unclaimed dividend epochs",
    );
  });

  it("shows the empty state when no unclaimed epochs exist", async () => {
    setupDashboard();

    expect(
      await screen.findByText("No unclaimed dividend epochs are currently available."),
    ).toBeTruthy();
  });

  it("shows the missing on-chain patron state", async () => {
    setupDashboard([{ ...talos, onChainId: null }]);

    expect(
      await screen.findByText("No on-chain patron TALOS found for this wallet."),
    ).toBeTruthy();
  });

  it("lists epochs and submits claims through the wallet signer", async () => {
    setOneClaimableEpoch();
    mocks.submitDividendClaim.mockResolvedValue("abc123");
    setupDashboard();

    const claimButton = await screen.findByTestId("claim-dividend-talos-1-1");
    expect(screen.getByText(/Your allocation: 6000000 base units/)).toBeTruthy();
    expect(screen.getByText(/10000000 total/)).toBeTruthy();
    fireEvent.click(claimButton);

    await waitFor(() => {
      expect(mocks.submitDividendClaim).toHaveBeenCalledWith(
        {
          claimant: address,
          talosId: 12,
          epochId: BigInt(1),
          patronCreator: address,
          patronInvestor: address,
          patronTreasury: address,
          creatorShare: 60,
          investorShare: 25,
          treasuryShare: 15,
        },
        expect.any(Function),
      );
    });
    expect(
      await screen.findByText(/Claim recorded on-chain.*does not transfer tokens/),
    ).toBeTruthy();
  });

  it.each([
    ["Error(Contract, #5)", "You have already claimed this dividend epoch."],
    ["Error(Contract, #6)", "This dividend epoch has expired and can no longer be claimed."],
    ["Error(Contract, #10)", "Your connected wallet is not registered as a patron for this TALOS."],
  ])("shows a readable %s contract error", async (contractError, message) => {
    setOneClaimableEpoch();
    mocks.submitDividendClaim.mockRejectedValue(new Error(contractError));
    setupDashboard();

    fireEvent.click(await screen.findByTestId("claim-dividend-talos-1-1"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
  });

  it("shows a retry state when reading the contract fails", async () => {
    mocks.getNextEpochId.mockRejectedValue(new Error("Soroban RPC unavailable"));
    setupDashboard();

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Soroban RPC unavailable"),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
