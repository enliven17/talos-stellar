"""Core agent loop — ReAct tool-calling with OpenAI native function calling."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from openai import AsyncOpenAI
from rich.console import Console

from talos_agent.agent.context import AgentContext
from talos_agent.agent.prompt import build_system_prompt

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB
    from talos_agent.tools.registry import ToolRegistry

console = Console()

# Module-level singleton — reused across all agent cycles
_openai_client: AsyncOpenAI | None = None


def get_openai_client(api_key: str, base_url: str | None = None) -> AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        kwargs: dict = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        _openai_client = AsyncOpenAI(**kwargs)
    return _openai_client


async def agent_loop(
    settings: Settings,
    tools: ToolRegistry,
    talos_config: dict,
    context: AgentContext,
    db: LocalDB,
    system_prompt_override: str | None = None,
    shutdown_event: asyncio.Event | None = None,
) -> list[dict]:
    """Run one agent cycle: LLM decides tools to call until done."""
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

        response = await client.chat.completions.create(
            model=settings.llm_model,
            messages=messages,
            tools=tool_schemas if tool_schemas else None,
            tool_choice="auto" if tool_schemas else None,
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


def _truncate_args(args: dict) -> str:
    parts = []
    for k, v in args.items():
        s = str(v)
        if len(s) > 50:
            s = s[:47] + "..."
        parts.append(f"{k}={s!r}")
    return ", ".join(parts)
