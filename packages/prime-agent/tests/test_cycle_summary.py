"""Unit tests for cycle summary logging — issue #1002.

Acceptance criteria verified:
- Exactly one summary per cycle, including failure cycles.
- No secrets or raw tool arguments appear in summaries.
- Summary is persisted to LocalDB and retrievable.
- Redaction: sensitive keys in tool args do not surface in tool_names.
- _emit_cycle_summary with db=None does not raise.
"""

from __future__ import annotations

import json
import tempfile
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.agent.loop import (
    _emit_cycle_summary,
)
from talos_agent.db import LocalDB


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_db() -> LocalDB:
    """Return a fresh in-memory-backed LocalDB using a temp file."""
    tmp = tempfile.mktemp(suffix=".db")
    return LocalDB(Path(tmp))


def _make_tool_call_response(tool_name: str, args: dict) -> dict:
    return {
        "id": f"call_{uuid.uuid4().hex[:8]}",
        "type": "function",
        "function": {
            "name": tool_name,
            "arguments": json.dumps(args),
        },
    }


def _make_openai_response(tool_calls: list[dict] | None = None, content: str = "") -> Any:
    """Build a minimal mock OpenAI chat completion response."""
    msg = MagicMock()
    msg.content = content
    msg.tool_calls = []
    if tool_calls:
        for tc in tool_calls:
            mock_tc = MagicMock()
            mock_tc.id = tc["id"]
            mock_tc.function.name = tc["function"]["name"]
            mock_tc.function.arguments = tc["function"]["arguments"]
            msg.tool_calls.append(mock_tc)
    choice = MagicMock()
    choice.message = msg
    resp = MagicMock()
    resp.choices = [choice]
    return resp


# ── _emit_cycle_summary unit tests ─────────────────────────────────────────────


def test_emit_cycle_summary_persists_to_db():
    """_emit_cycle_summary writes exactly one row to LocalDB."""
    db = _make_db()
    try:
        _emit_cycle_summary(
            db=db,
            talos_id="test-talos",
            cycle_id="cycle-abc",
            started_at="2026-01-01T00:00:00+00:00",
            duration_ms=123.456,
            tool_names=["get_balance", "post_content"],
            error_type=None,
            error_category=None,
            outcome="completed",
        )
        rows = db.get_recent_cycle_summaries(talos_id="test-talos")
        assert len(rows) == 1
        row = rows[0]
        assert row["cycle_id"] == "cycle-abc"
        assert row["tool_calls"] == 2
        assert row["tool_names"] == ["get_balance", "post_content"]
        assert row["outcome"] == "completed"
        assert row["duration_ms"] == pytest.approx(123.456, abs=0.001)
        assert row["error_type"] is None
    finally:
        db.close()


def test_emit_cycle_summary_error_cycle():
    """Error cycles are persisted with error_type and error_category."""
    db = _make_db()
    try:
        _emit_cycle_summary(
            db=db,
            talos_id="test-talos",
            cycle_id="cycle-err",
            started_at="2026-01-01T00:00:00+00:00",
            duration_ms=50.0,
            tool_names=[],
            error_type="RuntimeError",
            error_category="loop_error",
            outcome="error",
        )
        rows = db.get_recent_cycle_summaries(talos_id="test-talos")
        assert len(rows) == 1
        assert rows[0]["error_type"] == "RuntimeError"
        assert rows[0]["error_category"] == "loop_error"
        assert rows[0]["outcome"] == "error"
    finally:
        db.close()


