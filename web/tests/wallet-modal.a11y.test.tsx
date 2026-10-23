import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers, useStellarWallet } from "@/components/providers";

describe("Wallet Modal Accessibility", () => {
  // Helper component to control modal state
  function TestWrapper({ children }: { children: React.ReactNode }) {
    return (
      <Providers>
        {children}
      </Providers>
    );
  }

  // Helper to open the modal via context
  function WalletModalController() {
    const { showWalletModal, setShowWalletModal } = useStellarWallet();
    return (
      <>
        <button
          data-testid="open-modal"
          onClick={() => setShowWalletModal(true)}
        >
          Open Modal
        </button>
        {showWalletModal && (
          <button
            data-testid="close-modal"
            onClick={() => setShowWalletModal(false)}
          >
            Close Modal
          </button>
        )}
      </>
    );
  }

  beforeEach(() => {
    // Mock window.StellarWalletsKit to avoid initialization errors
    Object.defineProperty(window, "StellarWalletsKit", {
      value: {
        init: vi.fn(),
        getAddress: vi.fn(() => Promise.resolve({ address: null })),
        setWallet: vi.fn(),
        fetchAddress: vi.fn(() => Promise.resolve({ address: "test-address" })),
        disconnect: vi.fn(() => Promise.resolve()),
        signTransaction: vi.fn(() => Promise.resolve({ signedTxXdr: "test-xdr" })),
        signMessage: vi.fn(() => Promise.resolve({ signedMessage: "test-sig" })),
      },
      writable: true,
    });
  });

  it("should have proper ARIA attributes when open", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    // Open modal
    const openButton = screen.getByTestId("open-modal");
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    const modal = screen.getByTestId("wallet-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal).toHaveAttribute("aria-labelledby", "wallet-modal-title");

    const title = screen.getByText("Connect Wallet");
    expect(title).toHaveAttribute("id", "wallet-modal-title");
  });

  it("should move focus to first wallet option on open", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    const openButton = screen.getByTestId("open-modal");
    openButton.focus();

    // Open modal
    fireEvent.click(openButton);

    await waitFor(() => {
      const firstWalletOption = screen.getByTestId("wallet-option-freighter");
      expect(firstWalletOption).toHaveFocus();
    });
  });

  it("should close on Escape key", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    // Open modal
    const openButton = screen.getByTestId("open-modal");
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("wallet-modal")).not.toBeInTheDocument();
    });
  });

  it("should restore focus to trigger on close", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    const openButton = screen.getByTestId("open-modal");
    openButton.focus();

    // Open modal
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    // Close modal via Escape
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(openButton).toHaveFocus();
    });
  });

  it("should have aria-label on close button", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    // Open modal
    const openButton = screen.getByTestId("open-modal");
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    const closeButton = screen.getByTestId("wallet-modal-close-button");
    expect(closeButton).toHaveAttribute("aria-label", "Close wallet selection");
  });

  it("should have role=alert on error message", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    // Open modal
    const openButton = screen.getByTestId("open-modal");
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    // Trigger an error by clicking a wallet option (will fail since it's mocked)
    const walletOption = screen.getByTestId("wallet-option-freighter");
    fireEvent.click(walletOption);

    // Error should appear with role=alert
    await waitFor(() => {
      const error = screen.getByText(/Connection failed/);
      expect(error).toHaveAttribute("role", "alert");
    });
  });

  it("should preserve all data-testid hooks", async () => {
    render(
      <TestWrapper>
        <WalletModalController />
      </TestWrapper>
    );

    // Open modal
    const openButton = screen.getByTestId("open-modal");
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    });

    // Check all expected data-testid attributes exist
    expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-modal-close-button")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-freighter")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-albedo")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-hana")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-hot-wallet")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-klever")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-option-onekey")).toBeInTheDocument();
  });
});
