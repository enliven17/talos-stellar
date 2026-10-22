"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { redactPayload } from "@/lib/redact";
import type { JobStatus, RetryClass } from "@/lib/jobs";

const STORAGE_KEY = "talos_admin_api_key";
const PAGE_SIZE = 25;

const VALID_STATUSES: { label: string; value: "" | JobStatus }[] = [
  { label: "All Statuses", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Leased", value: "leased" },
  { label: "Completed", value: "completed" },
  { label: "Dead Letter", value: "dead_letter" },
  { label: "Cancelled", value: "cancelled" },
];

export interface JobRecordView {
  id: string;
  queue: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  runAt: string;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attempts: number;
  maxAttempts: number;
  retryClass: RetryClass;
  cancelRequested: boolean;
  idempotencyKey: string | null;
  lastError: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ActionStatus =
  | { status: "pending"; type: "cancel" | "retry" }
  | { status: "done"; type: "cancel" | "retry" }
  | { status: "error"; type: "cancel" | "retry"; message: string };

function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(value);
  }
}

function errorFrom(body: unknown, status: number): string {
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === "string" ? message : `Request failed (${status})`;
}

function statusBadgeClass(status: JobStatus): string {
  switch (status) {
    case "pending":
      return "border-amber-500/40 bg-amber-500/10 text-amber-500";
    case "leased":
      return "border-blue-500/40 bg-blue-500/10 text-blue-400";
    case "completed":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400";
    case "dead_letter":
      return "border-red-500/40 bg-red-500/10 text-red-500";
    case "cancelled":
      return "border-border bg-surface-hover text-muted";
    default:
      return "border-border text-foreground";
  }
}

export interface JobsClientProps {
  initialAdminKey?: string;
}

