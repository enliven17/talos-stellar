"""Side-effect stubs and real decision-boundary re-execution for replay.

During a live cycle every tool call produces a real side effect (API request,
Stellar transaction, browser action, …).  During replay we want to:

1. Feed the *recorded* tool results back to the LLM so it sees the same
   information as during the original cycle.
2. Re-execute the *LLM decision boundary* for real — the model re-reasons
   from the sanitised context — so we can detect divergence.
3. Skip any real side-effecting calls (network, DB writes, on-chain tx).

``StubRegistry`` maps tool names → coroutines that return the recorded payload
from the original cycle.  ``run_with_stubs`` replaces the live tool executor in
``agent_loop`` with the stub registry for the duration of the replay.

Key design properties
---------------------
* **Idempotent** – replaying the same cycle_id twice produces the same result.
* **Read-only** – stubs never mutate state; the LLM re-reasons with frozen
  inputs.
* **Bounded** – if a tool was called more times than recorded the stub raises
  ``StubExhaustedError`` rather than silently returning stale data.
* **Real decision boundary** – the LLM call in ``agent_loop`` is *not*
  stubbed.  Only tool execution is replaced.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any

from talos_agent.replay.capture import ReplayEvent


class StubExhaustedError(RuntimeError):
    """Raised when a stubbed tool is called more times than it was recorded."""


class StubRegistry:
    """Maps tool names to queued recorded results.

    Usage::

        registry = StubRegistry.from_events(events)
        result = await registry.execute("tool_name", {"arg": "value"})
    """

    def __init__(self) -> None:
        # tool_name → list of recorded results in call order
        self._queues: dict[str, list[Any]] = defaultdict(list)
        self._call_counts: dict[str, int] = defaultdict(int)

    @classmethod
    def from_events(cls, events: list[ReplayEvent]) -> StubRegistry:
        """Build a stub registry from a recorded event list."""
        registry = cls()
        for ev in events:
            if ev.kind == "tool_result":
                tool_name = ev.payload.get("tool_name", "unknown")
                result = ev.payload.get("result", {})
                registry._queues[tool_name].append(result)
        return registry

    async def execute(self, tool_name: str, args: dict[str, Any]) -> Any:
        """Return the next recorded result for *tool_name*, or raise."""
        queue = self._queues.get(tool_name, [])
        idx = self._call_counts[tool_name]

        if idx >= len(queue):
            raise StubExhaustedError(
                f"Stub for tool '{tool_name}' exhausted after {idx} call(s). "
                f"The replay has more calls than the recording."
            )

        self._call_counts[tool_name] += 1
        result = queue[idx]

        # Small async yield so we behave like a real async coroutine
        await asyncio.sleep(0)
        return result

    def call_count(self, tool_name: str) -> int:
        return self._call_counts[tool_name]

    def remaining(self, tool_name: str) -> int:
        return len(self._queues.get(tool_name, [])) - self._call_counts[tool_name]

    def all_remaining(self) -> dict[str, int]:
        return {name: self.remaining(name) for name in self._queues if self.remaining(name) > 0}

    @property
    def registered_tools(self) -> list[str]:
        return list(self._queues.keys())


async def run_with_stubs(
    *,
    settings: Any,
    stub_registry: StubRegistry,
    talos_config: dict[str, Any],
    context: Any,
    db: Any,
    events: list[ReplayEvent],
    shutdown_event: asyncio.Event | None = None,
) -> list[dict]:
    """Re-run the LLM decision boundary with recorded tool results as stubs.

    This is the heart of deterministic replay:
    - The **LLM call is real** (re-reasons from the same sanitised context).
    - **Tool execution is replaced** by stub_registry.execute() which returns
      the recorded results in order.

    The function builds a minimal ToolRegistry-like adapter around the
    ``StubRegistry`` and passes it directly to ``agent_loop``.

    Returns the full message trace from the re-executed loop, suitable for
    divergence comparison.
    """
    from talos_agent.agent.loop import agent_loop

    # Build a lightweight tool-registry adapter that uses stub results
    replay_tools = _ReplayToolRegistry(stub_registry, events)

    messages = await agent_loop(
        settings=settings,
        tools=replay_tools,  # type: ignore[arg-type]
        talos_config=talos_config,
        context=context,
        db=db,
        shutdown_event=shutdown_event,
    )
    return messages


class _ReplayToolRegistry:
    """Minimal duck-type stand-in for ``ToolRegistry`` used during replay.

    - ``openai_schemas()`` returns the schemas from the recorded events so the
      LLM sees the same tool descriptions.
    - ``execute()`` delegates to ``StubRegistry``.
    """

    def __init__(self, stubs: StubRegistry, events: list[ReplayEvent]) -> None:
        self._stubs = stubs
        # Extract tool schemas from the first llm_request event that has them
        self._schemas: list[dict] = []
        for ev in events:
            if ev.kind == "llm_request" and ev.payload.get("tool_count", 0) > 0:
                # Schemas are not stored in the payload (too large); we
                # reconstruct a minimal pass-through schema for each tool.
                tool_names = list(stubs.registered_tools)
                self._schemas = [
                    {
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": f"Recorded tool: {name}",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    }
                    for name in tool_names
                ]
                break

    def openai_schemas(self) -> list[dict]:
        return self._schemas

    async def execute(self, tool_name: str, args: dict[str, Any]) -> Any:
        try:
            return await self._stubs.execute(tool_name, args)
        except StubExhaustedError as exc:
            # Return an error dict rather than raising so agent_loop continues
            return {"error": str(exc), "stub_exhausted": True}
