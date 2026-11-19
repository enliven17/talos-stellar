"""Unit tests for replay.stubs and replay.divergence."""

from __future__ import annotations

import pytest

from talos_agent.replay.capture import EventCapture
from talos_agent.replay.divergence import (
    ToolCallDiff,
    check_divergence,
)
from talos_agent.replay.stubs import StubExhaustedError, StubRegistry

# ─────────────────────────────────────────────────────────────────────────────
# StubRegistry
# ─────────────────────────────────────────────────────────────────────────────

def _make_events_with_results(*tool_results: tuple[str, dict]):
    """Build a minimal event list containing tool_result events."""
    cap = EventCapture(cycle_id="test")
    for name, result in tool_results:
        cap.record("tool_result", {"tool_name": name, "result": result})
    return cap.events


@pytest.mark.asyncio
async def test_stub_returns_recorded_result():
    events = _make_events_with_results(("post_content", {"ok": True, "post_id": "123"}))
    registry = StubRegistry.from_events(events)
    result = await registry.execute("post_content", {})
    assert result == {"ok": True, "post_id": "123"}


@pytest.mark.asyncio
async def test_stub_returns_in_call_order():
    events = _make_events_with_results(
        ("tool_a", {"n": 1}),
        ("tool_a", {"n": 2}),
        ("tool_a", {"n": 3}),
    )
    registry = StubRegistry.from_events(events)
    assert (await registry.execute("tool_a", {})) == {"n": 1}
    assert (await registry.execute("tool_a", {})) == {"n": 2}
    assert (await registry.execute("tool_a", {})) == {"n": 3}


@pytest.mark.asyncio
async def test_stub_exhausted_raises():
    events = _make_events_with_results(("my_tool", {"x": 1}))
    registry = StubRegistry.from_events(events)
    await registry.execute("my_tool", {})  # consume it
    with pytest.raises(StubExhaustedError, match="my_tool"):
        await registry.execute("my_tool", {})


@pytest.mark.asyncio
async def test_stub_unknown_tool_raises():
    registry = StubRegistry()
    with pytest.raises(StubExhaustedError, match="unknown_tool"):
        await registry.execute("unknown_tool", {})


def test_stub_call_count():
    events = _make_events_with_results(("t", {"v": 1}), ("t", {"v": 2}))
    registry = StubRegistry.from_events(events)
    assert registry.call_count("t") == 0
    assert registry.remaining("t") == 2


@pytest.mark.asyncio
async def test_stub_remaining_after_calls():
    events = _make_events_with_results(("t", {"v": 1}), ("t", {"v": 2}))
    registry = StubRegistry.from_events(events)
    await registry.execute("t", {})
    assert registry.remaining("t") == 1
    assert registry.call_count("t") == 1


def test_stub_registered_tools():
    events = _make_events_with_results(("alpha", {}), ("beta", {}))
    registry = StubRegistry.from_events(events)
    assert set(registry.registered_tools) == {"alpha", "beta"}


def test_stub_all_remaining():
    events = _make_events_with_results(("a", {}), ("b", {}), ("b", {}))
    registry = StubRegistry.from_events(events)
    remaining = registry.all_remaining()
    assert remaining["a"] == 1
    assert remaining["b"] == 2


# ─────────────────────────────────────────────────────────────────────────────
# check_divergence
# ─────────────────────────────────────────────────────────────────────────────

