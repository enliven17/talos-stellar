"""Tests for Issue #235: deterministic execution replay.

Covers:
- ReplayEvent / ReplaySession dataclasses
- redact_payload: sensitive key detection and deep-copy semantics
- serialize_session / deserialize_session: round-trip stability
- ReplayRecorder: event persistence, redaction, session creation
- ReplayRunner.run_with_stubs(): clean replay, divergence detection,
  custom tool overrides, and error handling
- load_session_from_db: DB round-trip integration
- DB migration: replay tables are created automatically
- Security: sensitive keys never stored in plaintext
- Config: replay settings defaults
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from unittest.mock import MagicMock

from talos_agent.replay import (
    ReplayEvent,
    ReplayRecorder,
    ReplayResult,
    ReplayRunner,
    ReplaySession,
    deserialize_session,
    load_session_from_db,
    redact_payload,
    serialize_session,
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_session(event_count: int = 2) -> ReplaySession:
    events = [
        ReplayEvent(
            event_id=str(uuid.uuid4()),
            timestamp="2026-01-01T00:00:00+00:00",
            event_type=f"event_{i}",
            payload={"step": i, "value": f"v{i}"},
        )
        for i in range(event_count)
    ]
    return ReplaySession(
        session_id=str(uuid.uuid4()),
        agent_version="0.1.0",
        talos_id="test-talos",
        started_at="2026-01-01T00:00:00+00:00",
        events=events,
    )


def _make_db(tmp_path: Path):
    from talos_agent.db import LocalDB

    return LocalDB(path=tmp_path / "replay_test.db")


# ── redact_payload ────────────────────────────────────────────────────────────


def test_redact_payload_replaces_sensitive_keys():
    payload = {
        "api_key": "sk-secret-value",
        "token": "bearer-abc",
        "password": "hunter2",
        "private_key": "-----BEGIN EC PRIVATE KEY-----",
        "safe_field": "visible",
        "count": 42,
    }
    result = redact_payload(payload)
    assert result["api_key"] == "[REDACTED]"
    assert result["token"] == "[REDACTED]"
    assert result["password"] == "[REDACTED]"
    assert result["private_key"] == "[REDACTED]"
    assert result["safe_field"] == "visible"
    assert result["count"] == 42


def test_redact_payload_case_insensitive():
    payload = {"API_KEY": "val", "Secret": "val2", "TOKEN": "val3"}
    result = redact_payload(payload)
    assert all(v == "[REDACTED]" for v in result.values())


def test_redact_payload_does_not_modify_original():
    payload = {"api_key": "real_secret", "safe": "ok"}
    result = redact_payload(payload)
    assert payload["api_key"] == "real_secret"
    assert result["api_key"] == "[REDACTED]"


def test_redact_payload_empty_dict():
    assert redact_payload({}) == {}


def test_redact_payload_no_sensitive_keys():
    payload = {"action": "post", "channel": "twitter", "count": 5}
    assert redact_payload(payload) == payload


# ── ReplayEvent / ReplaySession dataclasses ───────────────────────────────────


def test_replay_event_round_trip():
    event = ReplayEvent(
        event_id="abc-123",
        timestamp="2026-01-01T00:00:00+00:00",
        event_type="tool_call",
        payload={"tool": "post_tweet", "text": "Hello"},
        redacted=False,
    )
    assert ReplayEvent.from_dict(event.to_dict()) == event


def test_replay_session_round_trip():
    session = _make_session(3)
    restored = ReplaySession.from_dict(session.to_dict())
    assert restored.session_id == session.session_id
    assert restored.agent_version == session.agent_version
    assert len(restored.events) == 3


# ── Serialisation ─────────────────────────────────────────────────────────────


def test_serialize_session_is_valid_json():
    session = _make_session(2)
    raw = serialize_session(session)
    parsed = json.loads(raw)  # must not raise
    assert parsed["session_id"] == session.session_id


def test_serialize_session_is_stable():
    """Same session serialised twice must produce identical strings."""
    session = _make_session(2)
    assert serialize_session(session) == serialize_session(session)


def test_serialize_deserialize_round_trip():
    session = _make_session(3)
    restored = deserialize_session(serialize_session(session))
    assert restored.session_id == session.session_id
    assert len(restored.events) == 3
    assert restored.events[0].event_type == session.events[0].event_type


def test_serialize_keys_are_sorted():
    """JSON output must have sorted keys for stable diffs."""
    session = _make_session(1)
    raw = serialize_session(session)
    # Top-level keys should appear in alphabetical order.
    parsed = json.loads(raw)
    top_keys = list(parsed.keys())
    assert top_keys == sorted(top_keys)


# ── ReplayRecorder ────────────────────────────────────────────────────────────


def test_recorder_persists_event(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-1", redact=False
    )
    event = recorder.record("agent_cycle_start", {"posts_today": 0})

    assert event.event_type == "agent_cycle_start"
    rows = db.get_replay_events(session_id)
    assert len(rows) == 1
    assert rows[0]["event_type"] == "agent_cycle_start"
    db.close()


def test_recorder_redacts_sensitive_keys(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-1", redact=True
    )
    recorder.record("config_snapshot", {"api_key": "sk-real", "safe": "visible"})

    rows = db.get_replay_events(session_id)
    stored_payload = json.loads(rows[0]["payload"])
    assert stored_payload["api_key"] == "[REDACTED]"
    assert stored_payload["safe"] == "visible"
    assert rows[0]["redacted"] == 1
    db.close()


def test_recorder_no_redaction_when_disabled(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-1", redact=False
    )
    recorder.record("config_snapshot", {"api_key": "sk-real"})

    rows = db.get_replay_events(session_id)
    stored_payload = json.loads(rows[0]["payload"])
    assert stored_payload["api_key"] == "sk-real"
    db.close()


def test_recorder_creates_session_lazily(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-x", redact=False
    )

    # No session should exist yet.
    sessions_before = db.list_replay_sessions()
    assert not any(s["session_id"] == session_id for s in sessions_before)

    recorder.record("first_event", {})

    sessions_after = db.list_replay_sessions()
    assert any(s["session_id"] == session_id for s in sessions_after)
    db.close()


def test_recorder_get_events_round_trip(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-1", redact=False
    )
    recorder.record("step_a", {"x": 1})
    recorder.record("step_b", {"y": 2})

    events = recorder.get_events(session_id)
    assert len(events) == 2
    assert events[0].event_type == "step_a"
    assert events[1].event_type == "step_b"
    db.close()


def test_recorder_tolerates_db_error():
    """ReplayRecorder must not crash if the DB raises on insert."""
    bad_db = MagicMock()
    bad_db.create_replay_session = MagicMock()
    bad_db.insert_replay_event = MagicMock(side_effect=RuntimeError("disk full"))
    recorder = ReplayRecorder(session_id="s1", db=bad_db, talos_id="t1")
    # Should not raise.
    event = recorder.record("test_event", {"data": 1})
    assert event.event_type == "test_event"


# ── ReplayRunner ──────────────────────────────────────────────────────────────


def test_runner_clean_replay_no_divergence():
    session = _make_session(3)
    runner = ReplayRunner(session)
    result = runner.run_with_stubs()

    assert isinstance(result, ReplayResult)
    assert not result.diverged
    assert result.divergence_report == []
    assert len(result.replayed_events) == 3


def test_runner_detects_missing_payload_key():
    """Override a stub to drop a key — runner must report divergence."""
    session = _make_session(1)
    session.events[0].payload = {"step": 0, "value": "v0"}

    def bad_stub(payload):
        return {"step": 0}  # missing "value"

    runner = ReplayRunner(session)
    result = runner.run_with_stubs(tool_fn_override={"event_0": bad_stub})

    assert result.diverged
    assert any("missing keys" in r for r in result.divergence_report)


def test_runner_detects_extra_payload_key():
    """Override a stub to add a key — runner must report divergence."""
    session = _make_session(1)
    session.events[0].payload = {"step": 0}

    def extra_key_stub(payload):
        return {"step": 0, "unexpected": True}

    runner = ReplayRunner(session)
    result = runner.run_with_stubs(tool_fn_override={"event_0": extra_key_stub})

    assert result.diverged
    assert any("extra keys" in r for r in result.divergence_report)


def test_runner_custom_stub_replaces_payload():
    session = _make_session(1)
    session.events[0].event_type = "my_tool"
    session.events[0].payload = {"result": "original"}

    called_with = []

    def stub(payload):
        called_with.append(payload)
        return {"result": "replayed"}

    runner = ReplayRunner(session)
    result = runner.run_with_stubs(tool_fn_override={"my_tool": stub})

    assert called_with == [{"result": "original"}]
    assert result.replayed_events[0].payload["result"] == "replayed"
    assert not result.diverged


def test_runner_stub_exception_reports_divergence():
    session = _make_session(1)
    session.events[0].event_type = "failing_tool"

    def broken_stub(payload):
        raise ValueError("intentional failure")

    runner = ReplayRunner(session)
    result = runner.run_with_stubs(tool_fn_override={"failing_tool": broken_stub})

    assert result.diverged
    assert any("ValueError" in r for r in result.divergence_report)


def test_runner_empty_session_is_clean():
    session = ReplaySession(
        session_id="empty",
        agent_version="0.1.0",
        talos_id="t",
        started_at="2026-01-01T00:00:00+00:00",
        events=[],
    )
    result = ReplayRunner(session).run_with_stubs()
    assert not result.diverged
    assert result.replayed_events == []


# ── load_session_from_db integration ─────────────────────────────────────────


def test_load_session_from_db_returns_none_for_unknown(tmp_path):
    db = _make_db(tmp_path)
    result = load_session_from_db("nonexistent-id", db)
    assert result is None
    db.close()


def test_load_session_from_db_full_round_trip(tmp_path):
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())

    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="talos-rt", redact=False
    )
    recorder.record("event_a", {"x": 1})
    recorder.record("event_b", {"y": 2})
    db.finish_replay_session(session_id, status="completed")

    loaded = load_session_from_db(session_id, db)
    assert loaded is not None
    assert loaded.session_id == session_id
    assert loaded.talos_id == "talos-rt"
    assert len(loaded.events) == 2
    assert loaded.events[0].event_type == "event_a"
    db.close()


# ── DB schema ─────────────────────────────────────────────────────────────────


def test_replay_tables_created_by_migration(tmp_path):
    from talos_agent.db import LocalDB

    db = LocalDB(path=tmp_path / "schema_test.db")
    # Tables should exist without error.
    db.create_replay_session("s1", "talos-1", "0.1.0", "2026-01-01T00:00:00+00:00")
    db.insert_replay_event("s1", "e1", "test", "{}", False)
    rows = db.get_replay_events("s1")
    assert len(rows) == 1
    db.close()


def test_list_replay_sessions_filter_by_talos_id(tmp_path):
    db = _make_db(tmp_path)

    for tid in ("talos-A", "talos-B", "talos-A"):
        sid = str(uuid.uuid4())
        db.create_replay_session(sid, tid, "0.1.0", "2026-01-01T00:00:00+00:00")

    a_sessions = db.list_replay_sessions(talos_id="talos-A")
    b_sessions = db.list_replay_sessions(talos_id="talos-B")
    assert len(a_sessions) == 2
    assert len(b_sessions) == 1
    db.close()


# ── Config defaults ───────────────────────────────────────────────────────────


def test_replay_disabled_by_default():
    from talos_agent.config import Settings

    s = Settings(talos_api_key="test", openai_api_key="sk-test")
    assert s.replay_enabled is False


def test_replay_redact_payloads_default_true():
    from talos_agent.config import Settings

    s = Settings(talos_api_key="test", openai_api_key="sk-test")
    assert s.replay_redact_payloads is True


# ── Security: sensitive data never stored in plaintext ────────────────────────


def test_sensitive_data_not_in_db_payload(tmp_path):
    """End-to-end: record an event with a secret, verify DB has [REDACTED]."""
    db = _make_db(tmp_path)
    session_id = str(uuid.uuid4())
    recorder = ReplayRecorder(
        session_id=session_id, db=db, talos_id="t", redact=True
    )
    recorder.record("auth_event", {"api_key": "sk-supersecret-1234", "action": "login"})

    rows = db.get_replay_events(session_id)
    raw_payload = rows[0]["payload"]
    assert "sk-supersecret-1234" not in raw_payload
    assert "[REDACTED]" in raw_payload
    db.close()
