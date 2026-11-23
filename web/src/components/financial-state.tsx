"use client";

import React, { useEffect, useState } from "react";

export type FinancialDataState = "loading" | "stale" | "unavailable" | "live";

export const FINANCIAL_STALE_AFTER_MS = 30_000;

export function getRelativeTimeString(isoOrMs: string | number | Date): string {
  const timestamp =
    typeof isoOrMs === "number"
      ? isoOrMs
      : typeof isoOrMs === "string"
      ? new Date(isoOrMs).getTime()
      : isoOrMs.getTime();

  if (Number.isNaN(timestamp) || timestamp <= 0) return "unknown";

  const diff = Date.now() - timestamp;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function isTimestampStale(
  observedAt: string | number | Date | null | undefined,
  thresholdMs: number = FINANCIAL_STALE_AFTER_MS
): boolean {
  if (!observedAt) return true;
  const time =
    typeof observedAt === "number"
      ? observedAt
    : typeof observedAt === "string"
    ? new Date(observedAt).getTime()
    : observedAt.getTime();
  if (Number.isNaN(time) || time <= 0) return true;
  return Date.now() - time > thresholdMs;
}

export interface FinancialSnapshotBadgeProps {
  observedAt?: string | null;
  state?: FinancialDataState;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
}

/**
 * Snapshot observation timestamp and stale-data state badge for financial panels.
 */
export function FinancialSnapshotBadge({
  observedAt,
  state: explicitState,
  onRefresh,
  refreshing = false,
  className = "",
}: FinancialSnapshotBadgeProps) {
  const [, setTick] = useState(0);

  // Periodically refresh relative time counter
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  const isStale = isTimestampStale(observedAt);

  let state: FinancialDataState = explicitState ?? (isStale ? "stale" : "live");
  if (refreshing) state = "loading";

  return (
    <div
      data-testid="financial-snapshot-badge"
      className={`inline-flex items-center gap-2 text-xs font-mono ${className}`}
    >
      <span
        data-testid="financial-state-tag"
        className={`px-1.5 py-0.5 border text-[10px] uppercase font-bold tracking-wider ${
          state === "loading"
            ? "border-yellow-500/40 text-yellow-500 bg-yellow-500/10 animate-pulse"
            : state === "stale"
            ? "border-yellow-500/40 text-yellow-500 bg-yellow-500/10"
            : state === "unavailable"
            ? "border-red-500/40 text-red-400 bg-red-500/10"
            : "border-border text-muted bg-surface"
        }`}
      >
        {state}
      </span>

      {observedAt ? (
        <span
          data-testid="financial-observed-at"
          className="text-muted text-[11px]"
          title={new Date(observedAt).toLocaleString()}
        >
          as of {getRelativeTimeString(observedAt)}
        </span>
      ) : (
        <span data-testid="financial-observed-at" className="text-muted text-[11px]">
          no snapshot
        </span>
      )}

      {state === "stale" && onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="financial-stale-refresh-button"
          className="text-accent hover:underline text-[11px] font-sans disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      )}
    </div>
  );
}

export interface FinancialMetricValueProps {
  value: string | number | null | undefined;
  state?: FinancialDataState;
  prefix?: string;
  suffix?: string;
  className?: string;
  testId?: string;
}

/**
 * Renders a financial metric value safely according to data states.
 * CRITICAL RULE: Never displays invented zero balances (e.g. $0.00) when
 * state is loading or unavailable.
 */
export function FinancialMetricValue({
  value,
  state = "live",
  prefix = "",
  suffix = "",
  className = "",
  testId,
}: FinancialMetricValueProps) {
  if (state === "loading") {
    return (
      <span
        data-testid={testId}
        className={`inline-block animate-pulse text-muted ${className}`}
      >
        •••
      </span>
    );
  }

  if (state === "unavailable" || value === null || value === undefined) {
    return (
      <span
        data-testid={testId}
        className={`text-muted tracking-widest ${className}`}
        title="Data unavailable"
      >
        —
      </span>
    );
  }

  return (
    <span data-testid={testId} className={className}>
      {prefix}
      {value}
      {suffix}
    </span>
  );
}
