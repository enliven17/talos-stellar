"use client";

import { useCallback, useState } from "react";
import { signOwnerProof } from "@/lib/owner-proof-signer";

interface FinancialStatementButtonProps {
  talosId: string;
  ownerKeys?: Array<string | null | undefined>;
  address?: string | null;
  className?: string;
}

type StatementFormat = "json" | "csv";

export function FinancialStatementButton({
  talosId,
  ownerKeys = [],
  address,
  className = "",
}: FinancialStatementButtonProps) {
  const [loading, setLoading] = useState<StatementFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOwner = Boolean(address && ownerKeys.some((key) => key && key === address));

  const download = useCallback(
    async (format: StatementFormat) => {
      setLoading(format);
      setError(null);
      try {
        const { message, signature } = await signOwnerProof(
          talosId,
          "financial-statement",
          "GET",
        );
        const response = await fetch(
          `/api/talos/${encodeURIComponent(talosId)}/financial-statement?format=${format}`,
          {
            cache: "no-store",
            headers: {
              "x-talos-owner-address": address ?? "",
              "x-talos-owner-message": message,
              "x-talos-owner-signature": signature,
            },
          },
        );
        if (!response.ok) throw new Error(`Statement request failed: ${response.status}`);

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `talos-${talosId}-financial-statement.${format}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      } catch {
        setError("Could not download statement");
      } finally {
        setLoading(null);
      }
    },
    [address, talosId],
  );

  if (!isOwner) return null;

  return (
    <div className={`inline-flex flex-col gap-1 ${className}`}>
      <div className="inline-flex gap-2">
        <button
          type="button"
          data-testid="financial-statement-button-json"
          onClick={() => void download("json")}
          disabled={loading != null}
          className="text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
        >
          {loading === "json" ? "Preparing…" : "Download statement (JSON)"}
        </button>
        <button
          type="button"
          data-testid="financial-statement-button-csv"
          onClick={() => void download("csv")}
          disabled={loading != null}
          className="text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
        >
          {loading === "csv" ? "Preparing…" : "CSV"}
        </button>
      </div>
      {error ? (
        <span data-testid="financial-statement-error" className="text-xs text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