def _msg_with_tool_calls(tool_calls: list[tuple[str, dict]]) -> list[dict]:
    """Build a minimal OpenAI message list with tool calls."""
    import json
    tcs = [
        {
            "id": f"tc_{i}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        }
        for i, (name, args) in enumerate(tool_calls)
    ]
    return [{"role": "assistant", "tool_calls": tcs}]


def _msg_with_content(content: str) -> list[dict]:
    return [{"role": "assistant", "content": content}]


def test_no_divergence_identical():
    msgs_a = _msg_with_tool_calls([("tool_x", {"arg": 1})])
    msgs_b = _msg_with_tool_calls([("tool_x", {"arg": 1})])
    report = check_divergence("c1", msgs_a, msgs_b)
    assert not report.has_divergence
    assert len(report.diffs) == 0


def test_divergence_different_tool_name():
    msgs_a = _msg_with_tool_calls([("tool_x", {})])
    msgs_b = _msg_with_tool_calls([("tool_y", {})])
    report = check_divergence("c2", msgs_a, msgs_b)
    assert report.has_divergence
    assert report.diffs[0].is_name_divergence
    assert report.diffs[0].original_name == "tool_x"
    assert report.diffs[0].replay_name == "tool_y"


def test_divergence_different_args():
    msgs_a = _msg_with_tool_calls([("tool_x", {"n": 1})])
    msgs_b = _msg_with_tool_calls([("tool_x", {"n": 2})])
    report = check_divergence("c3", msgs_a, msgs_b)
    assert report.has_divergence
    assert report.diffs[0].is_args_divergence
    assert report.diffs[0].original_args == {"n": 1}
    assert report.diffs[0].replay_args == {"n": 2}


def test_divergence_extra_original_calls():
    msgs_a = _msg_with_tool_calls([("t", {}), ("t", {})])
    msgs_b = _msg_with_tool_calls([("t", {})])
    report = check_divergence("c4", msgs_a, msgs_b)
    assert report.extra_original_calls == 1
    assert report.tool_sequence_diverged


def test_divergence_extra_replay_calls():
    msgs_a = _msg_with_tool_calls([("t", {})])
    msgs_b = _msg_with_tool_calls([("t", {}), ("t", {})])
    report = check_divergence("c5", msgs_a, msgs_b)
    assert report.extra_replay_calls == 1
    assert report.tool_sequence_diverged


def test_divergence_final_content_differs():
    msgs_a = _msg_with_content("Decision A")
    msgs_b = _msg_with_content("Decision B")
    report = check_divergence("c6", msgs_a, msgs_b)
    assert report.has_divergence
    assert report.original_final_content == "Decision A"
    assert report.replay_final_content == "Decision B"


def test_no_divergence_same_content():
    msgs_a = _msg_with_content("Same decision")
    msgs_b = _msg_with_content("Same decision")
    report = check_divergence("c7", msgs_a, msgs_b)
    assert not report.has_divergence


def test_divergence_report_empty_messages():
    report = check_divergence("c8", [], [])
    assert not report.has_divergence


def test_divergence_summary_no_divergence():
    msgs = _msg_with_tool_calls([("t", {})])
    report = check_divergence("c9", msgs, msgs)
    summary = report.summary()
    assert "✓" in summary


def test_divergence_summary_with_divergence():
    msgs_a = _msg_with_tool_calls([("t_a", {})])
    msgs_b = _msg_with_tool_calls([("t_b", {})])
    report = check_divergence("c10", msgs_a, msgs_b)
    summary = report.summary()
    assert "✗" in summary
    assert "t_a" in summary
    assert "t_b" in summary


def test_divergence_to_dict():
    msgs_a = _msg_with_tool_calls([("x", {"a": 1})])
    msgs_b = _msg_with_tool_calls([("x", {"a": 2})])
    report = check_divergence("c11", msgs_a, msgs_b)
    d = report.to_dict()
    assert d["has_divergence"] is True
    assert d["diff_count"] == 1
    assert d["diffs"][0]["type"] == "args"


def test_tool_call_diff_type_name():
    diff = ToolCallDiff(
        position=0,
        original_name="a",
        replay_name="b",
        original_args={},
        replay_args={},
    )
    assert diff.is_name_divergence
    assert not diff.is_args_divergence


def test_tool_call_diff_type_args():
    diff = ToolCallDiff(
        position=0,
        original_name="a",
        replay_name="a",
        original_args={"x": 1},
        replay_args={"x": 2},
    )
    assert not diff.is_name_divergence
    assert diff.is_args_divergence
