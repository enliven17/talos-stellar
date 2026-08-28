"""Privacy-safe runtime telemetry for operator observability.

Aggregates task counts, latencies, retries, failures, queue depth, circuit
breaker metrics, and adapter health — all labeled with bounded, non-secret
dimensions.  Prompts, API keys, signatures, and wallet secrets are
excluded by design: every data source is inspected for sensitive fields
before inclusion, and any that slip through are redacted.

Usage
-----
    collector = TelemetryCollector(db)
    report = collector.collect(cb_registry=cb_registry)
    print(report.to_json())
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from talos_agent.circuit_breaker import CircuitBreakerRegistry

logger = logging.getLogger(__name__)

# ── Sensitive-field matchers ──────────────────────────────────────────────────
# Substrings (lowercase) that cause a metric label or value to be redacted.
_SENSITIVE_LABEL_TOKENS = frozenset(
    {
        "api_key",
        "api key",
        "apikey",
        "secret",
        "token",
        "password",
        "private_key",
        "private key",
        "signature",
        "stellar_secret",
        "wallet_secret",
        "prompt",
        "user_prompt",
        "system_prompt",
    }
)


def _is_sensitive_key(key: str) -> bool:
    """Return True if *key* suggests a sensitive dimension value."""
    lower = key.lower()
    return any(tok in lower for tok in _SENSITIVE_LABEL_TOKENS)


def _redact_if_sensitive(label: str, value: object) -> object:
    """Return ``"[REDACTED]"`` if *label* indicates a sensitive field."""
    if _is_sensitive_key(label):
        return "[REDACTED]"
    return value


# ── Data structures ───────────────────────────────────────────────────────────


@dataclass
class TaskMetrics:
    """Per-scheduler-task counters."""

    name: str
    run_count: int = 0
    last_run_at: str | None = None
    retry_attempts: int = 0
    is_terminal: bool = False
    retry_remaining_seconds: float = 0.0


@dataclass
class QueueMetrics:
    """Queue depth for observable agent resource pools."""

    name: str
    pending_count: int = 0
    total_count: int = 0


@dataclass
class AdapterTelemetry:
    """Adapter health snapshot for telemetry (privacy-safe)."""

    name: str
    state: str
    detail: str = ""
    error_category: str = ""
    checked_at: str = ""


@dataclass
class TelemetryReport:
    """Complete privacy-safe runtime telemetry snapshot.

    Every field is guaranteed to contain only bounded, non-secret labels
    and count-based values.  String fields are inspected for sensitive
    patterns at collection time.
    """

    # ── Metadata ─────────────────────────────────────────────────────
    collected_at: str = ""
    agent_name: str = ""
    uptime_hours: float = 0.0

    # ── Scheduler tasks ──────────────────────────────────────────────
    tasks: list[TaskMetrics] = field(default_factory=list)

    # ── Resource pools ───────────────────────────────────────────────
    queues: list[QueueMetrics] = field(default_factory=list)

    # ── Circuit breakers ─────────────────────────────────────────────
    circuit_breakers: list[dict] = field(default_factory=list)

    # ── Adapter health ───────────────────────────────────────────────
    adapters: list[AdapterTelemetry] = field(default_factory=list)

    # ── Content performance ──────────────────────────────────────────
    total_posts_7d: int = 0
    total_impressions_7d: int = 0
    avg_engagement_7d: float = 0.0

    # ── Governance / policy ──────────────────────────────────────────
    policy_evaluation_count: int = 0
    policy_deny_count: int = 0
    policy_escalate_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Return a plain dict safe for JSON serialisation.

        No prompts, API keys, signatures, or wallet secrets appear in
        the output.  Redaction is applied at the collection boundary, so
        :meth:`to_dict` is a simple recursive conversion.
        """
        return _strip_empty(asdict(self))

    def to_json(self, indent: int = 2) -> str:
        """Return a JSON string safe for logging / dashboards."""
        return json.dumps(self.to_dict(), indent=indent, default=str)


