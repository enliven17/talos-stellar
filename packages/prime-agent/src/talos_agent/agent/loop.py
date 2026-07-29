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
from typing import TYPE_CHECKING, Any

from openai import AsyncOpenAI
from rich.console import Console

from talos_agent.agent.context import AgentContext
from talos_agent.agent.prompt import build_system_prompt
from talos_agent.http import call_with_retry
from talos_agent.routing import (
    FallbackChain,
    ProviderRegistry,
    RoutingConstraints,
    RoutingPolicy,
    UsageTracker,
    _build_default_registry,
)
from talos_agent.routing.provider import TaskType

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB
    from talos_agent.tools.registry import ToolRegistry

console = Console()

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


async def agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    db: LocalDB,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
) -> list[dict]:
    """Run one agent cycle: LLM decides tools to call until done.

    When ``settings.model_routing_enabled`` is True, the loop uses the
    policy-driven routing system.  Otherwise it falls back to the legacy
    Groq-first / OpenAI-fallback behaviour.
    """
    if settings.model_routing_enabled:
        return await _routed_agent_loop(
            settings, tools, talos_config, context,
            system_prompt_override, shutdown_event,
        )
    return await _legacy_agent_loop(
        settings, tools, talos_config, context,
        system_prompt_override, shutdown_event,
    )


# ── Legacy loop (backward compatible) ─────────────────────────────────────────


async def _legacy_agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
) -> list[dict]:
    """Original agent loop — Groq preferred, OpenAI fallback."""
    client = get_openai_client(settings.llm_api_key, settings.llm_base_url)

    system_prompt = system_prompt_override or build_system_prompt(talos_config, context)
    tool_schemas = tools.openai_schemas()

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Decide and execute your next actions based on the current context."},
    ]

    for iteration in range(settings.max_iterations):
        if shutdown_event and shutdown_event.is_set():
            console.print("[yellow]Shutdown requested — aborting agent loop.[/yellow]")
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

            result = await tools.execute(fn_name, args)
            result_str = json.dumps(result, default=str, ensure_ascii=False)

            console.print(f"[dim]Result:[/dim] {result_str[:200]}")

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result_str,
            })
    else:
        console.print("[yellow]Agent hit max iterations limit.[/yellow]")

    return messages


# ── Routed loop (new) ─────────────────────────────────────────────────────────


async def _routed_agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
) -> list[dict]:
    """Agent loop with policy-driven model routing and fallback."""
    # Initialise routing infrastructure
    registry = _build_default_registry(settings)
    policy = RoutingPolicy(registry)
    usage_tracker = UsageTracker(registry) if settings.routing_budget_enabled else None

    system_prompt = system_prompt_override or build_system_prompt(talos_config, context)
    tool_schemas = tools.openai_schemas()
    has_tools = bool(tool_schemas)

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Decide and execute your next actions based on the current context."},
    ]

    for iteration in range(settings.max_iterations):
        if shutdown_event and shutdown_event.is_set():
            console.print("[yellow]Shutdown requested — aborting agent loop.[/yellow]")
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

        provider = registry.get(decision.provider_name)

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

            result = await tools.execute(fn_name, args)
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

    return messages


def _truncate_args(args: dict) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 50:
            s = s[:47] + "..."
        parts.append(f"{k}={s!r}")
    return ", ".join(parts)