def test_emit_cycle_summary_no_secrets_in_tool_names():
    """Tool names must never contain raw args or secrets — only identifiers."""
    db = _make_db()
    try:
        # Even if someone accidentally passed secret-looking strings, they are
        # identifiers not args; the real protection is that we ONLY pass
        # fn_name (the function identifier), not args.
        tool_names = ["get_balance", "transfer_xlm"]
        _emit_cycle_summary(
            db=db,
            talos_id="agent-1",
            cycle_id="c1",
            started_at="2026-01-01T00:00:00+00:00",
            duration_ms=10.0,
            tool_names=tool_names,
            error_type=None,
            error_category=None,
            outcome="completed",
        )
        rows = db.get_recent_cycle_summaries(talos_id="agent-1")
        assert rows[0]["tool_names"] == tool_names
        # Confirm no SAAAA... Stellar secret appears
        persisted_names_str = json.dumps(rows[0]["tool_names"])
        assert "SCZANGBA" not in persisted_names_str
        assert "api_key" not in persisted_names_str
    finally:
        db.close()


def test_emit_cycle_summary_with_none_db_does_not_raise():
    """_emit_cycle_summary(db=None) only emits the log — must not raise."""
    _emit_cycle_summary(
        db=None,
        talos_id="no-db",
        cycle_id="x",
        started_at="2026-01-01T00:00:00+00:00",
        duration_ms=1.0,
        tool_names=["some_tool"],
        error_type=None,
        error_category=None,
        outcome="completed",
    )
    # No exception = pass


def test_emit_cycle_summary_emits_structlog_event(capfd):
    """_emit_cycle_summary emits a log event (structlog in test mode)."""
    import structlog

    # Capture structlog events without full pipeline
    with patch.object(structlog.get_logger(__name__), "info", autospec=False):
        # Simply ensure calling it doesn't crash and reaches structlog
        db = _make_db()
        try:
            _emit_cycle_summary(
                db=db,
                talos_id="t",
                cycle_id="c",
                started_at="2026-01-01T00:00:00+00:00",
                duration_ms=5.0,
                tool_names=["a", "b"],
                error_type=None,
                error_category=None,
                outcome="completed",
            )
        finally:
            db.close()


# ── DB migration: cycle_summaries table ─────────────────────────────────────────


def test_cycle_summaries_table_created_by_migration():
    """Migration 13 must create the cycle_summaries table."""
    db = _make_db()
    try:
        # Table must exist — save_cycle_summary would fail otherwise
        db.save_cycle_summary(
            talos_id="t1",
            cycle_id="cid",
            started_at="2026-01-01T00:00:00+00:00",
            ended_at="2026-01-01T00:00:01+00:00",
            duration_ms=1000.0,
            tool_calls=3,
            tool_names=["a", "b", "c"],
            error_type=None,
            error_category=None,
            outcome="completed",
        )
        rows = db.get_recent_cycle_summaries()
        assert len(rows) == 1
        assert rows[0]["tool_names"] == ["a", "b", "c"]
    finally:
        db.close()


def test_prune_old_cycle_summaries():
    """prune_old_cycle_summaries keeps only keep_last rows per talos_id."""
    db = _make_db()
    try:
        for i in range(5):
            db.save_cycle_summary(
                talos_id="agent-x",
                cycle_id=f"c{i}",
                started_at="2026-01-01T00:00:00+00:00",
                ended_at="2026-01-01T00:00:01+00:00",
                duration_ms=float(i * 10),
                tool_calls=0,
                tool_names=[],
                outcome="completed",
            )
        pruned = db.prune_old_cycle_summaries(talos_id="agent-x", keep_last=3)
        assert pruned == 2
        remaining = db.get_recent_cycle_summaries(talos_id="agent-x")
        assert len(remaining) == 3
    finally:
        db.close()


# ── Integration: agent_loop emits exactly one summary per cycle ───────────────


