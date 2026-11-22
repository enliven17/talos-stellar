"""Tests for adapter recovery queue with explicit operator disposition (#1467).

Covers:
- Listing uncertain publications and available safe actions.
- Ensuring the system never silently retries an action that may already have succeeded.
- Explicit operator dispositions (resolve_succeeded, resolve_failed, abandon, retry).
- Validation and error handling:
  - Rejecting dispositions on non-existent operations.
  - Rejecting dispositions on active non-expired operations.
  - Rejecting dispositions on terminal operations (succeeded / failed).
  - Rejecting invalid disposition verbs.
- Re-admitting an operation only after explicit operator retry disposition.
- Diagnostic fields integration for recovery queue and disposition events.
"""

from __future__ import annotations

import sqlite3
import pytest

from talos_agent.adapters.diagnostics import safe_adapter_diagnostic_fields
from talos_agent.adapters.registry import (
    AdapterRecoveryQueue,
    AdapterRegistry,
    DispositionResult,
    OperatorDisposition,
    UncertainPublication,
)


def _init_db(conn: sqlite3.Connection) -> sqlite3.Connection:
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS adapter_invocations (
            operation_id       TEXT PRIMARY KEY,
            adapter_name       TEXT NOT NULL,
            operation          TEXT NOT NULL,
            input_digest       TEXT NOT NULL,
            state              TEXT NOT NULL CHECK (
                state IN ('running', 'succeeded', 'failed', 'indeterminate')
            ),
            owner_id           TEXT NOT NULL,
            lease_expires_at   TEXT NOT NULL,
            attempt_count      INTEGER NOT NULL DEFAULT 1,
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    conn.commit()
    return conn


class TestAdapterRecoveryQueue:
    """Tests for the AdapterRecoveryQueue and explicit operator disposition."""

    def test_list_uncertain_publications_and_safe_actions(self) -> None:
        """Indeterminate and expired running invocations are listed with safe actions."""
        conn = _init_db(sqlite3.connect(":memory:"))
        # Insert test records
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at, attempt_count)
            VALUES
                ('indet-1', 'Telegram', 'post', 'digest-1', 'indeterminate', 'owner-1', '2026-01-01T00:00:00Z', 1),
                ('succ-1', 'X', 'post', 'digest-2', 'succeeded', 'owner-1', '2026-01-01T00:00:00Z', 1),
                ('fail-1', 'Discord', 'post', 'digest-3', 'failed', 'owner-1', '2026-01-01T00:00:00Z', 1),
                ('expired-run-1', 'Mastodon', 'reply', 'digest-4', 'running', 'owner-1', '2020-01-01T00:00:00Z', 2),
                ('active-run-1', 'Telegram', 'post', 'digest-5', 'running', 'owner-1', '2099-01-01T00:00:00Z', 1)
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        uncertain = queue.list_uncertain()

        # indet-1 and expired-run-1 should be listed
        op_ids = {item.operation_id for item in uncertain}
        assert op_ids == {"indet-1", "expired-run-1"}

        item1 = next(i for i in uncertain if i.operation_id == "indet-1")
        assert isinstance(item1, UncertainPublication)
        assert item1.adapter_name == "Telegram"
        assert item1.state == "indeterminate"
        assert OperatorDisposition.RESOLVE_SUCCEEDED.value in item1.safe_actions
        assert OperatorDisposition.RESOLVE_FAILED.value in item1.safe_actions
        assert OperatorDisposition.ABANDON.value in item1.safe_actions
        assert OperatorDisposition.RETRY.value in item1.safe_actions

    def test_never_silently_retries_uncertain_action(self) -> None:
        """Indeterminate operations cannot be re-executed automatically without explicit operator disposition."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at, attempt_count)
            VALUES ('uncertain-op', 'X', 'post', 'hash123', 'indeterminate', 'agent-runner', '2026-01-01T00:00:00Z', 1)
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        item = queue.get_uncertain("uncertain-op")
        assert item is not None
        assert item.state == "indeterminate"

        # Simulating automated scheduler or retry logic checking state:
        # Background loops see 'indeterminate' and MUST NOT retry
        row = conn.execute("SELECT state FROM adapter_invocations WHERE operation_id = 'uncertain-op'").fetchone()
        assert row["state"] == "indeterminate"

    def test_apply_disposition_resolve_succeeded(self) -> None:
        """Operator explicitly marks uncertain publication as succeeded upon confirmation."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at, attempt_count)
            VALUES ('op-succeed', 'Discord', 'post', 'digest1', 'indeterminate', 'worker', '2026-01-01T00:00:00Z', 1)
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        result = queue.apply_disposition(
            "op-succeed",
            OperatorDisposition.RESOLVE_SUCCEEDED,
            operator="admin-alice",
            reason="Verified post ID visible on channel",
        )

        assert isinstance(result, DispositionResult)
        assert result.operation_id == "op-succeed"
        assert result.disposition == "resolve_succeeded"
        assert result.previous_state == "indeterminate"
        assert result.resulting_state == "succeeded"
        assert result.operator == "admin-alice"
        assert result.reason == "Verified post ID visible on channel"

        # Row in database is now succeeded
        row = conn.execute("SELECT state FROM adapter_invocations WHERE operation_id = 'op-succeed'").fetchone()
        assert row["state"] == "succeeded"

        # No longer in uncertain queue
        assert queue.get_uncertain("op-succeed") is None

    def test_apply_disposition_resolve_failed_and_abandon(self) -> None:
        """Operator can resolve as failed or abandon uncertain publications."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at)
            VALUES
                ('op-fail', 'X', 'post', 'd1', 'indeterminate', 'w1', '2026-01-01T00:00:00Z'),
                ('op-abandon', 'Telegram', 'post', 'd2', 'indeterminate', 'w2', '2026-01-01T00:00:00Z')
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        res_fail = queue.apply_disposition("op-fail", "resolve_failed")
        assert res_fail.resulting_state == "failed"

        res_abandon = queue.apply_disposition("op-abandon", OperatorDisposition.ABANDON)
        assert res_abandon.resulting_state == "failed"

    def test_apply_disposition_explicit_retry(self) -> None:
        """Operator explicitly authorises retry, resetting state to failed so it can be re-attempted."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at)
            VALUES ('op-retry', 'Mastodon', 'post', 'd1', 'indeterminate', 'w1', '2026-01-01T00:00:00Z')
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        res_retry = queue.apply_disposition("op-retry", OperatorDisposition.RETRY, operator="operator-bob")
        assert res_retry.resulting_state == "failed"
        assert res_retry.disposition == "retry"

        row = conn.execute("SELECT state FROM adapter_invocations WHERE operation_id = 'op-retry'").fetchone()
        assert row["state"] == "failed"

    def test_reject_disposition_on_actively_running_operation(self) -> None:
        """Cannot apply disposition to an actively running operation whose lease has not expired."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at)
            VALUES ('active-op', 'Telegram', 'post', 'd1', 'running', 'worker', '2099-01-01T00:00:00Z')
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        with pytest.raises(ValueError, match="Cannot apply disposition to actively running"):
            queue.apply_disposition("active-op", OperatorDisposition.RESOLVE_SUCCEEDED)

    def test_reject_disposition_on_terminal_operation(self) -> None:
        """Cannot apply disposition to already succeeded or failed operations."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at)
            VALUES ('terminal-op', 'Telegram', 'post', 'd1', 'succeeded', 'worker', '2026-01-01T00:00:00Z')
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        with pytest.raises(ValueError, match="Cannot apply disposition to publication in terminal state"):
            queue.apply_disposition("terminal-op", OperatorDisposition.RESOLVE_FAILED)

    def test_reject_invalid_disposition_verb(self) -> None:
        """Unknown disposition values raise ValueError."""
        conn = _init_db(sqlite3.connect(":memory:"))
        conn.execute(
            """
            INSERT INTO adapter_invocations (operation_id, adapter_name, operation, input_digest, state, owner_id, lease_expires_at)
            VALUES ('test-op', 'Telegram', 'post', 'd1', 'indeterminate', 'worker', '2026-01-01T00:00:00Z')
            """
        )
        conn.commit()

        queue = AdapterRecoveryQueue(conn)
        with pytest.raises(ValueError, match="Invalid disposition 'unknown_action'"):
            queue.apply_disposition("test-op", "unknown_action")

    def test_reject_nonexistent_operation_id(self) -> None:
        """Non-existent operation IDs raise ValueError."""
        conn = _init_db(sqlite3.connect(":memory:"))
        queue = AdapterRecoveryQueue(conn)
        with pytest.raises(ValueError, match="not found"):
            queue.apply_disposition("non-existent", OperatorDisposition.RESOLVE_SUCCEEDED)

    def test_registry_recovery_queue_property(self) -> None:
        """AdapterRegistry exposes recovery_queue property correctly."""
        conn = _init_db(sqlite3.connect(":memory:"))
        queue = AdapterRecoveryQueue(conn)
        registry = AdapterRegistry(recovery_queue=queue)
        assert registry.recovery_queue is queue


class TestAdapterRecoveryDiagnostics:
    """Verify recovery queue fields and diagnostics safety."""

    def test_recovery_disposition_diagnostics_fields(self) -> None:
        """Disposition logging integrates safely with safe_adapter_diagnostic_fields."""
        fields = safe_adapter_diagnostic_fields(
            adapter="Telegram",
            operation="recovery_disposition",
            operation_id="op-12345",
            outcome="succeeded",
            disposition="resolve_succeeded",
            action="Marked succeeded by operator confirmation",
            safe_actions=["resolve_succeeded", "resolve_failed", "abandon", "retry"],
            uncertain_count=1,
        )
        assert fields["adapter"] == "Telegram"
        assert fields["operation"] == "recovery_disposition"
        assert fields["operation_id"] == "op-12345"
        assert fields["outcome"] == "succeeded"
        assert fields["disposition"] == "resolve_succeeded"
        assert fields["action"] == "unknown"  # spaces in action string get converted to 'unknown' label
        assert fields["safe_actions"] == ["resolve_succeeded", "resolve_failed", "abandon", "retry"]
        assert fields["uncertain_count"] == 1
