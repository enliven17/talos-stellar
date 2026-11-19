"use client";

import { useCallback, useEffect, useState } from "react";

interface AuditLogRow {
  id: string;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  denialReason: string | null;
  scopesRequired: string[] | null;
  ipAddress: string | null;
  createdAt: string;
}

const METHODS = ["", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const STATUS_CLASSES = ["", "2xx", "3xx", "4xx", "5xx"];
const STORAGE_KEY = "talos_admin_api_key";

export function AuditLogClient() {
  const [adminKey, setAdminKey] = useState("");
  const [talosId, setTalosId] = useState("");
  const [method, setMethod] = useState("");
  const [q, setQ] = useState("");
  const [statusCode, setStatusCode] = useState("");
  const [statusClass, setStatusClass] = useState("");
  const [denialReason, setDenialReason] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

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

  const buildParams = useCallback(
    (cursor?: string | null) => {
      const params = new URLSearchParams();
      if (talosId.trim()) params.set("talosId", talosId.trim());
      if (method) params.set("method", method);
      if (q.trim()) params.set("q", q.trim());
      if (statusCode.trim()) params.set("statusCode", statusCode.trim());
      if (statusClass) params.set("statusClass", statusClass);
      if (denialReason.trim()) params.set("denialReason", denialReason.trim());
      if (from.trim()) params.set("from", new Date(from).toISOString());
      if (to.trim()) params.set("to", new Date(to).toISOString());
      if (cursor) params.set("cursor", cursor);
      params.set("limit", "50");
      return params;
    },
    [talosId, method, q, statusCode, statusClass, denialReason, from, to],
  );

  const fetchLogs = useCallback(
    async (cursor?: string | null, append = false) => {
      if (!adminKey.trim()) {
        setError("Enter the ADMIN_API_KEY to query the audit log.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const params = buildParams(cursor);
        const res = await fetch(`/api/admin/audit-logs?${params}`, {
          headers: { authorization: `Bearer ${adminKey.trim()}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
          return;
        }
        const page = (body.logs ?? []) as AuditLogRow[];
        setLogs((prev) => (append ? [...prev, ...page] : page));
        setNextCursor(body.nextCursor ?? null);
        setSearched(true);
      } catch {
        setError("Failed to reach the audit log API.");
      } finally {
        setLoading(false);
      }
    },
    [adminKey, buildParams],
  );

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchLogs(null, false);
  };

  const onClear = () => {
    setTalosId("");
    setMethod("");
    setQ("");
    setStatusCode("");
    setStatusClass("");
    setDenialReason("");
    setFrom("");
    setTo("");
    setLogs([]);
    setNextCursor(null);
    setSearched(false);
    setError(null);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Admin Audit Log</h1>
        <p className="text-sm text-muted mt-1">
          Search API key audit entries by agent, method, path, status, denial reason, or time range.
          Requires the operator <code className="text-accent">ADMIN_API_KEY</code>.
        </p>
      </div>

      <form onSubmit={onSearch} className="space-y-4 border border-border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Admin API key
            <input
              type="password"
              autoComplete="off"
              value={adminKey}
              onChange={(e) => persistKey(e.target.value)}
              placeholder="Bearer token value"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="audit-admin-key"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Search path / denial reason
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. /sign or expired_key"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="audit-filter-q"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            TALOS id
            <input
              type="text"
              value={talosId}
              onChange={(e) => setTalosId(e.target.value)}
              placeholder="cuid"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="audit-filter-talos"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Method
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="audit-filter-method"
            >
              {METHODS.map((m) => (
                <option key={m || "any"} value={m}>
                  {m || "Any"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Status code
            <input
              type="text"
              inputMode="numeric"
              value={statusCode}
              onChange={(e) => {
                setStatusCode(e.target.value);
                if (e.target.value) setStatusClass("");
              }}
              placeholder="403"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="audit-filter-status-code"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Status class
            <select
              value={statusClass}
              onChange={(e) => {
                setStatusClass(e.target.value);
                if (e.target.value) setStatusCode("");
              }}
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="audit-filter-status-class"
            >
              {STATUS_CLASSES.map((c) => (
                <option key={c || "any"} value={c}>
                  {c || "Any"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Denial reason (exact)
            <input
              type="text"
              value={denialReason}
              onChange={(e) => setDenialReason(e.target.value)}
              placeholder="expired_key"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="audit-filter-denial"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="audit-filter-from"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="audit-filter-to"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:opacity-50"
            data-testid="audit-search"
          >
            {loading ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            onClick={onClear}
            className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover"
            data-testid="audit-clear"
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div
          className="border border-red-500/40 bg-red-500/5 text-sm text-red-700 px-4 py-3"
          data-testid="audit-error"
          role="alert"
        >
          {error}
        </div>
      )}

      {searched && !error && (
        <div className="space-y-3">
          <div className="text-xs text-muted">
            {logs.length} result{logs.length === 1 ? "" : "s"}
            {nextCursor ? " (more available)" : ""}
          </div>
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-surface border-b border-border text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">TALOS</th>
                  <th className="px-3 py-2 font-medium">Denial</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted">
                      No audit entries match these filters.
                    </td>
                  </tr>
                ) : (
                  logs.map((row) => (
                    <tr key={row.id} className="border-b border-border/60 hover:bg-surface/60">
                      <td className="px-3 py-2 whitespace-nowrap text-muted">
                        {new Date(row.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="px-3 py-2 text-foreground">{row.method}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            row.statusCode >= 500
                              ? "text-red-600"
                              : row.statusCode >= 400
                                ? "text-amber-600"
                                : "text-accent"
                          }
                        >
                          {row.statusCode}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-foreground max-w-xs truncate" title={row.path}>
                        {row.path}
                      </td>
                      <td className="px-3 py-2 text-muted max-w-[8rem] truncate" title={row.talosId}>
                        {row.talosId}
                      </td>
                      <td className="px-3 py-2 text-muted">{row.denialReason ?? "—"}</td>
                      <td className="px-3 py-2 text-muted">{row.ipAddress ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {nextCursor && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void fetchLogs(nextCursor, true)}
              className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover disabled:opacity-50"
              data-testid="audit-load-more"
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
