"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  FreighterModule,
  xBullModule,
  ALBEDO_ID,
  AlbedoModule,
} from "@creit-tech/stellar-wallets-kit";

interface WalletContextValue {
  kit: StellarWalletsKit | null;
  publicKey: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue>({
  kit: null,
  publicKey: null,
  isConnected: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
});

export function useStellarWallet(): WalletContextValue {
  return useContext(WalletContext);
}

function createKit(): StellarWalletsKit {
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
      ? WalletNetwork.PUBLIC
      : WalletNetwork.TESTNET;

  return new StellarWalletsKit({
    network,
    selectedWalletId: FREIGHTER_ID,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
    ],
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [kit] = useState<StellarWalletsKit>(() => createKit());
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const connect = useCallback(async () => {
    try {
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id);
          const { address } = await kit.getAddress();
          setPublicKey(address);
        },
      });
    } catch (err) {
      console.error("[wallet] Connection failed:", err);
    }
  }, [kit]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      const network =
        process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
          ? WalletNetwork.PUBLIC
          : WalletNetwork.TESTNET;
      const { signedTxXdr } = await kit.signTransaction(xdr, { network });
      return signedTxXdr;
    },
    [kit],
  );

  return (
    <WalletContext.Provider
      value={{
        kit,
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
