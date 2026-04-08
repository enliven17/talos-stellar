"""Main async scheduler — orchestrates all agent tasks."""

from __future__ import annotations

import asyncio
import os
import signal
from typing import TYPE_CHECKING

from rich.console import Console

if TYPE_CHECKING:
    from talos_agent.config import Settings

console = Console()

SHUTDOWN_GRACE_PERIOD = 10  # seconds before force-exit on second signal


async def run(settings: Settings) -> None:
    """Entry point called by `talos-agent start`."""
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB

    db = LocalDB()
    api = TalosAPIClient(settings)

    # Download Talos config
    console.print("[bold]Downloading Talos config...[/bold]")
    if settings.talos_id:
        talos_config = await api.get_talos(settings.talos_id)
    else:
        # Auto-resolve Talos from API key
        talos_config = await api.get_talos_me()
        if talos_config:
            settings.talos_id = talos_config["id"]
            api._talos_id = talos_config["id"]
            console.print(f"[green]Resolved Talos from API key:[/green] {talos_config.get('name')} ({talos_config['id']})")
    if not talos_config:
        console.print("[red]Failed to fetch Talos config. Check API key and Talos ID.[/red]")
        db.close()
        return
    db.set_talos_config(talos_config)
    console.print(f"[green]Loaded Talos:[/green] {talos_config.get('name', settings.talos_id)}")

    # Import tools + agent after config is loaded
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.agent.prompt import build_learning_prompt
    from talos_agent.browser.session import BrowserSession
    from talos_agent.tools.registry import build_all_tools

    # Start browser session
    console.print("[bold]Starting browser session...[/bold]")
    browser = await BrowserSession.start(model_api_key=settings.openai_api_key)
    console.print("[green]Browser ready.[/green]")

    # Build tools
    tools = build_all_tools(api=api, db=db, browser=browser, settings=settings)
    console.print(f"[green]Registered {len(tools)} tools.[/green]")

    # Shutdown handler — force-exit on second signal
    shutdown_event = asyncio.Event()
    _signal_count = 0

    def _handle_signal():
        nonlocal _signal_count
        _signal_count += 1
        if _signal_count == 1:
            console.print("\n[yellow]Shutting down gracefully...[/yellow]")
            shutdown_event.set()
        else:
            console.print("\n[red]Forced shutdown.[/red]")
            os._exit(1)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _handle_signal)

    # Lock to prevent concurrent agent_loop executions (shared browser)
    agent_lock = asyncio.Lock()

    # Report online
    await api.update_status(settings.talos_id, online=True)
    console.print("[bold green]Agent is online. Press Ctrl+C to stop.[/bold green]\n")

    async def agent_cycle_task():
        """Run agent loop every cycle_interval seconds."""
        while not shutdown_event.is_set():
            async with agent_lock:
                if shutdown_event.is_set():
                    break
                try:
                    context = AgentContext.from_db(db, talos_config)
                    await agent_loop(
                        settings=settings,
                        tools=tools,
                        talos_config=talos_config,
                        context=context,
                        db=db,
                        shutdown_event=shutdown_event,
                    )
                    db.update_schedule("agent_cycle")
                except Exception as e:
                    console.print(f"[red]Agent cycle error: {e}[/red]")
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=settings.agent_cycle_interval)
                break
            except asyncio.TimeoutError:
                pass

    async def polling_task():
        """Poll Web API for approvals and commerce jobs."""
        while not shutdown_event.is_set():
            try:
                # Poll approvals
                approvals = await api.get_approvals(settings.talos_id, status="pending")
                for a in approvals:
                    cached = db.get_pending_approvals()
                    cached_ids = {c["approval_id"] for c in cached}
                    if a["id"] not in cached_ids:
                        db.cache_approval(a["id"], a["type"], a["title"], a.get("description"), a.get("amount"))

                # Poll pending jobs (as service provider)
                jobs = await api.get_pending_jobs()
                for job in jobs:
                    db.add_commerce_job(job["id"], job["talosId"], job.get("serviceName", ""), job.get("payload"))
            except Exception as e:
                console.print(f"[dim red]Polling error: {e}[/dim red]")
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=settings.polling_interval)
                break
            except asyncio.TimeoutError:
                pass

    async def heartbeat_task():
        """Report online status periodically."""
        while not shutdown_event.is_set():
            try:
                await api.update_status(settings.talos_id, online=True)
            except Exception:
                pass
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=settings.heartbeat_interval)
                break
            except asyncio.TimeoutError:
                pass

    async def activity_flush_task():
        """Flush buffered activity logs to Web API."""
        while not shutdown_event.is_set():
            try:
                pending = db.get_pending_activities()
                if pending:
                    for act in pending:
                        await api.report_activity(
                            settings.talos_id,
                            type_=act["type"],
                            content=act["content"],
                            channel=act["channel"],
                        )
                    db.mark_activities_sent([a["id"] for a in pending])
            except Exception:
                pass
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=30)
                break
            except asyncio.TimeoutError:
                pass

    async def learning_cycle_task():
        """Run a dedicated learning cycle every 6 hours: measure → review → evolve."""
        learning_interval = 6 * 3600  # 6 hours

        # Wait for the first agent cycle to complete before starting
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=learning_interval)
            return
        except asyncio.TimeoutError:
            pass

        while not shutdown_event.is_set():
            async with agent_lock:
                if shutdown_event.is_set():
                    break
                try:
                    context = AgentContext.from_db(db, talos_config)

                    # Only run if there are unmeasured posts or enough data for a review
                    if context.unmeasured_count > 0 or context.performance_summary.get("total_posts", 0) >= 5:
                        console.print("[bold magenta]Starting learning cycle...[/bold magenta]")
                        learning_prompt = build_learning_prompt(talos_config, context)
                        await agent_loop(
                            settings=settings,
                            tools=tools,
                            talos_config=talos_config,
                            context=context,
                            db=db,
                            system_prompt_override=learning_prompt,
                            shutdown_event=shutdown_event,
                        )
                        db.update_schedule("learning_cycle")
                        console.print("[bold magenta]Learning cycle complete.[/bold magenta]")
                except Exception as e:
                    console.print(f"[red]Learning cycle error: {e}[/red]")
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=learning_interval)
                break
            except asyncio.TimeoutError:
                pass

    tasks = [
        asyncio.create_task(agent_cycle_task(), name="agent_cycle"),
        asyncio.create_task(polling_task(), name="polling"),
        asyncio.create_task(heartbeat_task(), name="heartbeat"),
        asyncio.create_task(activity_flush_task(), name="activity_flush"),
        asyncio.create_task(learning_cycle_task(), name="learning_cycle"),
    ]

    try:
        # Wait until shutdown is requested, then cancel all tasks
        await shutdown_event.wait()

        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        # Graceful shutdown with timeout
        console.print("[yellow]Cleaning up...[/yellow]")
        try:
            await asyncio.wait_for(api.update_status(settings.talos_id, online=False), timeout=5)
        except Exception:
            pass
        try:
            await asyncio.wait_for(browser.close(), timeout=5)
        except Exception:
            pass
        await api.close()
        db.close()
        console.print("[bold]Agent stopped.[/bold]")
