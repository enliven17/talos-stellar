"use client";

/**
 * Operator/governance surface for the agent lifecycle.
 *
 * Design constraints this component is deliberately built around:
 *   - Proposed / transient / failed / compensating / final states are visually
 *     and semantically distinct, never collapsed into one "status" pill.
 *   - Consequential actions require a connected wallet, a signature, and a
 *     typed confirmation — the button alone never performs the transition.
 *   - Snapshots carry an explicit "as of" and go stale rather than silently
 *     presenting old data as current.
 *   - History is keyset-paginated; the panel never loads an unbounded log.
 *   - Errors from the API are surfaced with their stable code and a concrete
 *     next step, not replaced with a generic failure message.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWallet } from "@/components/wallet-gate";

type LifecycleState =
  | "proposed"
  | "provisioning"
  | "active"
  | "paused"
  | "retiring"
  | "retired"
  | "recovery_pending"
  | "failed";

type LifecycleActionName = "create" | "activate" | "pause" | "retire" | "recover";

interface StepRecord {
  name: string;
  status: string;
  attempts: number;
  error: string | null;
}

interface RunRecord {
  id: string;
  action: string;
  status: string;
  steps: StepRecord[];
  cursor: number;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface LifecycleEvent {
  id: string;
  sequence: number;
  eventType: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  actorRole: string;
  stepName: string | null;
  createdAt: string;
}

interface LifecycleSnapshot {
  talosId: string;
  state: LifecycleState;
  observedAt: string;
  stateChangedAt: string | null;
  agentOnline: boolean;
  allowedActions: LifecycleActionName[];
  viewerRoles: string[];
  inFlightJobs: number;
  pendingProposals: { id: string; title: string; type: string }[];
  run: RunRecord | null;
  events: LifecycleEvent[];
  nextCursor: number | null;
}

/**
 * Presentation kind per state. `transient` states are server-owned and in
 * motion; `terminal` states admit no further action; `attention` states need an
 * operator decision before anything else happens.
 */
const STATE_KIND: Record<LifecycleState, "proposed" | "transient" | "settled" | "attention" | "terminal"> = {
  proposed: "proposed",
  provisioning: "transient",
  active: "settled",
  paused: "settled",
  retiring: "transient",
  retired: "terminal",
  recovery_pending: "attention",
  failed: "attention",
};

const KIND_STYLE: Record<string, string> = {
  proposed: "text-blue-400 border-blue-400/40",
  transient: "text-yellow-400 border-yellow-400/40",
  settled: "text-green-400 border-green-400/40",
  attention: "text-red-400 border-red-400/40",
  terminal: "text-muted border-border",
};

const STATE_HELP: Record<LifecycleState, string> = {
  proposed: "Awaiting governance approval. No resources have been allocated yet.",
  provisioning: "A durable job is allocating wallet, credentials, services, and runtime.",
  active: "Accepting new work.",
  paused: "Not accepting new work. In-flight jobs continue to drain.",
  retiring: "Draining outstanding work before the agent is retired.",
  retired: "Final. No further lifecycle transitions are possible.",
  recovery_pending: "Recovery was requested; a governance approval is needed to re-provision.",
  failed: "Provisioning failed and its completed steps were compensated. Review and recover.",
};

/** Actions that mutate money, credentials, or availability need a typed confirmation. */
const CONSEQUENTIAL: ReadonlySet<LifecycleActionName> = new Set(["activate", "retire", "recover"]);

