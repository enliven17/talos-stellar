import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/components/providers", () => ({
  useStellarWallet: () => ({
    isConnected: false,
    publicKey: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
    showWalletModal: false,
    setShowWalletModal: vi.fn(),
    selectWallet: vi.fn(),
  }),
}));

import ProposalsPage from "@/app/proposals/page";
import { WalletGate } from "@/components/wallet-gate";

describe("i18n page and component snapshot tests", () => {
  describe("ProposalsPage locale swappability", () => {
    it("renders ProposalsPage identically in English (en)", () => {
      const htmlEn = renderToStaticMarkup(
        createElement(I18nProvider, { initialLocale: "en" }, createElement(ProposalsPage)),
      );

      // Verify canonical English strings are present
      expect(htmlEn).toContain("[DAO PROPOSALS]");
      expect(htmlEn).toContain("Governance Proposals");
      expect(htmlEn).toContain(
        "View active proposals from all Talos agents. Connect your wallet to vote as a Patron.",
      );
      expect(htmlEn).toContain("Connect your wallet to vote on pending proposals.");
      expect(htmlEn).toContain("Connect Wallet");
      expect(htmlEn).not.toContain("[TEST]");

      expect(htmlEn).toMatchSnapshot();
    });

    it("renders ProposalsPage with all strings swappable in test locale", () => {
      const htmlTest = renderToStaticMarkup(
        createElement(I18nProvider, { initialLocale: "test" }, createElement(ProposalsPage)),
      );

      // Verify swappable strings prefixed with [TEST]
      expect(htmlTest).toContain("[TEST] [DAO PROPOSALS]");
      expect(htmlTest).toContain("[TEST] Governance Proposals");
      expect(htmlTest).toContain(
        "[TEST] View active proposals from all Talos agents. Connect your wallet to vote as a Patron.",
      );
      expect(htmlTest).toContain("[TEST] Connect your wallet to vote on pending proposals.");
      expect(htmlTest).toContain("[TEST] Connect Wallet");

      expect(htmlTest).toMatchSnapshot();
    });

    it("proves en and test snapshots are distinct and demonstrate swappability", () => {
      const htmlEn = renderToStaticMarkup(
        createElement(I18nProvider, { initialLocale: "en" }, createElement(ProposalsPage)),
      );
      const htmlTest = renderToStaticMarkup(
        createElement(I18nProvider, { initialLocale: "test" }, createElement(ProposalsPage)),
      );

      expect(htmlEn).not.toEqual(htmlTest);
    });
  });

  describe("WalletGate component in two locales", () => {
    it("renders WalletGate in English (en)", () => {
      const htmlEn = renderToStaticMarkup(
        createElement(
          I18nProvider,
          { initialLocale: "en" },
          createElement(WalletGate, null, createElement("p", null, "Protected Area")),
        ),
      );

      expect(htmlEn).toContain("[WALLET REQUIRED]");
      expect(htmlEn).toContain("Connect Wallet to Continue");
      expect(htmlEn).toContain("This feature requires a connected Stellar wallet.");
      expect(htmlEn).toContain("Connect Stellar Wallet");
      expect(htmlEn).not.toContain("[TEST]");

      expect(htmlEn).toMatchSnapshot();
    });

    it("renders WalletGate in test locale", () => {
      const htmlTest = renderToStaticMarkup(
        createElement(
          I18nProvider,
          { initialLocale: "test" },
          createElement(WalletGate, null, createElement("p", null, "Protected Area")),
        ),
      );

      expect(htmlTest).toContain("[TEST] [WALLET REQUIRED]");
      expect(htmlTest).toContain("[TEST] Connect Wallet to Continue");
      expect(htmlTest).toContain("[TEST] This feature requires a connected Stellar wallet.");
      expect(htmlTest).toContain("[TEST] Connect Stellar Wallet");

      expect(htmlTest).toMatchSnapshot();
    });
  });
});
