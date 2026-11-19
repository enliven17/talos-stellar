"""Core agent loop — ReAct tool-calling with policy-driven model routing.

When ``model_routing_enabled`` is **False** (the default), the loop behaves
exactly as before: it selects Groq if a Groq API key is configured, otherwise
falls back to OpenAI.

When ``model_routing_enabled`` is **True**, the loop uses the new routing
infrastructure:

* :class:`~talos_agent.routing.ProviderRegistry` holds all configured
  providers (Groq, OpenAI, etc.).
* :class:`~talos_agent.routing.RoutingPolicy` selects the best provider
  based on task type, cost, latency, privacy, and availability.
* :class:`~talos_agent.routing.FallbackChain` tries alternative providers
  when the primary fails.
* :class:`~talos_agent.routing.UsageTracker` records token/cost data for
  accounting and budget enforcement.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import structlog
from openai import AsyncOpenAI
from rich.console import Console

from talos_agent.agent.context import AgentContext
from talos_agent.agent.prompt import build_system_prompt
from talos_agent.http import call_with_retry
from talos_agent.routing import (
    FallbackChain,
    RoutingConstraints,
    RoutingPolicy,
    UsageTracker,
    _build_default_registry,
)
from talos_agent.routing.provider import TaskType

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB
    from talos_agent.replay.capture import EventCapture
    from talos_agent.tools.registry import ToolRegistry

console = Console()
log = structlog.get_logger(__name__)

# Cache clients by credential scope so concurrent agents in the same process do
# not share the first agent's API key.
_openai_clients: dict[tuple[str, str | None], AsyncOpenAI] = {}


def get_openai_client(api_key: str, base_url: str | None = None) -> AsyncOpenAI:
    normalized_base_url = base_url or None
    cache_key = (api_key, normalized_base_url)
    client = _openai_clients.get(cache_key)
    if client is None:
        kwargs: dict = {"api_key": api_key}
        if normalized_base_url:
            kwargs["base_url"] = normalized_base_url
        client = AsyncOpenAI(**kwargs)
        _openai_clients[cache_key] = client
    return client


# Tool execution deadline configuration.
DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 120.0

_TOOL_TIMEOUT_METRICS = {"count": 0, "total_duration": 0.0}


def _get_tool_timeout(settings: Settings) -> float:
    """Resolve the per-tool execution timeout from settings.

    Invalid or missing values fall back to the safe default, and the timeout
    never exceeds the safe upper bound.
    """
    raw_timeout = getattr(settings, "tool_timeout_seconds", DEFAULT_TOOL_TIMEOUT_SECONDS)
    try:
        timeout = float(raw_timeout)
    except (TypeError, ValueError):
        return DEFAULT_TOOL_TIMEOUT_SECONDS

    if isinstance(raw_timeout, bool):
        return DEFAULT_TOOL_TIMEOUT_SECONDS

    if not math.isfinite(timeout) or timeout <= 0:
        return DEFAULT_TOOL_TIMEOUT_SECONDS

    return min(timeout, MAX_TOOL_TIMEOUT_SECONDS)


def _record_tool_timeout(timeout_seconds: float, elapsed_seconds: float) -> None:
    _TOOL_TIMEOUT_METRICS["count"] += 1
    _TOOL_TIMEOUT_METRICS["total_duration"] += elapsed_seconds
    console.print(
        f"[red]Tool timed out after {timeout_seconds:.1f}s "
        f"(cumulative timeouts: {_TOOL_TIMEOUT_METRICS['count']}).[/red]"
    )


async def _cleanup_browser_on_cancellation() -> None:
    """Best-effort browser session teardown when a tool/agent cycle is cancelled."""
    try:
        from talos_agent.tools import browser as browser_mod

        cleanup = getattr(browser_mod, "cleanup_browser_sessions_on_cancellation", None)
        if cleanup is None:
            return
        await cleanup()
    except Exception as exc:
        # Never let cleanup failure mask CancelledError; keep the message privacy-safe.
        console.print(
            f"[yellow]Browser cleanup after cancellation failed "
            f"({type(exc).__name__}).[/yellow]"
        )


async def _execute_tool_with_timeout(
    settings: Settings,
    tools: ToolRegistry,
    fn_name: str,
    args: dict[str, Any],
) -> Any:
    """Run ``tools.execute`` with a bounded deadline and cancellation."""
    timeout = _get_tool_timeout(settings)
    started = time.monotonic()
    task = asyncio.ensure_future(tools.execute(fn_name, args))
    try:
        done, _ = await asyncio.wait({task}, timeout=timeout)
    except asyncio.CancelledError:
        task.cancel()
        await asyncio.sleep(0)
        # Cancelled mid-tool (shutdown / deadline): drop any live browser session
        # so Stagehand/Chrome cannot outlive the cancelled work.
        await _cleanup_browser_on_cancellation()
        raise
    if task in done:
        return task.result()
    task.cancel()
    # Do not block on cancellation: a non-cooperative tool must not extend
    # the deadline.  The task is left to be reclaimed by the event loop.
    await asyncio.sleep(0)
    elapsed = time.monotonic() - started
    _record_tool_timeout(timeout, elapsed)
    return {
        "status": "timeout",
        "tool": fn_name,
        "timeout_seconds": timeout,
        "elapsed_seconds": round(elapsed, 3),
        "error": f"Tool execution timed out after {timeout:.1f}s",
    }


async def agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    db: LocalDB,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
    capture: EventCapture | None = None,
) -> list[dict]:
    """Run one agent cycle: LLM decides tools to call until done.

    When ``settings.model_routing_enabled`` is True, the loop uses the
    policy-driven routing system.  Otherwise it falls back to the legacy
    Groq-first / OpenAI-fallback behaviour.
    """
    if settings.model_routing_enabled:
        return await _routed_agent_loop(
            settings, tools, talos_config, context,
            system_prompt_override, shutdown_event, db,
        )
    return await _legacy_agent_loop(
        settings, tools, talos_config, context,
        system_prompt_override, shutdown_event, db,
    )


# ── Legacy loop (backward compatible) ─────────────────────────────────────────


async def _legacy_agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
    db: LocalDB | None = None,
) -> list[dict]:
    """Original agent loop — Groq preferred, OpenAI fallback."""
    client = get_openai_client(settings.llm_api_key, settings.llm_base_url)

    system_prompt = system_prompt_override or build_system_prompt(talos_config, context, settings)
    tool_schemas = tools.openai_schemas()

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Decide and execute your next actions based on the current context."},
    ]

    # ── Cycle-summary bookkeeping ─────────────────────────
    cycle_id = str(uuid.uuid4())
    cycle_started_at = datetime.now(timezone.utc).isoformat()
    _cycle_start_mono = time.monotonic()
    _cycle_tool_names: list[str] = []
    _cycle_error_type: str | None = None
    _cycle_error_category: str | None = None
    _cycle_outcome = "completed"
    _talos_id: str = talos_config.get("talosId") or talos_config.get("id") or ""

    try:
        for iteration in range(settings.max_iterations):
            if shutdown_event and shutdown_event.is_set():
                console.print("[yellow]Shutdown requested — aborting agent loop.[/yellow]")
                await _cleanup_browser_on_cancellation()
                _cycle_outcome = "shutdown"
                break

            console.print(f"[dim]Agent iteration {iteration + 1}...[/dim]")

            _llm_provider = "groq" if settings.groq_api_key else "openai"
            response = await call_with_retry(
                lambda: client.chat.completions.create(
                    model=settings.llm_model,
                    messages=messages,
                    tools=tool_schemas if tool_schemas else None,
                    tool_choice="auto" if tool_schemas else None,
                ),
                provider=_llm_provider,
            )

            msg = response.choices[0].message

            # Append assistant message
            assistant_msg: dict = {"role": "assistant"}
            if msg.content:
                assistant_msg["content"] = msg.content
                console.print(f"[blue]Agent:[/blue] {msg.content[:200]}")
            if msg.tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ]
            messages.append(assistant_msg)

            # No tool calls → agent is done
            if not msg.tool_calls:
                console.print("[green]Agent cycle complete — no more actions.[/green]")
                break

            # Execute each tool call
            for tc in msg.tool_calls:
                fn_name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                console.print(f"[yellow]Tool:[/yellow] {fn_name}({_truncate_args(args)})")
                _cycle_tool_names.append(fn_name)

                result = await _execute_tool_with_timeout(settings, tools, fn_name, args)
                result_str = json.dumps(result, default=str, ensure_ascii=False)

                console.print(f"[dim]Result:[/dim] {result_str[:200]}")

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_str,
                })
        else:
            console.print("[yellow]Agent hit max iterations limit.[/yellow]")
            _cycle_outcome = "max_iterations"

    except Exception as exc:
        _cycle_error_type = type(exc).__name__
        _cycle_error_category = "loop_error"
        _cycle_outcome = "error"
        raise
    finally:
        _emit_cycle_summary(
            db=db,
            talos_id=_talos_id,
            cycle_id=cycle_id,
            started_at=cycle_started_at,
            duration_ms=(time.monotonic() - _cycle_start_mono) * 1000,
            tool_names=_cycle_tool_names,
            error_type=_cycle_error_type,
            error_category=_cycle_error_category,
            outcome=_cycle_outcome,
        )

    return messages


# ── Routed loop (new) ─────────────────────────────────────────────────────────


async def _routed_agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
    db: LocalDB | None = None,
) -> list[dict]:
    """Agent loop with policy-driven model routing and fallback."""
    # Initialise routing infrastructure
    registry = _build_default_registry(settings)
    policy = RoutingPolicy(registry)
    usage_tracker = UsageTracker(registry) if settings.routing_budget_enabled else None

    system_prompt = system_prompt_override or build_system_prompt(talos_config, context, settings)
    tool_schemas = tools.openai_schemas()
    has_tools = bool(tool_schemas)

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Decide and execute your next actions based on the current context."},
    ]

    # ── Cycle-summary bookkeeping ─────────────────────────
    cycle_id = str(uuid.uuid4())
    cycle_started_at = datetime.now(timezone.utc).isoformat()
    _cycle_start_mono = time.monotonic()
    _cycle_tool_names: list[str] = []
    _cycle_error_type: str | None = None
    _cycle_error_category: str | None = None
    _cycle_outcome = "completed"
    _talos_id: str = talos_config.get("talosId") or talos_config.get("id") or ""

    try:
        for iteration in range(settings.max_iterations):
            if shutdown_event and shutdown_event.is_set():
                console.print("[yellow]Shutdown requested — aborting agent loop.[/yellow]")
                await _cleanup_browser_on_cancellation()
                _cycle_outcome = "shutdown"
                break

            console.print(f"[dim]Agent iteration {iteration + 1}...[/dim]")

            # Determine task type based on whether tools are available
            task_type = TaskType.CHAT
            if has_tools:
                task_type = TaskType.REASONING

            # Build routing constraints
            constraints = RoutingConstraints(
                task_type=task_type,
                max_cost_usd=settings.routing_max_cost_usd if settings.routing_max_cost_usd > 0 else None,
                preferred_provider=settings.routing_preferred_provider or None,
                require_capabilities={"tool_calling"} if has_tools else set(),
                bypass_fallback=not settings.routing_fallback_enabled,
            )

            # Select provider
            decision = policy.select(constraints)
            console.print(
                f"[dim]Router: {decision.provider_name}/{decision.model} "
                f"(score={decision.score:.2f})[/dim]"
            )

            # Define the completion operation for fallback
            async def _complete(
                provider_name: str,
                local_messages: list[dict],
                local_tools: list[dict] | None,
            ) -> dict[str, Any]:
                p = registry.get(provider_name)
                return await p.complete(
                    model=decision.model if provider_name == decision.provider_name else p.metadata.default_model,
                    messages=local_messages,
                    tools=local_tools if local_tools else None,
                )

            # Execute with optional fallback
            if settings.routing_fallback_enabled and not constraints.bypass_fallback:
                # Build fallback chain: primary first, then other healthy providers
                healthy = registry.get_healthy()
                fallback_order = [decision.provider_name] + [
                    n for n in healthy if n != decision.provider_name
                ]
                chain = FallbackChain(fallback_order)
                fb_result = await chain.execute(
                    _complete,
                    messages,
                    tool_schemas if has_tools else None,
                )

                if not fb_result.success:
                    console.print("[red]All providers failed — aborting agent cycle.[/red]")
                    _cycle_outcome = "provider_failure"
                    break

                response_data = fb_result.result
                used_provider = fb_result.provider_name
            else:
                # No fallback — single provider
                try:
                    response_data = await _complete(
                        decision.provider_name, messages, tool_schemas if has_tools else None,
                    )
                    used_provider = decision.provider_name
                except Exception as exc:
                    console.print(f"[red]Provider '{decision.provider_name}' failed: {exc}[/red]")
                    _cycle_outcome = "provider_failure"
                    break

            # Track usage
            if usage_tracker is not None:
                usage = response_data.get("usage", {})
                await usage_tracker.record(
                    provider_name=used_provider,
                    model=response_data.get("model", decision.model),
                    prompt_tokens=usage.get("prompt_tokens", 0),
                    completion_tokens=usage.get("completion_tokens", 0),
                    success=True,
                )

            # Extract message from normalised response
            choices = response_data.get("choices", [])
            if not choices:
                console.print("[red]Empty response from provider — aborting.[/red]")
                _cycle_outcome = "provider_failure"
                break

            choice = choices[0]
            message_data = choice.get("message", {})
            msg_content = message_data.get("content", "")
            msg_tool_calls = message_data.get("tool_calls")

            # Append assistant message
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if msg_content:
                assistant_msg["content"] = msg_content
                console.print(f"[blue]Agent ({used_provider}):[/blue] {msg_content[:200]}")
            if msg_tool_calls:
                assistant_msg["tool_calls"] = msg_tool_calls
            messages.append(assistant_msg)

            # No tool calls → agent is done
            if not msg_tool_calls:
                console.print("[green]Agent cycle complete — no more actions.[/green]")
                break

            # Execute each tool call
            for tc in msg_tool_calls:
                fn_name = tc["function"]["name"] if isinstance(tc, dict) else tc.function.name
                try:
                    raw_args = tc["function"]["arguments"] if isinstance(tc, dict) else tc.function.arguments
                    args = json.loads(raw_args)
                except (json.JSONDecodeError, KeyError):
                    args = {}

                console.print(f"[yellow]Tool:[/yellow] {fn_name}({_truncate_args(args)})")
                _cycle_tool_names.append(fn_name)

                result = await _execute_tool_with_timeout(settings, tools, fn_name, args)
                result_str = json.dumps(result, default=str, ensure_ascii=False)

                console.print(f"[dim]Result:[/dim] {result_str[:200]}")

                tc_id = tc["id"] if isinstance(tc, dict) else tc.id
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result_str,
                })
        else:
            console.print("[yellow]Agent hit max iterations limit.[/yellow]")
            _cycle_outcome = "max_iterations"

    except Exception as exc:
        _cycle_error_type = type(exc).__name__
        _cycle_error_category = "loop_error"
        _cycle_outcome = "error"
        raise
    finally:
        _emit_cycle_summary(
            db=db,
            talos_id=_talos_id,
            cycle_id=cycle_id,
            started_at=cycle_started_at,
            duration_ms=(time.monotonic() - _cycle_start_mono) * 1000,
            tool_names=_cycle_tool_names,
            error_type=_cycle_error_type,
            error_category=_cycle_error_category,
            outcome=_cycle_outcome,
        )

    return messages


def _truncate_args(args: dict) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 50:
            s = s[:47] + "..."
        parts.append(f"{k}={s!r}")
    return ", ".join(parts)


# ── Cycle summary (#1002) ──────────────────────────────────────────────────────

#: How many cycle summary rows to keep per agent in LocalDB.
CYCLE_SUMMARY_KEEP_LAST: int = 200


def _emit_cycle_summary(
    *,
    db: LocalDB | None,
    talos_id: str,
    cycle_id: str,
    started_at: str,
    duration_ms: float,
    tool_names: list[str],
    error_type: str | None,
    error_category: str | None,
    outcome: str,
) -> None:
    """Emit exactly one structured log event and persist to LocalDB.

    Tool names are already safe (identifiers only, no arguments).  The
    structlog pipeline automatically passes every field through
    ``redact_event_dict`` before serialisation, satisfying LOGGING_POLICY.md.

    This function must be called exactly once per cycle — both success and
    failure paths must reach it.
    """
    ended_at = datetime.now(timezone.utc).isoformat()
    tool_calls = len(tool_names)

    # Emit the single structured summary log event.
    log.info(
        "cycle_summary",
        talos_id=talos_id,
        cycle_id=cycle_id,
        started_at=started_at,
        ended_at=ended_at,
        duration_ms=round(duration_ms, 3),
        tool_calls=tool_calls,
        # tool_names are plain identifiers — safe per LOGGING_POLICY.md
        tool_names=tool_names,
        error_type=error_type,
        error_category=error_category,
        outcome=outcome,
    )

    # Persist to LocalDB (best-effort — log failures without re-raising).
    if db is None:
        return
    try:
        db.save_cycle_summary(
            talos_id=talos_id,
            cycle_id=cycle_id,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=round(duration_ms, 3),
            tool_calls=tool_calls,
            tool_names=tool_names,
            error_type=error_type,
            error_category=error_category,
            outcome=outcome,
        )
        db.prune_old_cycle_summaries(
            talos_id=talos_id or None,
            keep_last=CYCLE_SUMMARY_KEEP_LAST,
        )
    except Exception as exc:  # pragma: no cover
        log.warning(
            "cycle_summary_persist_failed",
            error_type=type(exc).__name__,
            error_category="db_write",
        )
