"""Unit tests for replay.capture and replay.store."""

from __future__ import annotations

import json
import sqlite3

import pytest

from talos_agent.replay.capture import (
    CaptureConfig,
    EventCapture,
    ReplayEvent,
)
from talos_agent.replay.redact import REDACTED
from talos_agent.replay.store import ReplayStore

# ─────────────────────────────────────────────────────────────────────────────
# EventCapture
# ─────────────────────────────────────────────────────────────────────────────

def make_capture(*, max_events=500, max_payload_bytes=65536, redact=True):
    cfg = CaptureConfig(
        max_events=max_events,
        max_payload_bytes=max_payload_bytes,
        enabled=True,
        redact_payloads=redact,
    )
    return EventCapture(cycle_id="cycle-test-1", config=cfg)


def test_capture_records_events():
    cap = make_capture()
    cap.record("tool_call", {"tool_name": "post", "args": {}})
    cap.record("tool_result", {"tool_name": "post", "result": {"ok": True}})
    assert len(cap.events) == 2


def test_capture_sequential_seq():
    cap = make_capture()
    for i in range(5):
        cap.record("tool_call", {"i": i})
    seqs = [e.seq for e in cap.events]
    assert seqs == list(range(5))


def test_capture_max_events_limit():
    cap = make_capture(max_events=3)
    for i in range(10):
        cap.record("tool_call", {"i": i})
    assert len(cap.events) == 3
    assert cap.dropped == 7


def test_capture_disabled_returns_none():
    cfg = CaptureConfig(enabled=False)
    cap = EventCapture(cycle_id="x", config=cfg)
    result = cap.record("tool_call", {"a": 1})
    assert result is None
    assert len(cap.events) == 0


def test_capture_redacts_secrets():
    cap = make_capture(redact=True)
    cap.record("tool_call", {"tool_name": "test", "args": {"api_key": "tak_supersecret123"}})
    ev = cap.events[0]
    assert ev.payload["args"]["api_key"] == REDACTED


def test_capture_no_redact_when_disabled():
    cap = make_capture(redact=False)
    cap.record("tool_call", {"tool_name": "test", "args": {"api_key": "tak_supersecret123"}})
    ev = cap.events[0]
    assert ev.payload["args"]["api_key"] == "tak_supersecret123"


def test_capture_payload_size_limit():
    cap = make_capture(max_payload_bytes=50)
    # Large payload that will exceed 50 bytes when JSON-encoded
    large = {"data": "x" * 200}
    cap.record("tool_result", large)
    ev = cap.events[0]
    assert ev.payload.get("__truncated__") is True


def test_capture_stable_json():
    cap = make_capture()
    cap.record("tool_call", {"b": 2, "a": 1})
    ev = cap.events[0]
    raw = ev.stable_json()
    parsed = json.loads(raw)
    # Keys in the top-level envelope should be sorted
    top_keys = list(parsed.keys())
    assert top_keys == sorted(top_keys)


def test_capture_cycle_start_end():
    cap = make_capture()
    cap.record_cycle_start("Vega", "0.1.0")
    cap.record_cycle_end("complete", iterations=3)
    kinds = [e.kind for e in cap.events]
    assert kinds == ["cycle_start", "cycle_end"]


def test_capture_llm_helpers():
    cap = make_capture()
    cap.record_llm_request("llama-3.3", [{"role": "user", "content": "hi"}], [])
    cap.record_llm_response("thinking...", [])
    kinds = [e.kind for e in cap.events]
    assert "llm_request" in kinds
    assert "llm_response" in kinds


def test_capture_tool_helpers():
    cap = make_capture()
    cap.record_tool_call("post_content", {"text": "hello"})
    cap.record_tool_result("post_content", {"ok": True})
    kinds = [e.kind for e in cap.events]
    assert kinds == ["tool_call", "tool_result"]


def test_replay_event_roundtrip():
    cap = make_capture()
    cap.record("tool_call", {"tool_name": "foo"})
    ev = cap.events[0]
    d = ev.to_dict()
    ev2 = ReplayEvent.from_dict(d)
    assert ev2.event_id == ev.event_id
    assert ev2.seq == ev.seq
    assert ev2.kind == ev.kind


