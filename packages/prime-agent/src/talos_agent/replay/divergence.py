"""Divergence detection between original and replayed agent cycles.

A *divergence* occurs when the LLM makes a different decision during replay
than it made in the original cycle.  We compare:

1. **Tool call sequence** – were the same tools called, in the same order?
2. **Tool call arguments** – were the arguments identical?
3. **Final message content** – did the model produce different reasoning?

The report is deliberately non-fatal: divergences are interesting signals for
incident analysis, not errors that should abort the replay.

Usage::

    original_msgs = [...]  # from recording
    replay_msgs   = [...]  # from run_with_stubs
    report = check_divergence(original_msgs, replay_msgs)
    if report.has_divergence:
        print(report.summary())
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCallDiff:
    """Describes a single diverging tool call."""

    position: int
    original_name: str | None
    replay_name: str | None
    original_args: dict | None
    replay_args: dict | None

    @property
    def is_name_divergence(self) -> bool:
        return self.original_name != self.replay_name

    @property
    def is_args_divergence(self) -> bool:
        return (
            self.original_name == self.replay_name
            and self.original_args != self.replay_args
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "position": self.position,
            "original_name": self.original_name,
            "replay_name": self.replay_name,
            "original_args": self.original_args,
            "replay_args": self.replay_args,
            "type": "name" if self.is_name_divergence else "args",
        }


@dataclass
class DivergenceReport:
    """Full divergence report for one replay run."""

    cycle_id: str
    original_tool_calls: list[dict]
    replay_tool_calls: list[dict]
    diffs: list[ToolCallDiff] = field(default_factory=list)
    original_final_content: str | None = None
    replay_final_content: str | None = None
    extra_original_calls: int = 0
    extra_replay_calls: int = 0

    @property
    def has_divergence(self) -> bool:
        return bool(self.diffs) or self.original_final_content != self.replay_final_content

    @property
    def tool_sequence_diverged(self) -> bool:
        return bool(self.diffs) or self.extra_original_calls > 0 or self.extra_replay_calls > 0

    def summary(self) -> str:
        lines = [f"Divergence report for cycle {self.cycle_id}"]
        if not self.has_divergence:
            lines.append("  ✓ No divergence detected")
            return "\n".join(lines)

        if self.tool_sequence_diverged:
            lines.append(f"  ✗ Tool call divergence: {len(self.diffs)} diff(s)")
            for d in self.diffs:
                lines.append(
                    f"    [{d.position}] {d.original_name!r} → {d.replay_name!r} "
                    f"({'name' if d.is_name_divergence else 'args'})"
                )
            if self.extra_original_calls:
                lines.append(f"    Original had {self.extra_original_calls} extra call(s)")
            if self.extra_replay_calls:
                lines.append(f"    Replay had {self.extra_replay_calls} extra call(s)")

        if self.original_final_content != self.replay_final_content:
            lines.append("  ✗ Final reasoning content diverged")
            if self.original_final_content:
                lines.append(f"    Original: {self.original_final_content[:120]!r}")
            if self.replay_final_content:
                lines.append(f"    Replay:   {self.replay_final_content[:120]!r}")

        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "cycle_id": self.cycle_id,
            "has_divergence": self.has_divergence,
            "tool_sequence_diverged": self.tool_sequence_diverged,
            "diff_count": len(self.diffs),
            "diffs": [d.to_dict() for d in self.diffs],
            "extra_original_calls": self.extra_original_calls,
            "extra_replay_calls": self.extra_replay_calls,
            "original_final_content": self.original_final_content,
            "replay_final_content": self.replay_final_content,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_tool_calls(messages: list[dict]) -> list[dict]:
    """Extract all tool calls from an OpenAI-format message list."""
    calls = []
    for msg in messages:
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}"))
                except (json.JSONDecodeError, TypeError):
                    args = {}
                calls.append({"name": fn.get("name"), "args": args})
    return calls


def _extract_final_content(messages: list[dict]) -> str | None:
    """Return the last assistant message content (if any)."""
    for msg in reversed(messages):
        if msg.get("role") == "assistant" and msg.get("content"):
            return msg["content"]
    return None


# ── Public API ────────────────────────────────────────────────────────────────

def check_divergence(
    cycle_id: str,
    original_messages: list[dict],
    replay_messages: list[dict],
) -> DivergenceReport:
    """Compare tool-call sequences and final reasoning between two runs.

    Parameters
    ----------
    cycle_id:
        The originating cycle identifier (for the report).
    original_messages:
        The ``messages`` list produced by the original ``agent_loop`` run.
    replay_messages:
        The ``messages`` list produced by the replay ``run_with_stubs`` run.

    Returns
    -------
    ``DivergenceReport`` describing all differences found.
    """
    orig_calls = _extract_tool_calls(original_messages)
    replay_calls = _extract_tool_calls(replay_messages)

    diffs: list[ToolCallDiff] = []
    min_len = min(len(orig_calls), len(replay_calls))

    for i in range(min_len):
        o = orig_calls[i]
        r = replay_calls[i]
        if o["name"] != r["name"] or o["args"] != r["args"]:
            diffs.append(
                ToolCallDiff(
                    position=i,
                    original_name=o["name"],
                    replay_name=r["name"],
                    original_args=o["args"],
                    replay_args=r["args"],
                )
            )

    extra_orig = max(0, len(orig_calls) - len(replay_calls))
    extra_replay = max(0, len(replay_calls) - len(orig_calls))

    return DivergenceReport(
        cycle_id=cycle_id,
        original_tool_calls=orig_calls,
        replay_tool_calls=replay_calls,
        diffs=diffs,
        original_final_content=_extract_final_content(original_messages),
        replay_final_content=_extract_final_content(replay_messages),
        extra_original_calls=extra_orig,
        extra_replay_calls=extra_replay,
    )