@pytest.mark.asyncio
async def test_agent_loop_emits_exactly_one_summary_per_successful_cycle():
    """agent_loop must save exactly one cycle_summary row after a normal cycle."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.config import Settings

    db = _make_db()
    try:
        settings = Settings(
            talos_api_url="http://test.local",
            talos_api_key="cpk_test",
            talos_id="agent-1",
            openai_api_key="sk-test",
            max_iterations=5,
        )

        # LLM returns: one tool call then done
        tool_call = _make_tool_call_response("get_balance", {"account": "GABC..."})
        first_response = _make_openai_response(tool_calls=[tool_call])
        done_response = _make_openai_response(content="All done.")

        talos_config = {"id": "agent-1"}
        context = AgentContext.from_db(db, talos_config)
        tools = MagicMock()
        tools.openai_schemas.return_value = [{"name": "get_balance"}]
        tools.execute = AsyncMock(return_value={"balance_xlm": 100.0})

        with patch("talos_agent.agent.loop.call_with_retry") as mock_retry:
            mock_retry.side_effect = [first_response, done_response]

            await agent_loop(
                settings=settings,
                tools=tools,
                talos_config=talos_config,
                context=context,
                db=db,
            )

        summaries = db.get_recent_cycle_summaries(talos_id="agent-1")
        assert len(summaries) == 1
        s = summaries[0]
        assert s["tool_calls"] == 1
        assert s["tool_names"] == ["get_balance"]
        assert s["outcome"] == "completed"
        assert s["error_type"] is None
        assert s["duration_ms"] >= 0
    finally:
        db.close()


@pytest.mark.asyncio
async def test_agent_loop_emits_exactly_one_summary_per_error_cycle():
    """Even when the loop raises, exactly one summary with outcome=error is saved."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.config import Settings

    db = _make_db()
    try:
        settings = Settings(
            talos_api_url="http://test.local",
            talos_api_key="cpk_test",
            talos_id="agent-err",
            openai_api_key="sk-test",
            max_iterations=5,
        )

        talos_config = {"id": "agent-err"}
        context = AgentContext.from_db(db, talos_config)
        tools = MagicMock()
        tools.openai_schemas.return_value = []

        with patch("talos_agent.agent.loop.call_with_retry") as mock_retry:
            mock_retry.side_effect = RuntimeError("LLM exploded")

            with pytest.raises(RuntimeError, match="LLM exploded"):
                await agent_loop(
                    settings=settings,
                    tools=tools,
                    talos_config=talos_config,
                    context=context,
                    db=db,
                )

        summaries = db.get_recent_cycle_summaries(talos_id="agent-err")
        assert len(summaries) == 1
        s = summaries[0]
        assert s["outcome"] == "error"
        assert s["error_type"] == "RuntimeError"
        assert s["error_category"] == "loop_error"
    finally:
        db.close()


@pytest.mark.asyncio
async def test_agent_loop_summary_tool_names_contain_no_raw_args():
    """tool_names in the summary must be function identifiers only — no argument values."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.config import Settings

    db = _make_db()
    try:
        settings = Settings(
            talos_api_url="http://test.local",
            talos_api_key="cpk_test",
            talos_id="agent-safe",
            openai_api_key="sk-test",
            max_iterations=5,
        )

        # Tool call with a secret-like arg — the arg must NOT appear in the summary
        secret_arg = "SCZANGBA5RLGSRSGIEASPY53FKNCZMXNXNIQHPKWI27BKYPPJCAAAAA"
        tool_call = _make_tool_call_response(
            "transfer_xlm",
            {"to": "GABC...", "seed": secret_arg},
        )
        first_response = _make_openai_response(tool_calls=[tool_call])
        done_response = _make_openai_response(content="Done.")

        talos_config = {"id": "agent-safe"}
        context = AgentContext.from_db(db, talos_config)
        tools = MagicMock()
        tools.openai_schemas.return_value = [{"name": "transfer_xlm"}]
        tools.execute = AsyncMock(return_value={"status": "submitted"})

        with patch("talos_agent.agent.loop.call_with_retry") as mock_retry:
            mock_retry.side_effect = [first_response, done_response]

            await agent_loop(
                settings=settings,
                tools=tools,
                talos_config=talos_config,
                context=context,
                db=db,
            )

        summaries = db.get_recent_cycle_summaries(talos_id="agent-safe")
        assert len(summaries) == 1
        tool_names = summaries[0]["tool_names"]
        assert tool_names == ["transfer_xlm"]
        # Secret must not appear anywhere in the persisted summary
        raw = json.dumps(summaries[0])
        assert secret_arg not in raw
    finally:
        db.close()