export function JobsClient({ initialAdminKey = "" }: JobsClientProps) {
  const adminKeyInputId = useId();
  const statusFilterId = useId();
  const queueFilterId = useId();

  const [adminKey, setAdminKey] = useState(initialAdminKey);
  const [statusFilter, setStatusFilter] = useState<"" | JobStatus>("");
  const [queueFilter, setQueueFilter] = useState("");
  const [jobs, setJobs] = useState<JobRecordView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionStates, setActionStates] = useState<Record<string, ActionStatus>>({});

  // Drawer inspection state
  const [selectedJob, setSelectedJob] = useState<JobRecordView | null>(null);

  // Confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<{
    type: "cancel" | "retry";
    job: JobRecordView;
  } | null>(null);

  // Initialize admin API key from session storage
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) setAdminKey(stored);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  const persistKey = (value: string) => {
    setAdminKey(value);
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, value);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore storage errors */
    }
  };

  // Keyboard accessibility: handle Escape to close dialogs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmAction) {
          setConfirmAction(null);
        } else if (selectedJob) {
          setSelectedJob(null);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmAction, selectedJob]);

  const fetchJobs = useCallback(
    async (cursor: string | null, append: boolean, statusOverride?: "" | JobStatus, queueOverride?: string) => {
      if (!adminKey.trim()) {
        setError("Enter the ADMIN_API_KEY to load background jobs.");
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const currentStatus = statusOverride !== undefined ? statusOverride : statusFilter;
        const currentQueue = queueOverride !== undefined ? queueOverride : queueFilter;

        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (currentStatus) params.set("status", currentStatus);
        if (currentQueue.trim()) params.set("queue", currentQueue.trim());
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(`/api/admin/jobs?${params}`, {
          headers: { authorization: `Bearer ${adminKey.trim()}` },
          cache: "no-store",
        });

        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setError(errorFrom(body, res.status));
          return;
        }

        const page = (body?.jobs ?? []) as JobRecordView[];
        setJobs((prev) => (append ? [...prev, ...page] : page));
        setNextCursor(body?.nextCursor ?? null);
        setLoaded(true);

        // If inspecting a job that was refreshed, keep selectedJob updated
        if (selectedJob) {
          const fresh = page.find((j) => j.id === selectedJob.id);
          if (fresh) setSelectedJob(fresh);
        }
      } catch {
        setError("Failed to reach the background jobs admin API.");
      } finally {
        setLoading(false);
      }
    },
    [adminKey, statusFilter, queueFilter, selectedJob],
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void fetchJobs(null, false);
  };

  const onClearFilters = () => {
    setStatusFilter("");
    setQueueFilter("");
    void fetchJobs(null, false, "", "");
  };

  // Perform Cancel
  const executeCancel = async (job: JobRecordView) => {
    setActionStates((prev) => ({ ...prev, [job.id]: { type: "cancel", status: "pending" } }));
    setConfirmAction(null);

    try {
      const res = await fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey.trim()}` },
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setActionStates((prev) => ({
          ...prev,
          [job.id]: { type: "cancel", status: "error", message: errorFrom(body, res.status) },
        }));
        return;
      }

      const updatedJob = body as JobRecordView;
      setActionStates((prev) => ({ ...prev, [job.id]: { type: "cancel", status: "done" } }));
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, ...updatedJob } : j)));
      if (selectedJob?.id === job.id) {
        setSelectedJob((prev) => (prev ? { ...prev, ...updatedJob } : updatedJob));
      }
    } catch {
      setActionStates((prev) => ({
        ...prev,
        [job.id]: { type: "cancel", status: "error", message: "Failed to reach jobs admin API." },
      }));
    }
  };

  // Perform Retry
  const executeRetry = async (job: JobRecordView) => {
    setActionStates((prev) => ({ ...prev, [job.id]: { type: "retry", status: "pending" } }));
    setConfirmAction(null);

    try {
      const res = await fetch(`/api/admin/jobs/${encodeURIComponent(job.id)}/retry`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey.trim()}` },
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setActionStates((prev) => ({
          ...prev,
          [job.id]: { type: "retry", status: "error", message: errorFrom(body, res.status) },
        }));
        return;
      }

      const updatedJob = body as JobRecordView;
      setActionStates((prev) => ({ ...prev, [job.id]: { type: "retry", status: "done" } }));
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, ...updatedJob } : j)));
      if (selectedJob?.id === job.id) {
        setSelectedJob((prev) => (prev ? { ...prev, ...updatedJob } : updatedJob));
      }
    } catch {
      setActionStates((prev) => ({
        ...prev,
        [job.id]: { type: "retry", status: "error", message: "Failed to reach jobs admin API." },
      }));
    }
  };

  // Redacted payload for the drawer
  const redactedPayload = useMemo(() => {
    if (!selectedJob || selectedJob.payload === undefined) return "—";
    try {
      return JSON.stringify(redactPayload(selectedJob.payload), null, 2);
    } catch {
      return String(selectedJob.payload);
    }
  }, [selectedJob]);

  // Redacted result for the drawer (if completed)
  const redactedResult = useMemo(() => {
    if (!selectedJob || selectedJob.result === undefined || selectedJob.result === null) return null;
    try {
      return JSON.stringify(redactPayload(selectedJob.result), null, 2);
    } catch {
      return String(selectedJob.result);
    }
  }, [selectedJob]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Navigation and Title */}
      <div>
        <nav aria-label="Admin Navigation" className="flex items-center gap-2 mb-2 text-xs">
          <span className="text-accent font-semibold">Background Jobs</span>
          <span className="text-muted">/</span>
          <Link href="/admin/outbox" className="text-muted hover:text-foreground transition-colors">
            Outbox Dead Letters
          </Link>
          <span className="text-muted">/</span>
          <Link href="/admin/audit" className="text-muted hover:text-foreground transition-colors">
            Audit Log
          </Link>
        </nav>
        <h1 className="text-2xl font-bold text-foreground">Background Jobs</h1>
        <p className="text-sm text-muted mt-1">
          Inspect, filter, cancel, and retry durable Postgres-backed background jobs.
          Requires the operator <code className="text-accent">ADMIN_API_KEY</code>.
        </p>
      </div>

      {/* Filter and Query Form */}
      <form onSubmit={onSubmit} className="space-y-4 border border-border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 text-xs text-muted">
            <label htmlFor={adminKeyInputId}>Admin API key</label>
            <input
              id={adminKeyInputId}
              type="password"
              autoComplete="off"
              value={adminKey}
              onChange={(e) => persistKey(e.target.value)}
              placeholder="Bearer token value"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="jobs-admin-key"
            />
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted">
            <label htmlFor={statusFilterId}>Status</label>
            <select
              id={statusFilterId}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | JobStatus)}
              className="border border-border bg-background px-3 py-2 text-sm text-foreground"
              data-testid="jobs-filter-status"
            >
              {VALID_STATUSES.map((s) => (
                <option key={s.value || "all"} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted">
            <label htmlFor={queueFilterId}>Queue / Type</label>
            <input
              id={queueFilterId}
              type="text"
              value={queueFilter}
              onChange={(e) => setQueueFilter(e.target.value)}
              placeholder="e.g. audit_log_write"
              className="border border-border bg-background px-3 py-2 text-sm text-foreground font-mono"
              data-testid="jobs-filter-queue"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:opacity-50 cursor-pointer font-medium"
            data-testid="jobs-load"
          >
            {loading ? "Loading…" : loaded ? "Refresh" : "Load background jobs"}
          </button>
          {(statusFilter || queueFilter) && (
            <button
              type="button"
              onClick={onClearFilters}
              className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover cursor-pointer"
              data-testid="jobs-clear-filter"
            >
              Clear filters
            </button>
          )}
        </div>
      </form>

      {/* Global Error Banner */}
      {error && (
        <div
          className="border border-red-500/40 bg-red-500/5 text-sm text-red-600 px-4 py-3"
          data-testid="jobs-error"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Table */}
      {loaded && !error && (
        <div className="space-y-3">
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-left text-xs font-mono" aria-label="Background jobs">
              <thead className="bg-surface border-b border-border text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Created</th>
                  <th scope="col" className="px-3 py-2 font-medium">ID</th>
                  <th scope="col" className="px-3 py-2 font-medium">Queue / Type</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Attempts</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last error</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted" data-testid="jobs-empty">
                      No background jobs match the current filters.
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => {
                    const actionState = actionStates[job.id];
                    const isCancellable = job.status === "pending" || job.status === "leased";
                    const isRetryable = job.status === "dead_letter" || job.status === "cancelled";

                    return (
                      <tr
                        key={job.id}
                        className={`border-b border-border/60 hover:bg-surface/60 transition-colors ${
                          selectedJob?.id === job.id ? "bg-surface-hover" : ""
                        }`}
                        data-testid="jobs-row"
                        data-job-id={job.id}
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-muted" title={job.createdAt}>
                          {formatTime(job.createdAt)}
                        </td>
                        <td className="px-3 py-2 text-foreground font-mono max-w-[8rem] truncate" title={job.id}>
                          {job.id}
                        </td>
                        <td className="px-3 py-2 text-foreground font-medium">{job.queue}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`inline-block border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${statusBadgeClass(
                              job.status,
                            )}`}
                            data-testid={`jobs-status-${job.id}`}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted whitespace-nowrap">
                          {job.attempts} / {job.maxAttempts}
                        </td>
                        <td
                          className="px-3 py-2 text-red-500 max-w-xs truncate"
                          title={job.lastError ?? undefined}
                        >
                          {job.lastError ?? "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right space-x-2">
                          {/* Inspect button */}
                          <button
                            type="button"
                            onClick={() => setSelectedJob(job)}
                            className="px-2.5 py-1 text-xs border border-border text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
                            data-testid={`jobs-inspect-${job.id}`}
                            data-testid-btn="jobs-inspect"
                            aria-label={`Inspect job ${job.id}`}
                          >
                            Inspect
                          </button>

                          {/* Cancel button */}
                          {isCancellable && (
                            <button
                              type="button"
                              disabled={actionState?.status === "pending"}
                              onClick={() => setConfirmAction({ type: "cancel", job })}
                              className="px-2.5 py-1 text-xs border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors disabled:opacity-50 cursor-pointer"
                              data-testid={`jobs-cancel-${job.id}`}
                              data-testid-btn="jobs-cancel"
                              aria-label={`Cancel job ${job.id}`}
                            >
                              {actionState?.status === "pending" && actionState.type === "cancel"
                                ? "Cancelling…"
                                : "Cancel"}
                            </button>
                          )}

                          {/* Retry button */}
                          {isRetryable && (
                            <button
                              type="button"
                              disabled={actionState?.status === "pending"}
                              onClick={() => setConfirmAction({ type: "retry", job })}
                              className="px-2.5 py-1 text-xs border border-border text-accent hover:bg-surface-hover transition-colors disabled:opacity-50 cursor-pointer"
                              data-testid={`jobs-retry-${job.id}`}
                              data-testid-btn="jobs-retry"
                              aria-label={`Retry job ${job.id}`}
                            >
                              {actionState?.status === "pending" && actionState.type === "retry"
                                ? "Retrying…"
                                : "Retry"}
                            </button>
                          )}

                          {/* Inline action status / error feedback */}
                          {actionState?.status === "done" && (
                            <span className="text-[11px] text-accent font-semibold ml-1">
                              {actionState.type === "cancel" ? "Cancelled" : "Requeued"}
                            </span>
                          )}
                          {actionState?.status === "error" && (
                            <div className="text-[11px] text-red-500 mt-1" role="alert">
                              {actionState.message}
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

          {/* Pagination */}
          {nextCursor && (
            <div className="pt-2">
              <button
                type="button"
                disabled={loading}
                onClick={() => void fetchJobs(nextCursor, true)}
                className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover disabled:opacity-50 cursor-pointer"
                data-testid="jobs-load-more"
              >
                {loading ? "Loading more…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Detail Drawer */}
      {selectedJob && (
        <div
          className="fixed inset-0 z-50 overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="jobs-drawer-title"
          data-testid="jobs-drawer"
        >
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 transition-opacity"
            onClick={() => setSelectedJob(null)}
            aria-hidden="true"
          />

          <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
            <aside className="w-screen max-w-xl bg-surface border-l border-border shadow-2xl flex flex-col z-50">
              {/* Drawer Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background">
                <div>
                  <h2 id="jobs-drawer-title" className="text-lg font-bold text-foreground">
                    Job Details
                  </h2>
                  <p className="text-xs text-muted font-mono mt-0.5" data-testid="jobs-drawer-id">
                    {selectedJob.id}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedJob(null)}
                  className="p-2 text-muted hover:text-foreground text-lg rounded hover:bg-surface-hover transition-colors cursor-pointer"
                  data-testid="jobs-drawer-close"
                  aria-label="Close job details"
                >
                  ✕
                </button>
              </div>

              {/* Drawer Content */}
              <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
                {/* Status & Queue */}
                <div className="grid grid-cols-2 gap-4 border border-border bg-background p-4">
                  <div>
                    <span className="text-muted block mb-1">Status</span>
                    <span
                      className={`inline-block border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${statusBadgeClass(
                        selectedJob.status,
                      )}`}
                    >
                      {selectedJob.status}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted block mb-1">Queue / Type</span>
                    <span className="font-semibold text-foreground text-sm font-mono">{selectedJob.queue}</span>
                  </div>
                  <div>
                    <span className="text-muted block mb-1">Attempts</span>
                    <span className="text-foreground font-mono">
                      {selectedJob.attempts} / {selectedJob.maxAttempts}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted block mb-1">Retry Class</span>
                    <span className="text-foreground font-mono">{selectedJob.retryClass}</span>
                  </div>
                  <div>
                    <span className="text-muted block mb-1">Priority</span>
                    <span className="text-foreground font-mono">{selectedJob.priority}</span>
                  </div>
                  <div>
                    <span className="text-muted block mb-1">Cancel Requested</span>
                    <span className="text-foreground font-mono">{selectedJob.cancelRequested ? "Yes" : "No"}</span>
                  </div>
                </div>

                {/* Timestamps */}
                <div className="border border-border bg-background p-4 space-y-2">
                  <h3 className="font-semibold text-foreground text-sm border-b border-border pb-1">Timestamps</h3>
                  <div className="grid grid-cols-2 gap-2 text-muted">
                    <div>
                      <span>Created:</span>{" "}
                      <span className="text-foreground font-mono">{formatTime(selectedJob.createdAt)}</span>
                    </div>
                    <div>
                      <span>Run At:</span>{" "}
                      <span className="text-foreground font-mono">{formatTime(selectedJob.runAt)}</span>
                    </div>
                    <div>
                      <span>Updated:</span>{" "}
                      <span className="text-foreground font-mono">{formatTime(selectedJob.updatedAt)}</span>
                    </div>
                    <div>
                      <span>Completed:</span>{" "}
                      <span className="text-foreground font-mono">{formatTime(selectedJob.completedAt)}</span>
                    </div>
                  </div>
                </div>

                {/* Lease Details if leased */}
                {(selectedJob.leaseOwner || selectedJob.leaseId) && (
                  <div className="border border-border bg-background p-4 space-y-2">
                    <h3 className="font-semibold text-foreground text-sm border-b border-border pb-1">Lease Details</h3>
                    <div className="space-y-1 text-muted">
                      <div>
                        <span>Owner:</span>{" "}
                        <span className="text-foreground font-mono">{selectedJob.leaseOwner ?? "—"}</span>
                      </div>
                      <div>
                        <span>Expires:</span>{" "}
                        <span className="text-foreground font-mono">{formatTime(selectedJob.leaseExpiresAt)}</span>
                      </div>
                      <div>
                        <span>Heartbeat:</span>{" "}
                        <span className="text-foreground font-mono">{formatTime(selectedJob.heartbeatAt)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Last Error */}
                <div>
                  <h3 className="font-semibold text-foreground text-sm mb-2">Last Error</h3>
                  {selectedJob.lastError ? (
                    <div
                      className="border border-red-500/40 bg-red-500/10 p-3 text-red-500 font-mono break-words rounded"
                      data-testid="jobs-drawer-last-error"
                      role="alert"
                    >
                      {selectedJob.lastError}
                    </div>
                  ) : (
                    <p className="text-muted font-mono" data-testid="jobs-drawer-last-error">
                      None
                    </p>
                  )}
                </div>

                {/* Redacted Payload */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-foreground text-sm">Payload (Redacted)</h3>
                    <span className="text-[11px] text-muted">Sensitive values masked</span>
                  </div>
                  <pre
                    className="border border-border bg-background p-3 text-foreground font-mono text-xs overflow-x-auto rounded max-h-60"
                    data-testid="jobs-drawer-payload"
                  >
                    {redactedPayload}
                  </pre>
                </div>

                {/* Redacted Result (if available) */}
                {redactedResult && (
                  <div>
                    <h3 className="font-semibold text-foreground text-sm mb-2">Execution Result</h3>
                    <pre
                      className="border border-border bg-background p-3 text-foreground font-mono text-xs overflow-x-auto rounded max-h-60"
                      data-testid="jobs-drawer-result"
                    >
                      {redactedResult}
                    </pre>
                  </div>
                )}
              </div>

              {/* Drawer Footer Actions */}
              <div className="px-6 py-4 border-t border-border bg-background flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setSelectedJob(null)}
                  className="px-4 py-2 border border-border text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  Close
                </button>

                <div className="flex gap-2">
                  {(selectedJob.status === "pending" || selectedJob.status === "leased") && (
                    <button
                      type="button"
                      onClick={() => setConfirmAction({ type: "cancel", job: selectedJob })}
                      className="px-4 py-2 border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors cursor-pointer"
                      data-testid="jobs-drawer-cancel-btn"
                    >
                      Cancel Job
                    </button>
                  )}
                  {(selectedJob.status === "dead_letter" || selectedJob.status === "cancelled") && (
                    <button
                      type="button"
                      onClick={() => setConfirmAction({ type: "retry", job: selectedJob })}
                      className="px-4 py-2 border border-border text-accent hover:bg-surface-hover transition-colors cursor-pointer"
                      data-testid="jobs-drawer-retry-btn"
                    >
                      Retry Job
                    </button>
                  )}
                </div>
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-labelledby="jobs-confirm-title"
          data-testid="jobs-confirm-dialog"
        >
          <div className="bg-surface border border-border max-w-md w-full p-6 space-y-4 shadow-2xl">
            <h2 id="jobs-confirm-title" className="text-lg font-bold text-foreground">
              {confirmAction.type === "cancel" ? "Confirm Job Cancellation" : "Confirm Job Retry"}
            </h2>

            <p className="text-sm text-muted">
              {confirmAction.type === "cancel" ? (
                <>
                  Are you sure you want to cancel job <strong className="text-foreground">{confirmAction.job.id}</strong> (
                  <code className="text-accent">{confirmAction.job.queue}</code>)? Pending jobs will be cancelled
                  immediately; in-flight jobs will receive a cooperative cancellation signal.
                </>
              ) : (
                <>
                  Are you sure you want to retry job <strong className="text-foreground">{confirmAction.job.id}</strong> (
                  <code className="text-accent">{confirmAction.job.queue}</code>)? This will reset attempt count and
                  re-queue the job for execution.
                </>
              )}
            </p>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 text-sm border border-border text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer"
                data-testid="jobs-confirm-dismiss"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmAction.type === "cancel") {
                    void executeCancel(confirmAction.job);
                  } else {
                    void executeRetry(confirmAction.job);
                  }
                }}
                className={`px-4 py-2 text-sm transition-colors cursor-pointer font-medium ${
                  confirmAction.type === "cancel"
                    ? "bg-amber-600 text-white hover:bg-amber-700"
                    : "bg-accent text-background hover:bg-accent/90"
                }`}
                data-testid="jobs-confirm-proceed"
              >
                {confirmAction.type === "cancel" ? "Confirm Cancel" : "Confirm Retry"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
