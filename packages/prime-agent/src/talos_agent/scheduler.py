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


async def run(settings: Settings, agent_slot: int = 0) -> None:
    """Entry point called by `talos-agent start`. agent_slot used for log prefixes in multi mode."""
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB, get_db_path

    tag = f"[{settings.talos_api_key[:12]}]" if agent_slot > 0 else ""
    db = LocalDB(path=get_db_path(settings.talos_api_key[:16] if agent_slot > 0 else None))
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
    browser = await BrowserSession.start(model_api_key=settings.llm_api_key)
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

    async def loan_repayment_task():
        """Monitor and auto-repay loan interests from generated revenues. Runs every 24 hours."""
        repayment_interval = 24 * 3600  # 24 hours

        # Wait for the first agent cycle to complete before starting
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=repayment_interval)
            return
        except asyncio.TimeoutError:
            pass

        # Import StellarKit for balance queries
        from talos_agent.payments.stellar_kit import StellarKit
        stellar_kit = StellarKit(api)

        while not shutdown_event.is_set():
            async with agent_lock:
                if shutdown_event.is_set():
                    break
                try:
                    console.print("[bold cyan]Starting loan repayment cycle...[/bold cyan]")
                    
                    # Get loans due soon (within 7 days)
                    loans_due = db.get_loans_due_soon(days=7)
                    
                    if not loans_due:
                        console.print("[dim]No loans due for repayment.[/dim]")
                    else:
                        console.print(f"[cyan]Found {len(loans_due)} loan(s) due for repayment.[/cyan]")
                        
                        # Check if auto-repay is enabled
                        if not settings.auto_repay_loans:
                            console.print("[yellow]AUTO_REPAY_LOANS is disabled. Skipping auto-repayment.[/yellow]")
                            for loan in loans_due:
                                db.add_activity(
                                    "loan_warning",
                                    f"Loan {loan['id']} due but auto-repay disabled. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                                    "defi",
                                )
                        else:
                            # Get treasury balance from Stellar
                            await stellar_kit.initialize()
                            balance_result = await stellar_kit.get_balance()
                            
                            if "error" in balance_result:
                                console.print(f"[red]Failed to query treasury balance: {balance_result['error']}[/red]")
                                for loan in loans_due:
                                    db.add_activity(
                                        "loan_warning",
                                        f"Loan {loan['id']} due but balance query failed. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                                        "defi",
                                    )
                            else:
                                available_balance = balance_result.get("balance_xlm", 0)
                                console.print(f"[dim]Treasury balance: {available_balance} XLM[/dim]")
                                
                                for loan in loans_due:
                                    loan_id = loan["id"]
                                    outstanding = loan["outstanding_amount"]
                                    platform = loan["platform"]
                                    loan_asset = loan["loan_asset"]
                                    
                                    # For now, we only support XLM loans. Add USDC support when needed.
                                    if loan_asset != "XLM":
                                        console.print(f"[yellow]Skipping loan {loan_id}: only XLM auto-repayment supported (asset: {loan_asset})[/yellow]")
                                        db.add_activity(
                                            "loan_warning",
                                            f"Loan {loan_id} due but auto-repay only supports XLM (asset: {loan_asset})",
                                            "defi",
                                        )
                                        continue
                                    
                                    if available_balance >= outstanding:
                                        console.print(f"[green]Auto-repaying loan {loan_id}: {outstanding} XLM to {platform}[/green]")
                                        
                                        # Execute the actual transfer via API
                                        transfer_result = await api.request_transfer(
                                            to_account=platform,  # In production, this should be the lending platform's address
                                            amount=outstanding,
                                            currency="XLM",
                                        )
                                        
                                        if transfer_result and "error" not in transfer_result:
                                            # Record the repayment only if transfer succeeded
                                            db.record_repayment(loan_id, outstanding, tx_hash=transfer_result.get("tx_hash"))
                                            
                                            # Report activity
                                            db.add_activity(
                                                "loan_repayment",
                                                f"Auto-repaid loan {loan_id}: {outstanding} XLM to {platform}. TX: {transfer_result.get('tx_hash', 'pending')}",
                                                "defi",
                                            )
                                            console.print(f"[green]Transfer successful for loan {loan_id}[/green]")
                                        else:
                                            console.print(f"[red]Transfer failed for loan {loan_id}: {transfer_result.get('error', 'Unknown error')}[/red]")
                                            db.add_activity(
                                                "loan_error",
                                                f"Auto-repay failed for loan {loan_id}: {transfer_result.get('error', 'Unknown error')}",
                                                "defi",
                                            )
                                    else:
                                        console.print(f"[yellow]Insufficient balance to repay loan {loan_id}. Outstanding: {outstanding}, Available: {available_balance}[/yellow]")
                                        db.add_activity(
                                            "loan_warning",
                                            f"Loan {loan_id} due but insufficient funds. Outstanding: {outstanding}, Available: {available_balance}",
                                            "defi",
                                        )
                    
                    db.update_schedule("loan_repayment")
                    console.print("[bold cyan]Loan repayment cycle complete.[/bold cyan]")
                except Exception as e:
                    console.print(f"[red]Loan repayment cycle error: {e}[/red]")
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=repayment_interval)
                break
            except asyncio.TimeoutError:
                pass

    tasks = [
        asyncio.create_task(agent_cycle_task(), name="agent_cycle"),
        asyncio.create_task(polling_task(), name="polling"),
        asyncio.create_task(heartbeat_task(), name="heartbeat"),
        asyncio.create_task(activity_flush_task(), name="activity_flush"),
        asyncio.create_task(learning_cycle_task(), name="learning_cycle"),
        asyncio.create_task(loan_repayment_task(), name="loan_repayment"),
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


async def run_multi(base_settings: Settings, api_keys: list[str]) -> None:
    """Run multiple agents concurrently in a single process."""
    console.print(f"[bold green]Starting {len(api_keys)} agents...[/bold green]")

    async def run_one(api_key: str, slot: int) -> None:
        from dataclasses import replace as dc_replace
        import copy
        agent_settings = copy.copy(base_settings)
        object.__setattr__(agent_settings, "talos_api_key", api_key)
        object.__setattr__(agent_settings, "talos_id", "")
        try:
            await run(agent_settings, agent_slot=slot)
        except Exception as e:
            console.print(f"[red]Agent {slot} ({api_key[:12]}...) crashed: {e}[/red]")

    await asyncio.gather(*[
        run_one(key, i + 1) for i, key in enumerate(api_keys)
    ])
