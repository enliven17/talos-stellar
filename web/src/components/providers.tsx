"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";

function getNetwork(): Networks {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;
}

// Initialise once on module load (client-side only)
if (typeof window !== "undefined") {
  StellarWalletsKit.init({
    modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
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
}

const WalletContext = createContext<WalletContextValue>({
  kit: StellarWalletsKit,
  publicKey: null,
  isConnected: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
});

export function useStellarWallet(): WalletContextValue {
  return useContext(WalletContext);
}

export function Providers({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);

  // Restore session on mount
  useEffect(() => {
    StellarWalletsKit.getAddress()
      .then(({ address }) => { if (address) setPublicKey(address); })
      .catch(() => {});
  }, []);

  const connect = useCallback(async () => {
    try {
      const { address } = await StellarWalletsKit.authModal();
      setPublicKey(address);
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
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