# ─────────────────────────────────────────────────────────────────────────────
# ReplayStore
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def store(tmp_path):
    """In-memory SQLite store for testing."""
    conn = sqlite3.connect(str(tmp_path / "test_replay.db"))
    conn.row_factory = sqlite3.Row
    s = ReplayStore(conn)
    yield s
    conn.close()


def _populate_session(store: ReplayStore, cycle_id: str = "cycle-1", talos_id: str = "t1"):
    store.start_session(cycle_id, talos_id=talos_id, agent_version="0.1.0")
    cap = EventCapture(cycle_id=cycle_id)
    cap.record("tool_call", {"tool_name": "test", "args": {}})
    cap.record("tool_result", {"tool_name": "test", "result": {"ok": True}})
    written = store.flush_capture(cap)
    store.end_session(cycle_id, event_count=written)
    return written


def test_store_start_and_end_session(store):
    store.start_session("c1", talos_id="t1", agent_version="0.1.0")
    session = store.get_session("c1")
    assert session is not None
    assert session["status"] == "recording"
    store.end_session("c1", status="complete", event_count=3)
    session = store.get_session("c1")
    assert session["status"] == "complete"
    assert session["event_count"] == 3


def test_store_flush_capture(store):
    store.start_session("c2", talos_id="t1", agent_version="0.1.0")
    written = _populate_session(store, "c2")
    assert written == 2
    events = store.get_events("c2")
    assert len(events) == 2


def test_store_get_events_by_kind(store):
    _populate_session(store, "c3")
    calls = store.get_events("c3", kind="tool_call")
    assert all(e.kind == "tool_call" for e in calls)
    assert len(calls) == 1


def test_store_list_sessions_filter_status(store):
    store.start_session("c4", talos_id="t1", agent_version="0.1.0")
    store.end_session("c4", status="error")
    store.start_session("c5", talos_id="t1", agent_version="0.1.0")
    store.end_session("c5", status="complete")

    errors = store.list_sessions(status="error")
    assert any(s["cycle_id"] == "c4" for s in errors)
    completes = store.list_sessions(status="complete")
    assert any(s["cycle_id"] == "c5" for s in completes)


def test_store_idempotent_start(store):
    store.start_session("c6", talos_id="t1", agent_version="0.1.0")
    # Second call with same cycle_id should not raise
    store.start_session("c6", talos_id="t1", agent_version="0.1.0")
    session = store.get_session("c6")
    assert session is not None


def test_store_idempotent_flush(store):
    store.start_session("c7", talos_id="t1", agent_version="0.1.0")
    cap = EventCapture(cycle_id="c7")
    cap.record("tool_call", {"tool_name": "x"})
    store.flush_capture(cap)
    # Flushing the same events again should not duplicate (INSERT OR IGNORE)
    store.flush_capture(cap)
    events = store.get_events("c7")
    assert len(events) == 1


def test_store_prune_sessions(store):
    for i in range(5):
        _populate_session(store, cycle_id=f"prune-{i}", talos_id="t1")
    deleted = store.prune_sessions(keep_last=3, talos_id="t1")
    assert deleted == 2
    remaining = store.list_sessions(talos_id="t1")
    assert len(remaining) == 3


def test_store_prune_cleans_events(store):
    _populate_session(store, "p1", "t2")
    _populate_session(store, "p2", "t2")
    store.prune_sessions(keep_last=1, talos_id="t2")
    # Events for deleted session should be gone
    # The most recent session should remain with its events intact
    sessions = store.list_sessions(talos_id="t2")
    assert len(sessions) == 1
    events = store.get_events(sessions[0]["cycle_id"])
    assert len(events) == 2


def test_store_get_session_missing_returns_none(store):
    assert store.get_session("does-not-exist") is None


def test_store_events_limit(store):
    store.start_session("lim", talos_id="t1", agent_version="0.1.0")
    cap = EventCapture(cycle_id="lim")
    for i in range(20):
        cap.record("tool_call", {"i": i})
    store.flush_capture(cap)
    events = store.get_events("lim", limit=5)
    assert len(events) == 5
    # Should be first 5 by seq
    assert events[0].seq == 0
    assert events[4].seq == 4
