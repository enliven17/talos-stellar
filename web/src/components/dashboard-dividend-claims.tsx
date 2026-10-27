"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/components/wallet-gate";
import {
  getDividendClaimErrorMessage,
  getEpoch,
  getNextEpochId,
  getTalosPatron,
  hasClaimed,
  submitDividendClaim,
  TALOS_DIVIDENDS_CONTRACT_ID,
  type DividendEpoch,
  type TalosPatronDetails,
} from "@/lib/soroban";

export interface DividendClaimTalos {
  id: string;
  name: string;
  onChainId: number | null;
}

interface ClaimableEpoch {
  talos: DividendClaimTalos;
  patron: TalosPatronDetails;
  patronShare: number;
  epoch: DividendEpoch;
}

interface ClaimableEpochsResult {
  epochs: ClaimableEpoch[];
  hasPatronTalos: boolean;
}

function getPatronShare(patron: TalosPatronDetails, address: string): number | null {
  if (patron.creatorAddress === address) return patron.creatorShare;
  if (patron.investorAddress === address) return patron.investorShare;
  if (patron.treasuryAddress === address) return patron.treasuryShare;
  return null;
}

async function findClaimableEpochs(
  talosList: DividendClaimTalos[],
  address: string,
): Promise<ClaimableEpochsResult> {
  const claimable: ClaimableEpoch[] = [];
  let hasPatronTalos = false;
  for (const talos of talosList) {
    if (talos.onChainId === null) continue;
    const patron = await getTalosPatron(talos.onChainId);
    if (!patron) continue;
    const patronShare = getPatronShare(patron, address);
    if (patronShare === null) continue;
    hasPatronTalos = true;
    const nextId = await getNextEpochId(talos.onChainId);
    for (
      let batchStart = BigInt(1);
      batchStart < nextId;
      batchStart += BigInt(10)
    ) {
      const ids = Array.from(
        { length: 10 },
        (_, index) => batchStart + BigInt(index),
      )
        .filter((epochId) => epochId < nextId);
      const epochs = await Promise.all(
        ids.map(async (epochId) => ({
          epochId,
          epoch: await getEpoch(talos.onChainId!, epochId),
        })),
      );
      const now = BigInt(Math.floor(Date.now() / 1_000));
      for (const { epochId, epoch } of epochs) {
        if (!epoch) continue;
        const deadline = epoch.createdAt + epoch.expirySecs;
        if (now > deadline || await hasClaimed(epochId, address)) continue;
        claimable.push({ talos, patron, patronShare, epoch });
      }
    }
  }
  return { epochs: claimable, hasPatronTalos };
}

export function DashboardDividendClaims({
  talos,
}: {
  talos: DividendClaimTalos[];
}) {
  const { address, signTransaction } = useWallet();
  const [epochs, setEpochs] = useState<ClaimableEpoch[]>([]);
  const [hasPatronTalos, setHasPatronTalos] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!TALOS_DIVIDENDS_CONTRACT_ID) {
      setLoading(false);
      return;
    }
    if (!address) {
      setEpochs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await findClaimableEpochs(talos, address);
      setEpochs(result.epochs);
      setHasPatronTalos(result.hasPatronTalos);
    } catch (readError) {
      setError(
        readError instanceof Error
          ? readError.message
          : "Could not load dividend epochs from Stellar.",
      );
    } finally {
      setLoading(false);
    }
  }, [address, talos]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleClaim(item: ClaimableEpoch) {
    if (!address || !item.talos.onChainId) return;
    const key = `${item.talos.id}-${item.epoch.epochId}`;
    setClaiming(key);
    setClaimError(null);
    setSuccess(null);
    try {
      const txHash = await submitDividendClaim(
        {
          claimant: address,
          talosId: item.talos.onChainId,
          epochId: item.epoch.epochId,
          patronCreator: item.patron.creatorAddress,
          patronInvestor: item.patron.investorAddress,
          patronTreasury: item.patron.treasuryAddress,
          creatorShare: item.patron.creatorShare,
          investorShare: item.patron.investorShare,
          treasuryShare: item.patron.treasuryShare,
        },
        signTransaction,
      );
      setSuccess(
        `Claim recorded on-chain. The contract records your allocation but does not transfer tokens. TX ${txHash}`,
      );
      await refresh();
    } catch (claimError) {
      setClaimError(getDividendClaimErrorMessage(claimError));
    } finally {
      setClaiming(null);
    }
  }

  return (
    <section className="mb-10" aria-labelledby="dividend-claims-heading">
      <h2
        id="dividend-claims-heading"
        className="text-sm text-muted mb-4 tracking-wide"
      >
        DIVIDEND CLAIMS
      </h2>
      {!TALOS_DIVIDENDS_CONTRACT_ID ? (
        <div className="bg-surface border border-border p-6 text-muted text-sm">
          Dividend claims are not configured for this network.
        </div>
      ) : loading ? (
        <div className="bg-surface border border-border p-6 text-muted text-sm" role="status">
          Checking for unclaimed dividend epochs...
        </div>
      ) : error ? (
        <div className="bg-surface border border-border p-6 text-sm" role="alert">
          <p className="text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-3 text-accent hover:underline"
          >
            Retry
          </button>
        </div>
      ) : epochs.length === 0 ? (
        <div className="bg-surface border border-border p-6 text-sm">
          {success && (
            <p className="mb-3 text-accent text-xs" role="status">
              {success}
            </p>
          )}
          <p className="text-muted">
            {hasPatronTalos
              ? "No unclaimed dividend epochs are currently available."
              : "No on-chain patron TALOS found for this wallet."}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border divide-y divide-border">
          {claimError && (
            <p className="p-4 text-red-400 text-xs" role="alert">
              {claimError}
            </p>
          )}
          {success && (
            <p className="p-4 text-accent text-xs" role="status">
              {success}
            </p>
          )}
          {epochs.map((item) => {
            const key = `${item.talos.id}-${item.epoch.epochId}`;
            return (
              <div
                key={key}
                className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                data-testid={`dividend-epoch-${item.talos.id}-${item.epoch.epochId}`}
              >
                <div>
                  <p className="text-sm text-foreground font-medium">
                    {item.talos.name} &middot; Epoch {item.epoch.epochId.toString()}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    Your allocation:{" "}
                    {((item.epoch.totalAmount * BigInt(item.patronShare)) / BigInt(100)).toString()}{" "}
                    base units
                    {" · "}
                    {item.epoch.totalAmount.toString()} total
                    {" · "}
                    {item.epoch.claimedAmount.toString()} claimed
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleClaim(item)}
                  disabled={claiming !== null}
                  className="border border-accent text-accent px-4 py-2 text-xs font-bold hover:bg-accent hover:text-background transition-colors disabled:opacity-50"
                  data-testid={`claim-dividend-${key}`}
                >
                  {claiming === key ? "SUBMITTING..." : "CLAIM"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