/** How long a snapshot is treated as current before the UI marks it stale. */
const STALE_AFTER_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortAddress(address: string): string {
  if (address === "system") return "system";
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function AgentLifecyclePanel({ talosId }: { talosId: string }) {
  const { isConnected, address, connect, signMessage } = useWallet();

  const [snapshot, setSnapshot] = useState<LifecycleSnapshot | null>(null);
  const [olderEvents, setOlderEvents] = useState<LifecycleEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<LifecycleActionName | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [confirming, setConfirming] = useState<LifecycleActionName | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const confirmInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "10" });
    if (address) params.set("viewer", address);

    try {
      const res = await fetch(`/api/talos/${talosId}/lifecycle?${params}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError({ code: body.code ?? "LOAD_FAILED", message: body.error ?? "Could not load lifecycle" });
        return;
      }
      const data: LifecycleSnapshot = await res.json();
      setSnapshot(data);
      setOlderEvents([]);
      setCursor(data.nextCursor);
      setNow(Date.now());
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [talosId, address]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a durable run is in flight; idle otherwise so a settled agent
  // does not generate background traffic.
  useEffect(() => {
    const kind = snapshot ? STATE_KIND[snapshot.state] : null;
    if (kind !== "transient") return;
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [snapshot, load]);

  // Drive the staleness indicator without refetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (confirming) confirmInputRef.current?.focus();
  }, [confirming]);

  const isStale = useMemo(() => {
    if (!snapshot) return false;
    return now - new Date(snapshot.observedAt).getTime() > STALE_AFTER_MS;
  }, [snapshot, now]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const params = new URLSearchParams({ limit: "10", before: String(cursor) });
    const res = await fetch(`/api/talos/${talosId}/lifecycle?${params}`, { cache: "no-store" });
    if (!res.ok) return;
    const data: LifecycleSnapshot = await res.json();
    setOlderEvents((prev) => [...prev, ...data.events]);
    setCursor(data.nextCursor);
  }, [cursor, talosId]);

  const submitAction = useCallback(
    async (action: LifecycleActionName) => {
      if (!address || !snapshot) return;
      setPending(action);
      setError(null);

      try {
        // The signed message binds the agent, the action, and a timestamp, so a
        // captured signature cannot be replayed for a different transition.
        const message = `talos:${talosId}:lifecycle:${action}:${Date.now()}`;
        const signature = await signMessage(message);

        const payload: Record<string, unknown> = { confirmed: true };
        if (action === "pause") {
          payload.reason = "Paused from the governance console";
          payload.cancelPendingJobs = true;
          delete payload.confirmed;
        }
        if (action === "recover") payload.reason = "Recovery requested from the governance console";
        if (action === "retire") {
          payload.reason = "Retirement approved by governance";
          payload.drainJobs = true;
          payload.proposalId = snapshot.pendingProposals[0]?.id ?? "";
        }
        if (action === "activate") payload.proposalId = snapshot.pendingProposals[0]?.id ?? "";

        const res = await fetch(`/api/talos/${talosId}/lifecycle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, payload, address, message, signature }),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError({
            code: body.code ?? "REQUEST_FAILED",
            message: body.error ?? "The transition was rejected",
          });
          return;
        }

        await load();
      } catch (err) {
        setError({
          code: "SIGNATURE_FAILED",
          message: err instanceof Error ? err.message : "Wallet signature was not completed",
        });
      } finally {
        setPending(null);
        setConfirming(null);
        setConfirmText("");
      }
    },
    [address, snapshot, talosId, signMessage, load],
  );

  const onActionClick = useCallback(
    (action: LifecycleActionName) => {
      setError(null);
      if (CONSEQUENTIAL.has(action)) {
        setConfirming(action);
        setConfirmText("");
        return;
      }
      submitAction(action);
    },
    [submitAction],
  );

  if (loading) {
    return (
      <section aria-busy="true" aria-label="Agent lifecycle" className="bg-surface border border-border p-5">
        <p className="text-sm text-muted">Loading lifecycle…</p>
      </section>
    );
  }

  if (!snapshot) {
    return (
      <section aria-label="Agent lifecycle" className="bg-surface border border-border p-5">
        <p className="text-sm text-red-400">{error?.message ?? "Lifecycle unavailable"}</p>
      </section>
    );
  }

  const kind = STATE_KIND[snapshot.state];
  const events = [...snapshot.events, ...olderEvents];

  return (
    <section aria-label="Agent lifecycle" className="bg-surface border border-border p-5 space-y-5">
      {/* ── State header ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-xs font-bold border px-2 py-0.5 uppercase ${KIND_STYLE[kind]}`}
              aria-label={`Lifecycle state: ${snapshot.state}`}
            >
              {snapshot.state.replace("_", " ")}
            </span>
            {kind === "transient" && (
              <span role="status" className="text-xs text-yellow-400">
                in progress — this state is not final
              </span>
            )}
            {snapshot.inFlightJobs > 0 && (
              <span className="text-xs text-muted">{snapshot.inFlightJobs} job(s) in flight</span>
            )}
          </div>
          <p className="text-xs text-muted mt-1.5 leading-relaxed">{STATE_HELP[snapshot.state]}</p>
        </div>

        <div className="text-right shrink-0">
          <p className="text-xs text-muted/60" title={snapshot.observedAt}>
            as of {relativeTime(snapshot.observedAt)}
          </p>
          {isStale && (
            <button
              onClick={load}
              className="text-xs text-yellow-400 underline hover:text-yellow-300"
            >
              This view may be stale — refresh
            </button>
          )}
        </div>
      </div>

      {/* ── Pending approvals / timelock ─────────────────────────── */}
      {snapshot.pendingProposals.length > 0 && (
        <div className="border border-blue-400/30 px-4 py-3">
          <h3 className="text-xs font-bold text-blue-400 uppercase mb-2">
            Awaiting approval ({snapshot.pendingProposals.length})
          </h3>
          <ul className="space-y-1">
            {snapshot.pendingProposals.map((p) => (
              <li key={p.id} className="text-xs text-muted">
                <span className="uppercase text-muted/60">[{p.type}]</span> {p.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Durable run progress ─────────────────────────────────── */}
      {snapshot.run && (
        <div className="border border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-xs font-bold text-foreground uppercase">
              {snapshot.run.action} run
            </h3>
            <span className="text-xs text-muted">
              {snapshot.run.status}
              {snapshot.run.status === "compensating" && " — rolling back completed steps"}
            </span>
          </div>

          <ol className="space-y-1">
            {snapshot.run.steps.map((step, i) => (
              <li key={step.name} className="flex items-baseline gap-2 text-xs">
                <span className="text-muted/50 w-4 shrink-0">{i + 1}.</span>
                <span className="text-foreground w-28 shrink-0">{step.name}</span>
                <span
                  className={
                    step.status === "completed"
                      ? "text-green-400"
                      : step.status === "failed"
                        ? "text-red-400"
                        : step.status === "compensated"
                          ? "text-yellow-400"
                          : "text-muted"
                  }
                >
                  {step.status}
                  {step.attempts > 1 && ` (attempt ${step.attempts})`}
                </span>
                {step.error && <span className="text-red-400/80 truncate">{step.error}</span>}
              </li>
            ))}
          </ol>

          {snapshot.run.lastError && (
            <p role="alert" className="text-xs text-red-400 mt-2">
              {snapshot.run.lastError}
            </p>
          )}
        </div>
      )}

      {/* ── Actions ──────────────────────────────────────────────── */}
      <div>
        {!isConnected ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted">Connect your wallet to act on this agent.</p>
            <button
              onClick={connect}
              className="bg-accent text-background px-4 py-1.5 text-xs font-medium hover:bg-foreground transition-colors shrink-0"
            >
              Connect Wallet
            </button>
          </div>
        ) : snapshot.allowedActions.length === 0 ? (
          <p className="text-xs text-muted">
            {snapshot.viewerRoles.length === 0
              ? "This wallet holds no governance role on this agent."
              : `No actions are available from state "${snapshot.state}".`}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Lifecycle actions">
            {snapshot.allowedActions.map((action) => (
              <button
                key={action}
                onClick={() => onActionClick(action)}
                disabled={pending !== null}
                aria-describedby={CONSEQUENTIAL.has(action) ? `confirm-${action}` : undefined}
                className="text-xs px-3 py-1.5 border border-border text-foreground hover:border-accent hover:text-accent transition-colors disabled:opacity-40"
              >
                {pending === action ? `${action}…` : action}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Confirmation ─────────────────────────────────────────── */}
      {confirming && (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="lifecycle-confirm-title"
          className="border border-yellow-400/40 px-4 py-3 space-y-2"
        >
          <h3 id="lifecycle-confirm-title" className="text-xs font-bold text-yellow-400 uppercase">
            Confirm {confirming}
          </h3>
          <p id={`confirm-${confirming}`} className="text-xs text-muted">
            This action is consequential and is recorded on the governance audit trail. Type{" "}
            <span className="font-mono text-foreground">{confirming}</span> to proceed.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="lifecycle-confirm-input">
              Type {confirming} to confirm
            </label>
            <input
              id="lifecycle-confirm-input"
              ref={confirmInputRef}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="bg-background border border-border px-2 py-1 text-xs font-mono text-foreground"
              autoComplete="off"
            />
            <button
              onClick={() => submitAction(confirming)}
              disabled={confirmText !== confirming || pending !== null}
              className="text-xs px-3 py-1.5 border border-yellow-400/40 text-yellow-400 hover:bg-yellow-400 hover:text-background transition-colors disabled:opacity-40"
            >
              Sign &amp; {confirming}
            </button>
            <button
              onClick={() => {
                setConfirming(null);
                setConfirmText("");
              }}
              className="text-xs px-3 py-1.5 border border-border text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Errors ───────────────────────────────────────────────── */}
      {error && (
        <div role="alert" className="border border-red-400/40 px-4 py-3">
          <p className="text-xs font-mono text-red-400/70">{error.code}</p>
          <p className="text-xs text-red-400 mt-0.5">{error.message}</p>
        </div>
      )}

      {/* ── History ──────────────────────────────────────────────── */}
      <div>
        <h3 className="text-xs font-bold text-foreground uppercase mb-2">Transition history</h3>
        {events.length === 0 ? (
          <p className="text-xs text-muted">No lifecycle events recorded yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="text-xs flex flex-wrap items-baseline gap-2">
                <span className="text-muted/40 font-mono w-8 shrink-0">#{e.sequence}</span>
                <span className="text-foreground">{e.eventType.replace("agent.lifecycle.", "")}</span>
                <span className="text-muted">
                  {e.fromState ?? "—"} → {e.toState}
                </span>
                {e.stepName && <span className="text-muted/60">[{e.stepName}]</span>}
                <span className="text-muted/60">
                  {/* Only the truncated address is rendered; full keys stay in the API payload. */}
                  by {shortAddress(e.actorId)} ({e.actorRole})
                </span>
                <span className="text-muted/40" title={e.createdAt}>
                  {relativeTime(e.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        )}

        {cursor !== null && (
          <button
            onClick={loadMore}
            className="mt-3 text-xs px-3 py-1.5 border border-border text-muted hover:border-accent hover:text-accent transition-colors"
          >
            Load older events
          </button>
        )}
      </div>
    </section>
  );
}
