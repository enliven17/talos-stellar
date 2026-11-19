"""LocalDB — façade that exposes the full public API by delegating to
per-domain repositories that all share a single SQLite connection.

Callers continue to use ``LocalDB`` exactly as before; the internal
organisation is now decomposed into focused repo classes.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path

from talos_agent.db.migrations import DB_PATH, run_migrations
from talos_agent.db.repos import (
    ActivityRepo,
    CommerceRepo,
    ConfigRepo,
    ContentRepo,
    CyclesRepo,
    DividendRepo,
    JobsRepo,
    LearningsRepo,
    LoanRepo,
    ReplayRepo,
    RetryRepo,
    SpendingRepo,
)


class LocalDB:
    """SQLite local database — schedule state, caches, activity buffer.

    All domain logic is delegated to per-domain repositories; this class
    exists purely as a backwards-compatible façade so existing callers do
    not need to be updated.
    """

    def __init__(self, path: Path = DB_PATH, *, timeout_ms: int = 5000):
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(f"PRAGMA busy_timeout = {max(timeout_ms, 1)}")
        self._conn.execute("PRAGMA journal_mode=WAL")
        run_migrations(self._conn)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

        # Instantiate per-domain repos — all share the same connection.
        self._activity = ActivityRepo(self._conn)
        self._content = ContentRepo(self._conn)
        self._commerce = CommerceRepo(self._conn)
        self._spending = SpendingRepo(self._conn)
        self._loans = LoanRepo(self._conn)
        self._dividends = DividendRepo(self._conn)
        self._learnings = LearningsRepo(self._conn)
        self._config = ConfigRepo(self._conn)
        self._jobs = JobsRepo(self._conn)
        self._retry = RetryRepo(self._conn)
        self._replay = ReplayRepo(self._conn)
        self._cycles = CyclesRepo(self._conn)

    # ── Legacy migration runner (kept for tests that monkeypatch it) ──────

    def _run_migrations(self) -> None:
        """Delegates to the standalone ``run_migrations`` helper."""
        run_migrations(self._conn)

    # ── Schedules ─────────────────────────────────────────────────────────

    def get_last_run(self, task_name: str) -> datetime | None:
        return self._config.get_last_run(task_name)

    def update_schedule(self, task_name: str) -> None:
        self._config.update_schedule(task_name)

    # ── Activity Log ──────────────────────────────────────────────────────

    def add_activity(self, type_: str, content: str, channel: str) -> None:
        self._activity.add_activity(type_, content, channel)

    def get_pending_activities(self, limit: int = 50) -> list[dict]:
        return self._activity.get_pending_activities(limit)

    def mark_activities_sent(self, ids: list[int]) -> None:
        self._activity.mark_activities_sent(ids)

    def count_today(self, type_: str) -> int:
        return self._activity.count_today(type_)

    def count_today_by_channel(self, type_: str, channel: str) -> int:
        return self._activity.count_today_by_channel(type_, channel)

    # ── Content History ───────────────────────────────────────────────────

    def add_content(self, content: str, channel: str) -> int:
        return self._content.add_content(content, channel)

    def get_content(self, content_id: int) -> dict | None:
        return self._content.get_content(content_id)

    def content_exists(self, content_id: int) -> bool:
        return self._content.content_exists(content_id)

    def get_recent_content(self, limit: int = 20) -> list[dict]:
        return self._content.get_recent_content(limit)

    def get_recent_content_by_channel(self, channel: str, limit: int = 20) -> list[dict]:
        return self._content.get_recent_content_by_channel(channel, limit)

    # ── Commerce Queue ────────────────────────────────────────────────────

    def add_commerce_job(self, job_id: str, talos_id: str, service_type: str, payload: dict | None = None) -> None:
        self._commerce.add_commerce_job(job_id, talos_id, service_type, payload)

    def update_commerce_status(self, job_id: str, status: str) -> None:
        self._commerce.update_commerce_status(job_id, status)

    def count_pending_commerce_jobs(self) -> int:
        return self._commerce.count_pending_commerce_jobs()

    # ── Approval Cache ────────────────────────────────────────────────────

    def cache_approval(self, approval_id: str, type_: str, title: str, description: str | None, amount: float | None) -> None:
        self._spending.cache_approval(approval_id, type_, title, description, amount)

    def get_pending_approvals(self) -> list[dict]:
        return self._spending.get_pending_approvals()

    def update_approval_status(self, approval_id: str, status: str) -> None:
        self._spending.update_approval_status(approval_id, status)

    # ── Talos Config Cache ────────────────────────────────────────────────

    def set_config(self, key: str, value: str) -> None:
        self._config.set_config(key, value)

    def get_config(self, key: str) -> str | None:
        return self._config.get_config(key)

    def set_talos_config(self, data: dict) -> None:
        self._config.set_talos_config(data)

    def get_talos_config(self) -> dict | None:
        return self._config.get_talos_config()

    # ── Playbooks ─────────────────────────────────────────────────────────

    def save_playbook(self, name: str, data: dict, source_talos: str | None = None) -> None:
        self._config.save_playbook(name, data, source_talos)

    def find_playbook_by_name(self, name: str) -> dict | None:
        return self._config.find_playbook_by_name(name)

    def get_active_playbook(self) -> dict | None:
        return self._config.get_active_playbook()

    def apply_playbook(self, playbook_id: int) -> None:
        self._config.apply_playbook(playbook_id)

    # ── Spending Tracker ──────────────────────────────────────────────────

    def record_spending(self, amount: float, category: str, description: str = "", currency: str = "USDC") -> None:
        self._spending.record_spending(amount, category, description, currency)

    def get_spending_today(self) -> float:
        return self._spending.get_spending_today()

    def get_spending_period(self, days: int = 30) -> float:
        return self._spending.get_spending_period(days)

    def get_spending_by_category_today(self) -> dict[str, float]:
        return self._spending.get_spending_by_category_today()

    def get_spending_by_category_period(self, days: int = 30) -> dict[str, float]:
        return self._spending.get_spending_by_category_period(days)

    def get_pending_approval_totals(self) -> dict:
        return self._spending.get_pending_approval_totals()

    # ── Content Performance ───────────────────────────────────────────────

    def record_performance(
        self,
        content_id: int,
        channel: str,
        likes: int = 0,
        reposts: int = 0,
        replies: int = 0,
        impressions: int = 0,
        followers_at: int = 0,
    ) -> None:
        self._content.record_performance(content_id, channel, likes, reposts, replies, impressions, followers_at)

    def get_content_with_performance(self, limit: int = 20) -> list[dict]:
        return self._content.get_content_with_performance(limit)

    def get_unmeasured_content(self, limit: int = 10) -> list[dict]:
        return self._content.get_unmeasured_content(limit)

    def get_top_performing_content(self, limit: int = 5) -> list[dict]:
        return self._content.get_top_performing_content(limit)

    def get_performance_summary(self, days: int = 7) -> dict:
        return self._content.get_performance_summary(days)

    def get_performance_summary_by_channel(self, channel: str, days: int = 7) -> dict:
        return self._content.get_performance_summary_by_channel(channel, days)

    # ── Strategy Learnings ────────────────────────────────────────────────

    def save_learning(
        self,
        category: str,
        insight: str,
        evidence: str = "",
        confidence: float = 0.5,
        expires_days: int | None = 30,
    ) -> int:
        return self._learnings.save_learning(category, insight, evidence, confidence, expires_days)

    def get_active_learnings(self, limit: int = 10) -> list[dict]:
        return self._learnings.get_active_learnings(limit)

    def mark_learning_applied(self, learning_id: int) -> None:
        self._learnings.mark_learning_applied(learning_id)

    def evict_expired_learnings(self, *, now: datetime | None = None) -> dict:
        return self._learnings.evict_expired_learnings(now=now)

    # ── Audience Insights ─────────────────────────────────────────────────

    def upsert_audience_insight(
        self,
        segment: str,
        description: str,
        engagement_score: float = 0.0,
        keywords: list[str] | None = None,
    ) -> None:
        self._learnings.upsert_audience_insight(segment, description, engagement_score, keywords)

    def get_audience_insights(self, limit: int = 5) -> list[dict]:
        return self._learnings.get_audience_insights(limit)

    # ── Dividends ─────────────────────────────────────────────────────────

    def record_dividend(
        self,
        recipient_address: str,
        token_symbol: str,
        amount: float,
        currency: str = "USDC",
        spending_log_id: int | None = None,
        tx_hash: str | None = None,
        note: str = "",
    ) -> int:
        return self._dividends.record_dividend(
            recipient_address, token_symbol, amount, currency, spending_log_id, tx_hash, note
        )

    def get_dividend_history(self, limit: int = 50, recipient_address: str | None = None) -> list[dict]:
        return self._dividends.get_dividend_history(limit, recipient_address)

    # ── Loans ─────────────────────────────────────────────────────────────

    def create_loan(
        self,
        platform: str,
        amount: float,
        collateral_asset: str,
        loan_asset: str,
        duration_days: int,
        purpose: str = "",
        repayment_address: str | None = None,
    ) -> int:
        return self._loans.create_loan(
            platform, amount, collateral_asset, loan_asset,
            duration_days, purpose, repayment_address
        )

    def get_active_loans(self) -> list[dict]:
        return self._loans.get_active_loans()

    def get_loan_by_id(self, loan_id: int) -> dict | None:
        return self._loans.get_loan_by_id(loan_id)

    def record_repayment(self, loan_id: int, amount: float, tx_hash: str | None = None) -> None:
        self._loans.record_repayment(loan_id, amount, tx_hash)

    def get_loans_due_soon(self, days: int = 7) -> list[dict]:
        return self._loans.get_loans_due_soon(days)

    # ── Retry State ───────────────────────────────────────────────────────

    def upsert_retry_state(
        self,
        task_name: str,
        attempt_count: int,
        next_attempt_at: datetime,
        terminal: bool = False,
    ) -> None:
        self._retry.upsert_retry_state(task_name, attempt_count, next_attempt_at, terminal)

    def save_retry_state(
        self,
        task_name: str,
        *,
        attempt_count: int,
        next_attempt_at: datetime | None,
        terminal: bool = False,
    ) -> None:
        self._retry.save_retry_state(
            task_name, attempt_count=attempt_count,
            next_attempt_at=next_attempt_at, terminal=terminal
        )

    def get_retry_state(self, task_name: str) -> dict | None:
        return self._retry.get_retry_state(task_name)

    def clear_retry_state(self, task_name: str) -> None:
        self._retry.clear_retry_state(task_name)

    # ── Claimed Jobs ──────────────────────────────────────────────────────

    def upsert_claimed_job(
        self,
        job_id: str,
        fencing_token: int,
        ttl_seconds: int = 300,
        lease_expires_at: datetime | None = None,
    ) -> None:
        self._jobs.upsert_claimed_job(job_id, fencing_token, ttl_seconds, lease_expires_at)

    def get_claimed_job(self, job_id: str) -> dict | None:
        return self._jobs.get_claimed_job(job_id)

    def get_all_claimed_jobs(self) -> list[dict]:
        return self._jobs.get_all_claimed_jobs()

    def delete_claimed_job(self, job_id: str) -> None:
        self._jobs.delete_claimed_job(job_id)

    # ── Completion Markers ────────────────────────────────────────────────

    def add_completion_marker(
        self,
        job_id: str,
        idempotency_key: str,
        retain_days: int = 7,
    ) -> None:
        self._jobs.add_completion_marker(job_id, idempotency_key, retain_days)

    def has_completion_marker(self, idempotency_key: str) -> bool:
        return self._jobs.has_completion_marker(idempotency_key)

    def get_completion_markers_for_job(self, job_id: str) -> list[dict]:
        return self._jobs.get_completion_markers_for_job(job_id)

    def prune_expired_completion_markers(self) -> int:
        return self._jobs.prune_expired_completion_markers()

    # ── WAL Health ────────────────────────────────────────────────────────

    def wal_health(
        self,
        *,
        run_checkpoint: bool = True,
        run_quick_check: bool = True,
    ):
        from talos_agent.wal_health import collect_wal_health
        return collect_wal_health(
            path=self._path,
            conn=self._conn,
            run_checkpoint=run_checkpoint,
            run_quick_check=run_quick_check,
        )

    # ── Cycle Summaries ───────────────────────────────────────────────────

    def save_cycle_summary(
        self,
        *,
        talos_id: str,
        cycle_id: str,
        started_at: str,
        ended_at: str,
        duration_ms: float,
        tool_calls: int,
        tool_names: list[str],
        error_type: str | None = None,
        error_category: str | None = None,
        outcome: str = "completed",
    ) -> int:
        return self._cycles.save_cycle_summary(
            talos_id=talos_id, cycle_id=cycle_id,
            started_at=started_at, ended_at=ended_at,
            duration_ms=duration_ms, tool_calls=tool_calls,
            tool_names=tool_names, error_type=error_type,
            error_category=error_category, outcome=outcome,
        )

    def get_recent_cycle_summaries(
        self,
        talos_id: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        return self._cycles.get_recent_cycle_summaries(talos_id, limit)

    def prune_old_cycle_summaries(
        self,
        talos_id: str | None = None,
        keep_last: int = 200,
    ) -> int:
        return self._cycles.prune_old_cycle_summaries(talos_id, keep_last)

    # ── Cleanup ───────────────────────────────────────────────────────────

    def close(self) -> None:
        self._conn.close()

    # ── Replay Sessions ───────────────────────────────────────────────────

    def create_replay_session(
        self,
        session_id: str,
        talos_id: str,
        agent_version: str,
        started_at: str,
    ) -> None:
        self._replay.create_replay_session(session_id, talos_id, agent_version, started_at)

    def finish_replay_session(self, session_id: str, status: str = "completed") -> None:
        self._replay.finish_replay_session(session_id, status)

    def insert_replay_event(
        self,
        session_id: str,
        event_id: str,
        event_type: str,
        payload_json: str,
        redacted: bool = False,
    ) -> None:
        self._replay.insert_replay_event(session_id, event_id, event_type, payload_json, redacted)

    def get_replay_events(self, session_id: str) -> list[sqlite3.Row]:
        return self._replay.get_replay_events(session_id)

    def list_replay_sessions(
        self,
        talos_id: str | None = None,
        limit: int = 20,
    ) -> list[sqlite3.Row]:
        return self._replay.list_replay_sessions(talos_id, limit)
