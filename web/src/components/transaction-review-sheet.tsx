"use client";

/**
 * TransactionReviewSheet — pre-signing review for agent-owner financial actions (#1470).
 *
 * Before an agent owner signs a USDC transfer, this sheet shows the exact
 * amount, destination, and network taken from the action payload. It is
 * invalidated (dismissed and marked stale) if any of those three values change
 * while the sheet is open, so the user can never approve one set of parameters
 * while a different set is what will actually be submitted.
 *
 * Design constraints:
 *   - Values come from the payload, not from cached component state.
 *   - Absent payload fields render as "unavailable", never fabricated.
 *   - Network mismatch (payload vs expected) blocks approval with a visible
 *     warning; the caller does not need to re-check.
 *   - Existing approval flow, lease ownership, and Stellar network binding are
 *     untouched; this component only gates the final submit.
 */

import { useEffect, useRef, useState } from "react";

export interface TransactionPayload {
  /** Exact USDC amount as a decimal string, e.g. "12.34". */
  amount: string | null;
  /** Destination Stellar account. */
  destination: string | null;
  /** Network the transfer will execute on: "mainnet" | "testnet". */
  network: "mainnet" | "testnet" | null;
}

export interface TransactionReviewSheetProps {
  open: boolean;
  /** Human label for the action, e.g. "Buy 50 PULSE" or "Approve transfer". */
  title: string;
  /** The live payload. Changes to amount/destination/network invalidate the sheet. */
  payload: TransactionPayload;
  /** Network the app expects the payload to target. */
  expectedNetwork: "mainnet" | "testnet";
  /** Called when the user confirms the reviewed transaction. */
  onConfirm: () => void | Promise<void>;
  /** Called when the sheet is dismissed (either by the user or by invalidation). */
  onDismiss: () => void;
  /** Optional: test hook for a deterministic "invalidated" notification. */
  onInvalidate?: (reason: "amount" | "destination" | "network") => void;
}

const NETWORK_LABEL: Record<"mainnet" | "testnet", string> = {
  mainnet: "Mainnet",
  testnet: "Testnet",
};

const shortAddress = (value: string) =>
  value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;

export function TransactionReviewSheet({
  open,
  title,
  payload,
  expectedNetwork,
  onConfirm,
  onDismiss,
  onInvalidate,
}: TransactionReviewSheetProps) {
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  const snapshotRef = useRef<TransactionPayload | null>(null);

  const networkMismatch =
    payload.network !== null && payload.network !== expectedNetwork;
  const hasAllFields =
    payload.amount !== null &&
    payload.destination !== null &&
    payload.network !== null;
  const canConfirm = hasAllFields && !networkMismatch && !submitting;

  // Snapshot the payload when the sheet opens; any divergence while open
  // invalidates it (the user must re-open against the fresh payload).
  useEffect(() => {
    if (!open) {
      snapshotRef.current = null;
      return;
    }
    if (snapshotRef.current === null) {
      snapshotRef.current = { ...payload };
      return;
    }
    const snap = snapshotRef.current;
    if (snap.amount !== payload.amount) {
      onInvalidate?.("amount");
      onDismiss();
      return;
    }
    if (snap.destination !== payload.destination) {
      onInvalidate?.("destination");
      onDismiss();
      return;
    }
    if (snap.network !== payload.network) {
      onInvalidate?.("network");
      onDismiss();
    }
  }, [open, payload, onInvalidate, onDismiss]);

  // Focus the primary control on open; return focus on close.
  useEffect(() => {
    if (!open) return;
    firstFocusRef.current?.focus();
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!submitting) onDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tx-review-title"
        aria-describedby="tx-review-body"
        data-testid="transaction-review-sheet"
        className="bg-background border border-border w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="tx-review-title"
          className="text-sm font-bold text-foreground mb-4"
        >
          Review transaction
        </h2>
        <p id="tx-review-body" className="text-xs text-muted mb-4">
          {title}
        </p>

        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Amount</dt>
            <dd
              className="text-foreground font-mono"
              data-testid="tx-review-amount"
            >
              {payload.amount !== null ? `${payload.amount} USDC` : "unavailable"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Destination</dt>
            <dd
              className="text-foreground font-mono"
              data-testid="tx-review-destination"
            >
              {payload.destination !== null
                ? shortAddress(payload.destination)
                : "unavailable"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Network</dt>
            <dd
              className="text-foreground"
              data-testid="tx-review-network"
            >
              {payload.network !== null
                ? NETWORK_LABEL[payload.network]
                : "unavailable"}
            </dd>
          </div>
        </dl>

        {networkMismatch && (
          <p
            role="alert"
            data-testid="tx-review-network-mismatch"
            className="mt-3 text-xs text-red-500"
          >
            Payload targets {NETWORK_LABEL[payload.network as "mainnet" | "testnet"]} but this
            app expects {NETWORK_LABEL[expectedNetwork]}. Approval is blocked.
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={submitting}
            className="px-4 py-2 text-xs text-muted border border-border"
          >
            Cancel
          </button>
          <button
            ref={firstFocusRef}
            type="button"
            data-testid="tx-review-confirm"
            disabled={!canConfirm}
            onClick={async () => {
              if (!canConfirm) return;
              setSubmitting(true);
              try {
                await onConfirm();
              } finally {
                setSubmitting(false);
              }
            }}
            className="px-4 py-2 text-xs bg-accent text-background disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
