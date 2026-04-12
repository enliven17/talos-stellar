"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
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
  showWalletModal: false,
  setShowWalletModal: () => {},
  selectWallet: async () => {},
});

export function useStellarWallet(): WalletContextValue {
  return useContext(WalletContext);
}

export function Providers({ children }: { children: ReactNode }) {
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

  return (
    <WalletContext.Provider
      value={{
        kit: StellarWalletsKit,
        publicKey,
        isConnected: !!publicKey,
        connect,
        disconnect,
        signTransaction,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs text-muted tracking-widest mb-0.5">[WALLET SELECT]</div>
            <div className="text-sm font-semibold text-foreground">Connect Wallet</div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Wallet list */}
        <div className="p-3 space-y-1">
          {WALLET_OPTIONS.map((w) => (
            <button
              key={w.id}
              onClick={() => handleSelect(w.id)}
              disabled={!!connecting}
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
          <div className="mx-3 mb-3 px-4 py-2 bg-red-950/30 border border-red-900/40 text-red-400 text-xs">
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
