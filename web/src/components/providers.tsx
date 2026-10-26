"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule, FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { AlbedoModule, ALBEDO_ID } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { HanaModule, HANA_ID } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { HotWalletModule, HOTWALLET_ID } from "@creit.tech/stellar-wallets-kit/modules/hotwallet";
import { KleverModule, KLEVER_ID } from "@creit.tech/stellar-wallets-kit/modules/klever";
import { OneKeyModule, ONEKEY_ID } from "@creit.tech/stellar-wallets-kit/modules/onekey";

export const WALLET_OPTIONS = [
  { id: FREIGHTER_ID, name: "Freighter", icon: "🟣", desc: "Browser extension" },
  { id: ALBEDO_ID,    name: "Albedo",    icon: "⚡", desc: "Web wallet" },
  { id: HANA_ID,      name: "Hana",      icon: "🌸", desc: "Browser extension" },
  { id: HOTWALLET_ID, name: "HOT Wallet",icon: "🔥", desc: "Mobile & web" },
  { id: KLEVER_ID,    name: "Klever",    icon: "🔷", desc: "Mobile wallet" },
  { id: ONEKEY_ID,    name: "OneKey",    icon: "🗝️", desc: "Hardware wallet" },
] as const;

function getNetwork(): Networks {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

if (typeof window !== "undefined") {
  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new AlbedoModule(),
      new HanaModule(),
      new HotWalletModule(),
      new KleverModule(),
      new OneKeyModule(),
    ],
    network: getNetwork(),
  });
}

interface WalletContextValue {
  kit: typeof StellarWalletsKit;
  publicKey: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  /** Sign an arbitrary UTF-8 message; returns a base64 ED25519 signature. */
  signMessage: (message: string) => Promise<string>;
  showWalletModal: boolean;
  setShowWalletModal: (v: boolean) => void;
  selectWallet: (id: string) => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>({
  kit: StellarWalletsKit,
  publicKey: null,
  isConnected: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  signMessage: async () => "",
  showWalletModal: false,
  setShowWalletModal: () => {},
  selectWallet: async () => {},
});

export function useStellarWallet(): WalletContextValue {
  return useContext(WalletContext);
}

import { I18nProvider, type SupportedLocale } from "@/lib/i18n";

export function Providers({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: SupportedLocale;
}) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [showWalletModal, setShowWalletModal] = useState(false);

  useEffect(() => {
    StellarWalletsKit.getAddress()
      .then(({ address }) => { if (address) setPublicKey(address); })
      .catch(() => {});
  }, []);

  const connect = useCallback(async () => {
    setShowWalletModal(true);
  }, []);

  const selectWallet = useCallback(async (id: string) => {
    try {
      StellarWalletsKit.setWallet(id);
      const { address } = await StellarWalletsKit.fetchAddress();
      setPublicKey(address);
      setShowWalletModal(false);
    } catch (err) {
      console.error("[wallet] Connection failed:", err);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch { /* ignore */ }
    setPublicKey(null);
  }, []);

  const signTransaction = useCallback(async (xdr: string): Promise<string> => {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase: getNetwork(),
    });
    return signedTxXdr;
  }, []);

  // Wallets return the signature either base64-encoded or as raw bytes
  // depending on the adapter; normalise to base64 so the server has one shape
  // to verify against.
  const signMessage = useCallback(async (message: string): Promise<string> => {
    // Map user rejection to a typed error code so SDK consumers can branch on it.
    let signedMessage: string | Uint8Array;
    try {
      ({ signedMessage } = await StellarWalletsKit.signMessage(message));
    } catch (err) {
      const e = new Error("User rejected the signing request") as Error & { code?: string };
      e.code = "USER_REJECTED";
      if (err instanceof Error && /reject|den(y|ied)|cancel/i.test(err.message)) throw e;
      throw err;
    }
    if (typeof signedMessage === "string") return signedMessage;

    // Browser-safe base64 — `Buffer` is not available in the client bundle.
    const bytes = signedMessage as unknown as Uint8Array;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, []);

  return (
    <I18nProvider initialLocale={initialLocale}>
      <WalletContext.Provider
        value={{
          kit: StellarWalletsKit,
          publicKey,
          isConnected: !!publicKey,
          connect,
          disconnect,
          signTransaction,
          signMessage,
          showWalletModal,
          setShowWalletModal,
          selectWallet,
        }}
      >
        {children}
        <WalletModal
          open={showWalletModal}
          onClose={() => setShowWalletModal(false)}
          onSelect={selectWallet}
        />
      </WalletContext.Provider>
    </I18nProvider>
  );
}

function WalletModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => Promise<void>;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  const firstWalletButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // Focus management: move focus to first wallet option on open
  useEffect(() => {
    if (open) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
      // Small delay to ensure the modal is rendered
      const timer = setTimeout(() => {
        firstWalletButtonRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      // Restore focus to the trigger on close
      const timer = setTimeout(() => {
        previousActiveElementRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Focus trap: keep focus within the modal
  useEffect(() => {
    if (!open || !modalRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key !== "Tab") return;

      const focusableElements = modalRef.current?.querySelectorAll<
        HTMLElement
      >(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );

      if (!focusableElements || focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: if focus is on first element, move to last
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: if focus is on last element, move to first
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSelect(id: string) {
    setConnecting(id);
    setError(null);
    try {
      await onSelect(id);
    } catch {
      setError("Connection failed. Is the wallet installed?");
      setConnecting(null);
    }
  }

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      data-testid="wallet-modal"
    >
      <div
        className="bg-background border border-border w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted tracking-widest mb-0.5">[WALLET SELECT]</div>
            <div
              id="wallet-modal-title"
              className="text-sm font-semibold text-foreground"
            >
              Connect Wallet
            </div>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            data-testid="wallet-modal-close-button"
            aria-label="Close wallet selection"
            className="text-muted hover:text-foreground transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Wallet list */}
        <div className="p-3 space-y-1">
          {WALLET_OPTIONS.map((w, index) => (
            <button
              key={w.id}
              ref={index === 0 ? firstWalletButtonRef : undefined}
              onClick={() => handleSelect(w.id)}
              disabled={!!connecting}
              data-testid={`wallet-option-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              className="w-full flex items-center gap-3 px-4 py-3 border border-transparent hover:border-accent/40 hover:bg-surface text-left transition-all disabled:opacity-50 group"
            >
              <span className="text-xl w-7 text-center">{w.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground group-hover:text-accent transition-colors">
                  {w.name}
                </div>
                <div className="text-xs text-muted">{w.desc}</div>
              </div>
              {connecting === w.id ? (
                <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
              ) : (
                <div className="text-muted text-xs opacity-0 group-hover:opacity-100 transition-opacity">→</div>
              )}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div
            role="alert"
            className="mx-3 mb-3 px-4 py-2 bg-red-950/30 border border-red-900/40 text-red-400 text-xs"
          >
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border">
          <p className="text-xs text-muted">
            All wallets support x402 auth-entry signing on Stellar.
          </p>
        </div>
      </div>
    </div>
  );
}