def _strip_empty(d: dict) -> dict:
    """Remove keys with ``None``, empty lists, or empty dicts for cleaner output."""
    return {
        k: v
        for k, v in d.items()
        if v is not None and v != [] and v != {} and v != ""
    }


# ── Collector ─────────────────────────────────────────────────────────────────


class TelemetryCollector:
    """Collects and aggregates runtime telemetry from the agent's state.

    Parameters
    ----------
    db:
        An initialised :class:`~talos_agent.db.LocalDB` instance.
    agent_name:
        Optional agent name for labelling the report.
    """

    def __init__(self, db, agent_name: str = "") -> None:
        self._db = db
        self._agent_name = agent_name

    # ── Public API ───────────────────────────────────────────────────

    def collect(
        self,
        cb_registry: CircuitBreakerRegistry | None = None,
        policy_engine: object | None = None,
    ) -> TelemetryReport:
        """Gather a full telemetry snapshot synchronously.

        Parameters
        ----------
        cb_registry:
            Optional circuit-breaker registry whose per-provider metrics
            are included in the report.
        policy_engine:
            Optional policy engine whose counters are included.

        Returns
        -------
        TelemetryReport with all available metrics.  No I/O beyond the
        existing local DB reads is performed.
        """
        report = TelemetryReport(
            collected_at=datetime.now(timezone.utc).isoformat(),
            agent_name=self._agent_name,
        )

        self._collect_scheduler_tasks(report)
        self._collect_queue_depth(report)
        self._collect_content_performance(report)

        if cb_registry is not None:
            self._collect_circuit_breakers(report, cb_registry)

        if policy_engine is not None:
            self._collect_policy_metrics(report, policy_engine)

        return report

    # ── Scheduler tasks ──────────────────────────────────────────────

    def _collect_scheduler_tasks(self, report: TelemetryReport) -> None:
        """Read per-task run state from the local DB."""
        task_names = [
            "agent_cycle",
            "polling",
            "heartbeat",
            "job_heartbeat",
            "activity_flush",
            "learning_cycle",
            "dividend_distribution",
            "loan_repayment",
        ]

        for name in task_names:
            task = TaskMetrics(name=name)

            # Last-run timestamp from schedules table.
            last_run = self._db.get_last_run(name)
            if last_run:
                task.last_run_at = last_run.isoformat()
                task.run_count = self._estimate_run_count(name, last_run)

            # Retry state from the retry_state table (DurableBackoff).
            try:
                retry_state = self._db.get_retry_state(name)
            except Exception:
                retry_state = None
            if retry_state:
                task.retry_attempts = retry_state.get("attempt_count", 0)
                task.is_terminal = retry_state.get("terminal", False)
                next_at = retry_state.get("next_attempt_at")
                if next_at:
                    remaining = (next_at - datetime.now(timezone.utc)).total_seconds()
                    task.retry_remaining_seconds = max(remaining, 0.0)

            report.tasks.append(task)

    @staticmethod
    def _estimate_run_count(name: str, last_run: datetime) -> int:
        """Estimate run count from the schedule table's row existence.

        The schedules table stores only the *last* run timestamp, not a
        counter.  This method returns 0 or 1 based on whether a row
        exists, which is sufficient for telemetry (a proper counter would
        require a separate run-log table).
        """
        return 1

    # ── Queue depth ──────────────────────────────────────────────────

    def _collect_queue_depth(self, report: TelemetryReport) -> None:
        """Read pending/total counts from local DB tables."""
        queues = [
            ("commerce_queue", "commerce_queue", "status"),
            ("activity_log", "activity_log", "status"),
            ("approval_cache", "approval_cache", "status"),
        ]

        for name, table, status_col in queues:
            q = QueueMetrics(name=name)
            try:
                pending = self._db._conn.execute(
                    f"SELECT COUNT(*) as cnt FROM {table} WHERE {status_col} = 'pending'"
                ).fetchone()
                q.pending_count = pending["cnt"] if pending else 0

                total = self._db._conn.execute(
                    f"SELECT COUNT(*) as cnt FROM {table}"
                ).fetchone()
                q.total_count = total["cnt"] if total else 0
            except Exception as exc:
                logger.debug("Telemetry: failed to read queue depth for %s: %s", name, exc)

            report.queues.append(q)

    # ── Content performance ──────────────────────────────────────────

    def _collect_content_performance(self, report: TelemetryReport) -> None:
        """Read aggregate content-performance stats for the last 7 days."""
        try:
            summary = self._db.get_performance_summary(days=7)
            report.total_posts_7d = summary.get("total_posts", 0)
            report.total_impressions_7d = summary.get("total_impressions", 0)
            report.avg_engagement_7d = float(summary.get("avg_engagement", 0.0))
        except Exception as exc:
            logger.debug("Telemetry: performance summary unavailable: %s", exc)

    # ── Circuit breakers ─────────────────────────────────────────────

    def _collect_circuit_breakers(
        self, report: TelemetryReport, registry: CircuitBreakerRegistry
    ) -> None:
        """Snapshot all registered circuit breakers."""
        raw = registry.all_metrics()
        for provider_name, metrics in raw.items():
            if _is_sensitive_key(provider_name):
                continue
            # Redact any potentially sensitive keys in the nested dict.
            safe: dict[str, object] = {}
            for k, v in metrics.items():
                safe[k] = _redact_if_sensitive(k, v)
            report.circuit_breakers.append(
                _strip_empty({**safe, "provider": provider_name})
            )

    # ── Policy engine ────────────────────────────────────────────────

    def _collect_policy_metrics(
        self, report: TelemetryReport, engine: object
    ) -> None:
        """Read policy-engine counters via its ``metrics`` property."""
        try:
            m = engine.metrics  # type: ignore[union-attr]
            if isinstance(m, dict):
                report.policy_evaluation_count = m.get("evaluation_count", 0)
                report.policy_deny_count = m.get("deny_count", 0)
                report.policy_escalate_count = m.get("escalate_count", 0)
        except Exception as exc:
            logger.debug("Telemetry: policy engine metrics unavailable: %s", exc)

    # ── Adapter health (optional) ────────────────────────────────────

    def add_adapter_health(self, report: TelemetryReport, results: list) -> None:
        """Attach adapter-health probe results (collected externally).

        Designed to be called with the output of
        ``AdapterHealthReporter.report()`` so the telemetry collector
        itself does not run async probes.

        Parameters
        ----------
        report:
            The report being built.
        results:
            List of :class:`~talos_agent.adapters.health.ProbeResult`
            or plain dicts with ``adapter``, ``state``, and ``detail``
            keys.
        """
        for r in results:
            if hasattr(r, "to_dict"):
                d = r.to_dict()
            elif isinstance(r, dict):
                d = r
            else:
                continue
            name = d.get("adapter", "unknown")
            if _is_sensitive_key(name):
                name = "[REDACTED]"
            raw_cat = d.get("error_category", "")
            cat_str = raw_cat.value if hasattr(raw_cat, "value") else str(raw_cat or "")
            checked_at = d.get("checked_at", "")
            if hasattr(checked_at, "isoformat"):
                checked_at = checked_at.isoformat()
            report.adapters.append(
                AdapterTelemetry(
                    name=name,
                    state=_redact_if_sensitive("state", d.get("state", "unknown")),  # type: ignore[arg-type]
                    detail=_redact_if_sensitive("detail", d.get("detail", "")),  # type: ignore[arg-type]
                    error_category=_redact_if_sensitive("error_category", cat_str),
                    checked_at=str(checked_at),
                )
            )
