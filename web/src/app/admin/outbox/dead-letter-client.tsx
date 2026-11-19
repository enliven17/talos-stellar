"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeadLetterSummary, DeadLetterView } from "@/lib/outbox/dead-letter";

// Shared with the audit log page so an operator enters the key once per tab.
const STORAGE_KEY = "talos_admin_api_key";
const PAGE_SIZE = "25";

type RetryState = { status: "pending" } | { status: "done" } | { status: "error"; message: string };

function formatTime(value: string): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

function errorFrom(body: unknown, status: number): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === "string" ? message : `Request failed (${status})`;
}

export function DeadLetterClient() {
  const [adminKey, setAdminKey] = useState("");
  const [eventType, setEventType] = useState("");
  const [rows, setRows] = useState<DeadLetterView[]>([]);
  const [summary, setSummary] = useState<DeadLetterSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [retries, setRetries] = useState<Record<string, RetryState>>({});

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) setAdminKey(stored);
    } catch {
      /* ignore */
    }
  }, []);

  const persistKey = (value: string) => {
    setAdminKey(value);
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean, typeFilter: string) => {
      if (!adminKey.trim()) {
        setError("Enter the ADMIN_API_KEY to load dead-lettered events.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: PAGE_SIZE });
        if (typeFilter.trim()) params.set("eventType", typeFilter.trim());
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`/api/admin/outbox/dead-letter?${params}`, {
          headers: { authorization: `Bearer ${adminKey.trim()}` },
          cache: "no-store",
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setError(errorFrom(body, res.status));
          return;
        }
        const page = (body?.deadLetters ?? []) as DeadLetterView[];
        setRows((prev) => (append ? [...prev, ...page] : page));
        setNextCursor(body?.nextCursor ?? null);
        setSummary(body?.summary ?? null);
        if (!append) setRetries({});
        setLoaded(true);
      } catch {
        setError("Failed to reach the outbox admin API.");
      } finally {
        setLoading(false);
      }
    },
    [adminKey],
  );

  const retry = async (id: string) => {
    setRetries((prev) => ({ ...prev, [id]: { status: "pending" } }));
    try {
      const res = await fetch(`/api/admin/outbox/${encodeURIComponent(id)}/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey.trim()}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRetries((prev) => ({ ...prev, [id]: { status: "error", message: errorFrom(body, res.status) } }));
        return;
      }
      setRetries((prev) => ({ ...prev, [id]: { status: "done" } }));
      setSummary((prev) => {
        if (!prev) return prev;
        const row = rows.find((r) => r.id === id);
        return {
          total: Math.max(prev.total - 1, 0),
          byEventType: prev.byEventType
            .map((g) => (row && g.eventType === row.eventType ? { ...g, count: g.count - 1 } : g))
            .filter((g) => g.count > 0),
        };
      });
    } catch {
      setRetries((prev) => ({ ...prev, [id]: { status: "error", message: "Failed to reach the outbox admin API." } }));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchPage(null, false, eventType);
  };

  const filterBy = (type: string) => {
    setEventType(type);
    void fetchPage(null, false, type);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Outbox Dead Letters</h1>
        <p className="text-sm text-muted mt-1">
          Outbox events whose delivery failed permanently (retries exhausted or no consumer registered).
          Payloads are not shown here; retrying requeues the event with its attempt counter reset.
          Requires the operator <code className="text-accent">ADMIN_API_KEY</code>.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 border border-border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Admin API key
            <input
              type="password"
              autoComplete="off"
              value={adminKey}
              onChange={(e) => persistKey(e.target.value)}
              placeholder="Bearer token value"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="dlq-admin-key"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Event type
            <input
              type="text"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="e.g. commerce_job.completed"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="dlq-filter-event-type"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:opacity-50"
            data-testid="dlq-load"
          >
            {loading ? "Loading…" : loaded ? "Refresh" : "Load dead letters"}
          </button>
          {eventType && (
            <button
              type="button"
              onClick={() => filterBy("")}
              className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover"
              data-testid="dlq-clear-filter"
            >
              Clear filter
            </button>
          )}
        </div>
      </form>

      {error && (
        <div
          className="border border-red-500/40 bg-red-500/5 text-sm text-red-700 px-4 py-3"
          data-testid="dlq-error"
          role="alert"
        >
          {error}
        </div>
      )}

      {loaded && summary && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="dlq-summary">
          <span className="text-muted">
            {summary.total} dead-lettered event{summary.total === 1 ? "" : "s"}
          </span>
          {summary.byEventType.map((g) => (
            <button
              key={g.eventType}
              type="button"
              onClick={() => filterBy(g.eventType)}
              className={`border px-2 py-1 font-mono ${
                g.eventType === eventType.trim()
                  ? "border-accent text-accent"
                  : "border-border text-nav-foreground hover:bg-surface-hover"
              }`}
            >
              {g.eventType} · {g.count}
            </button>
          ))}
        </div>
      )}

      {loaded && !error && (
        <div className="space-y-3">
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-surface border-b border-border text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Dead-lettered</th>
                  <th className="px-3 py-2 font-medium">Event type</th>
                  <th className="px-3 py-2 font-medium">Aggregate</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                  <th className="px-3 py-2 font-medium sr-only">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted">
                      No dead-lettered events{eventType.trim() ? " for this event type" : ""}.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const state = retries[row.id];
                    return (
                      <tr key={row.id} className="border-b border-border/60 hover:bg-surface/60" data-testid="dlq-row">
                        <td className="px-3 py-2 whitespace-nowrap text-muted" title={`created ${formatTime(row.createdAt)}`}>
                          {formatTime(row.deadLetteredAt)}
                        </td>
                        <td className="px-3 py-2 text-foreground">{row.eventType}</td>
                        <td className="px-3 py-2 text-muted max-w-[14rem] truncate" title={`${row.aggregateType}:${row.aggregateId}`}>
                          {row.aggregateType}:{row.aggregateId}
                        </td>
                        <td className="px-3 py-2 text-muted whitespace-nowrap">
                          {row.attempts}/{row.maxAttempts}
                        </td>
                        <td className="px-3 py-2 text-red-600 max-w-md truncate" title={row.lastError ?? undefined}>
                          {row.lastError ?? "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right">
                          {state?.status === "done" ? (
                            <span className="text-accent">Requeued</span>
                          ) : (
                            <button
                              type="button"
                              disabled={state?.status === "pending"}
                              onClick={() => void retry(row.id)}
                              className="px-3 py-1 border border-border text-nav-foreground hover:bg-surface-hover disabled:opacity-50"
                              data-testid="dlq-retry"
                            >
                              {state?.status === "pending" ? "Retrying…" : "Retry"}
                            </button>
                          )}
                          {state?.status === "error" && (
                            <div className="text-red-600 mt-1" role="alert">
                              {state.message}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {nextCursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void fetchPage(nextCursor, true, eventType)}
              className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover disabled:opacity-50"
              data-testid="dlq-load-more"
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
