"""Scheduler entry points: ``run`` and ``run_multi``.

``run`` wires adapters, policy, tools and the task builder together, then
manages the asyncio task lifecycle and graceful shutdown.  The actual
per-task logic lives in ``scheduler.tasks``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from typing import TYPE_CHECKING

from rich.console import Console

from talos_agent import metrics
from talos_agent.clock import SystemClock
from talos_agent.observability import log
from talos_agent.observability import setup as setup_observability
from talos_agent.tracing import force_flush as force_flush_tracing
from talos_agent.tracing import shutdown_tracing

if TYPE_CHECKING:
    from talos_agent.config import Settings

console = Console()
logger = logging.getLogger(__name__)

SHUTDOWN_GRACE_PERIOD = 10  # seconds before force-exit on second signal
_DEFAULT_CLOCK = SystemClock()


# ── Setup helpers (each ≤ ~50 lines) ─────────────────────────────────────────


async def _resolve_talos_config(settings, api, db):
    """Download and cache the Talos config. Returns config dict or None."""
    console.print("[bold]Downloading Talos config...[/bold]")
    if settings.talos_id:
        talos_config = await api.get_talos(settings.talos_id)
    else:
        talos_config = await api.get_talos_me()
        if talos_config:
            settings.talos_id = talos_config["id"]
            api._talos_id = talos_config["id"]
            console.print(
                f"[green]Resolved Talos from API key:[/green] "
                f"{talos_config.get('name')} ({talos_config['id']})"
            )
    if talos_config:
        db.set_talos_config(talos_config)
        console.print(f"[green]Loaded Talos:[/green] {talos_config.get('name', settings.talos_id)}")
    else:
        console.print("[red]Failed to fetch Talos config. Check API key and Talos ID.[/red]")
    return talos_config


async def _setup_policy(settings, db, talos_config):
    """Build and return (policy_engine, policy_loader, policy_middleware)."""
    from talos_agent.policy import PolicyEngine, PolicyLoader, PolicyMiddleware

    policy_engine = PolicyEngine()
    policy_loader = PolicyLoader(db=db)
    policy_enabled = os.environ.get(
        "POLICY_ENGINE_ENABLED",
        str(talos_config.get("policyEngineEnabled", False)),
    ).lower() in ("true", "1", "yes")
    policy_engine.enabled = policy_enabled
    if policy_enabled:
        policy_engine.load(policy_loader.load())

    def _get_budget_context() -> dict[str, float]:
        cfg = db.get_talos_config()
        gtm_budget = float((cfg or {}).get("gtmBudget", 200))
        spent = float(db.get_spending_period(30))
        return {
            "gtm_budget": gtm_budget,
            "spent_this_period": spent,
            "budget_remaining": max(0.0, gtm_budget - spent),
        }

    def _get_config_context() -> dict[str, float]:
        return {"approval_threshold": float(settings.approval_threshold)}

    policy_middleware = PolicyMiddleware(
        policy_engine,
        policy_loader,
        budget_getter=_get_budget_context,
        config_getter=_get_config_context,
    )
    return policy_engine, policy_loader, policy_middleware


async def _setup_job_effects(settings, db, api):
    """Optionally build JobEffectStore and JobEffectDispatcher. Returns (store, dispatcher)."""
    if not settings.talos_durable_job_effects_enabled:
        return None, None

    from talos_agent.job_effects import (
        JobEffectDispatcher,
        JobEffectLimits,
        JobEffectStore,
    )

    limits = JobEffectLimits(
        max_inbox_records=settings.talos_job_effect_max_inbox_records,
        max_outbox_records=settings.talos_job_effect_max_outbox_records,
        max_payload_bytes=settings.talos_job_effect_max_payload_bytes,
        max_result_bytes=settings.talos_job_effect_max_result_bytes,
        batch_size=settings.talos_job_effect_batch_size,
        lease_seconds=settings.talos_job_effect_lease_seconds,
        max_attempts=settings.talos_job_effect_max_attempts,
        retry_base_seconds=settings.talos_job_effect_retry_base_seconds,
        dispatch_timeout_seconds=settings.talos_job_effect_dispatch_timeout_seconds,
        remote_lease_ttl_seconds=settings.job_lease_ttl,
        busy_timeout_ms=settings.talos_job_effect_db_timeout_ms,
    )
    store = JobEffectStore(db, owner_talos_id=settings.talos_id, limits=limits)
    dispatcher = JobEffectDispatcher(store, api)
    return store, dispatcher


async def _build_browser_manager(settings, api, db, tool_context, job_effect_store, job_effect_dispatcher):
    """Start browser and return (state_dict, ensure_browser_healthy callable)."""
    from talos_agent.browser.session import BrowserSession
    from talos_agent.tools.registry import build_all_tools

    browser_model_key = settings.llm_api_key
    browser = await BrowserSession.start(model_api_key=browser_model_key)
    tools = build_all_tools(
        api=api, db=db, browser=browser, settings=settings,
        job_effect_store=job_effect_store,
        job_effect_dispatcher=job_effect_dispatcher,
        context=tool_context,
    )
    console.print(f"[green]Registered {len(tools)} tools.[/green]")

    state = {
        "browser": browser,
        "tools": tools,
        "browser_model_key": browser_model_key,
        "browser_restart_attempts": 0,
        "is_degraded": False,
    }

    async def ensure_browser_healthy() -> bool:
        return await _check_browser_health(state, settings, api, db, tool_context,
                                           job_effect_store, job_effect_dispatcher)

    return state, ensure_browser_healthy


async def _check_browser_health(state, settings, api, db, tool_context,
                                job_effect_store, job_effect_dispatcher):
    """Inner health-check + recovery logic for the browser session."""
    from talos_agent.browser.session import BrowserSession
    from talos_agent.tools.registry import build_all_tools

    max_restart_attempts = 3
    current_model_key = settings.llm_api_key
    if current_model_key != state["browser_model_key"]:
        try:
            replacement = await BrowserSession.start(model_api_key=current_model_key)
            replacement_tools = build_all_tools(
                api=api, db=db, browser=replacement, settings=settings, context=tool_context,
            )
            previous = state["browser"]
            state.update(browser=replacement, tools=replacement_tools,
                         browser_model_key=current_model_key,
                         browser_restart_attempts=0, is_degraded=False)
            log.info("secret_consumer_reloaded", consumer="browser",
                     secret_name="llm_api_key", outcome="success")
            try:
                await asyncio.wait_for(previous.close(), timeout=5)
            except Exception:
                pass
        except Exception as exc:
            log.warning("secret_consumer_reload_failed", consumer="browser",
                        secret_name="llm_api_key", outcome="failure",
                        error_type=type(exc).__name__)

    if state["is_degraded"]:
        return False

    is_healthy = False
    if state["browser"] is not None:
        try:
            if hasattr(state["browser"], "context") and state["browser"].context:
                is_healthy = True
        except Exception:
            pass

    if is_healthy:
        return True

    console.print("[yellow]Browser session health check failed. Attempting recovery...[/yellow]")
    while state["browser_restart_attempts"] < max_restart_attempts:
        state["browser_restart_attempts"] += 1
        console.print(
            f"[bold yellow]Attempting browser reconnection "
            f"({state['browser_restart_attempts']}/{max_restart_attempts})...[/bold yellow]"
        )
        try:
            if state["browser"]:
                try:
                    await asyncio.wait_for(state["browser"].close(), timeout=3)
                except Exception:
                    pass
            state["browser"] = await BrowserSession.start(model_api_key=settings.llm_api_key)
            state["tools"] = build_all_tools(
                api=api, db=db, browser=state["browser"], settings=settings,
                job_effect_store=job_effect_store,
                job_effect_dispatcher=job_effect_dispatcher,
                context=tool_context,
            )
            console.print(
                f"[bold green]Browser reconnection event logged successfully "
                f"on attempt {state['browser_restart_attempts']}.[/bold green]"
            )
            return True
        except Exception as restart_err:
            console.print(
                f"[red]Browser reconnection failed on attempt "
                f"{state['browser_restart_attempts']}: {restart_err}[/red]"
            )
            await asyncio.sleep(2)

    console.print("[bold red]Maximum browser restart attempts reached. Marking agent runtime status as degraded.[/bold red]")
    state["is_degraded"] = True
    try:
        await api.update_status(settings.talos_id, online=True)
    except Exception:
        pass
    return False


async def _report_adapter_health(adapter_health_reporter):
    """Run the startup adapter health snapshot and log/print results."""
    try:
        startup_health = await adapter_health_reporter.report()
        log.info(
            "adapter_health_startup_snapshot",
            overall=startup_health.overall.value,
            adapters=[a.to_dict() for a in startup_health.adapters],
        )
        if startup_health.has_degraded:
            degraded_names = [
                f"{a.adapter} ({a.error_category.value})"
                for a in startup_health.degraded_adapters
            ]
            console.print(
                f"[yellow]Adapter health warning: degraded adapter(s): {', '.join(degraded_names)}[/yellow]"
            )
        else:
            console.print(
                f"[green]Adapter health check: {startup_health.overall.value.upper()}[/green]"
            )
    except Exception as exc:
        logger.debug("Initial adapter health check failed (non-fatal): %s", exc)


async def _run_reconcile(db, api):
    """Post-restore reconciliation — non-fatal if it fails."""
    from talos_agent.restore import ReconcileConfig, reconcile_after_restore

    config = ReconcileConfig(
        max_backoff_future_secs=3_600.0,
        backoff_cap_secs=60.0,
        max_clock_skew_secs=300.0,
        api_verify_leases=True,
        api_timeout_secs=10.0,
    )
    try:
        result = await reconcile_after_restore(db, api, config=config)
        console.print(
            f"[dim cyan]Restore reconciliation: "
            f"backoff_capped={result.backoff_rows_capped}, "
            f"schedules_reset={result.schedules_reset}, "
            f"jobs_restored={result.claimed_jobs_restored}, "
            f"jobs_dropped={result.claimed_jobs_dropped}, "
            f"markers_pruned={result.markers_pruned}[/dim cyan]"
        )
        if result.errors:
            console.print(
                f"[yellow]Restore reconciliation warnings ({len(result.errors)}): "
                + "; ".join(result.errors[:3])
                + ("[...]" if len(result.errors) > 3 else "")
                + "[/yellow]"
            )
    except Exception as exc:
        console.print(f"[yellow]Restore reconciliation failed (non-fatal): {exc}[/yellow]")
        logger.warning("reconcile_after_restore failed: %s", exc)


async def _graceful_shutdown(tasks, settings, db, shutdown_drain_complete):
    """Drain tasks within deadline, cancel overdue ones, release job leases."""
    job_hb_task = next((t for t in tasks if t.get_name() == "job_heartbeat"), None)
    drain_tasks = [t for t in tasks if t is not job_hb_task]

    deadline = settings.shutdown_deadline
    if deadline > 0:
        console.print(f"[yellow]Waiting up to {deadline:.0f}s for in-flight tasks to finish...[/yellow]")
        try:
            await asyncio.wait_for(
                asyncio.shield(asyncio.gather(*drain_tasks, return_exceptions=True)),
                timeout=deadline,
            )
            console.print("[green]All tasks finished within deadline.[/green]")
        except asyncio.TimeoutError:
            still_running = [t for t in drain_tasks if not t.done()]
            console.print(
                f"[red]Deadline exceeded — cancelling {len(still_running)} task(s): "
                + ", ".join(t.get_name() for t in still_running)
                + "[/red]"
            )
            for t in still_running:
                try:
                    db.add_activity(
                        "shutdown_cancelled",
                        f"Task '{t.get_name()}' was cancelled at shutdown (deadline={deadline:.0f}s)",
                        "system",
                    )
                except Exception:
                    pass
            try:
                from talos_agent.tools.browser import cleanup_browser_sessions_on_cancellation
                await cleanup_browser_sessions_on_cancellation()
            except Exception:
                pass
            for t in still_running:
                t.cancel()
            await asyncio.gather(*drain_tasks, return_exceptions=True)
    else:
        try:
            from talos_agent.tools.browser import cleanup_browser_sessions_on_cancellation
            await cleanup_browser_sessions_on_cancellation()
        except Exception:
            pass
        for t in drain_tasks:
            t.cancel()
        await asyncio.gather(*drain_tasks, return_exceptions=True)

    shutdown_drain_complete.set()
    if job_hb_task is not None:
        await asyncio.gather(job_hb_task, return_exceptions=True)

    try:
        from talos_agent.tools.commerce import release_claimed_jobs
        released, release_failures = await release_claimed_jobs()
        if released or release_failures:
            log.info("job_shutdown_drain_complete", released=released,
                     release_failures=release_failures)
    except Exception as exc:
        logger.warning("job_shutdown_release_failed", error_type=type(exc).__name__)


def _build_task_list(
    *,
    shutdown_event,
    shutdown_drain_complete,
    settings,
    api,
    db,
    talos_config,
    agent_lock,
    tools,
    stellar,
    policy_engine,
    policy_middleware,
    ensure_browser_healthy,
    effective_clock,
    job_effect_store,
    job_effect_dispatcher,
    telegram_queue_worker,
    adapter_health_reporter,
) -> list:
    """Create and return all asyncio Tasks for the agent run loop."""
    from talos_agent.scheduler.tasks import (
        activity_flush_task,
        agent_cycle_task,
        dividend_distribution_task,
        heartbeat_task,
        job_effect_dispatch_task,
        job_heartbeat_task,
        learning_cycle_task,
        loan_repayment_task,
        telegram_queue_task,
        telemetry_log_task,
        polling_task,
    )

    _shared = dict(
        shutdown_event=shutdown_event,
        settings=settings,
        api=api,
        db=db,
        talos_config=talos_config,
    )

    task_list = [
        asyncio.create_task(
            agent_cycle_task(
                **_shared, agent_lock=agent_lock, tools=tools,
                policy_engine=policy_engine, policy_middleware=policy_middleware,
                ensure_browser_healthy=ensure_browser_healthy,
                effective_clock=effective_clock,
            ),
            name="agent_cycle",
        ),
        asyncio.create_task(
            polling_task(**_shared, job_effect_store=job_effect_store),
            name="polling",
        ),
        asyncio.create_task(heartbeat_task(**_shared), name="heartbeat"),
        asyncio.create_task(
            job_heartbeat_task(
                **_shared,
                shutdown_drain_complete=shutdown_drain_complete,
                job_effect_store=job_effect_store,
            ),
            name="job_heartbeat",
        ),
        asyncio.create_task(activity_flush_task(**_shared), name="activity_flush"),
        asyncio.create_task(
            learning_cycle_task(
                **_shared, agent_lock=agent_lock, tools=tools,
                ensure_browser_healthy=ensure_browser_healthy,
                effective_clock=effective_clock,
            ),
            name="learning_cycle",
        ),
        asyncio.create_task(
            dividend_distribution_task(
                **_shared, stellar=stellar, effective_clock=effective_clock,
            ),
            name="dividend_distribution",
        ),
        asyncio.create_task(
            loan_repayment_task(**_shared, agent_lock=agent_lock),
            name="loan_repayment",
        ),
        asyncio.create_task(
            telemetry_log_task(
                **_shared, adapter_health_reporter=adapter_health_reporter,
                policy_engine=policy_engine,
            ),
            name="telemetry_log",
        ),
    ]
    if job_effect_dispatcher is not None:
        task_list.append(
            asyncio.create_task(
                job_effect_dispatch_task(
                    shutdown_event=shutdown_event, settings=settings,
                    db=db, job_effect_dispatcher=job_effect_dispatcher,
                ),
                name="job_effect_dispatch",
            )
        )
    if telegram_queue_worker is not None:
        task_list.append(
            asyncio.create_task(
                telegram_queue_task(
                    shutdown_event=shutdown_event,
                    telegram_queue_worker=telegram_queue_worker,
                ),
                name="telegram_queue",
            )
        )
    return task_list


async def _cleanup(api, browser_state, settings, db):
    """Final cleanup: go offline, close browser/API, flush metrics."""
    console.print("[yellow]Cleaning up...[/yellow]")
    try:
        await asyncio.wait_for(api.update_status(settings.talos_id, online=False), timeout=5)
    except Exception:
        pass
    try:
        from talos_agent.tools.browser import cleanup_browser_sessions_on_cancellation
        await asyncio.wait_for(cleanup_browser_sessions_on_cancellation(), timeout=5)
    except Exception:
        try:
            if browser_state["browser"]:
                await asyncio.wait_for(browser_state["browser"].close(), timeout=5)
        except Exception:
            pass
    await api.close()
    db.close()
    force_flush_tracing()
    metrics.force_flush_metrics()
    shutdown_tracing()
    metrics.shutdown_metrics()
    console.print("[bold]Agent stopped.[/bold]")


async def run(settings: "Settings", agent_slot: int = 0) -> None:
    """Entry point called by ``talos-agent start``.

    ``agent_slot`` is used for log prefixes when running multiple agents in a
    single process via ``run_multi``.
    """
    setup_observability()
    effective_clock = _DEFAULT_CLOCK

    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB, get_db_path

    db = LocalDB(
        path=get_db_path(settings.talos_api_key[:16] if agent_slot > 0 else None),
        timeout_ms=settings.secret_db_timeout_ms,
    )
    if settings.secret_rotation_enabled:
        from talos_agent.secret_store import build_secret_store, decode_keyring
        secret_store = build_secret_store(
            backend=settings.secret_store_backend,
            db=db,
            keyring=decode_keyring(settings.secret_keyring),
            active_key_id=settings.secret_active_key_id,
            scope=settings.secret_scope,
            max_value_bytes=settings.secret_max_bytes,
            dual_read=settings.secret_dual_read,
            legacy_fallback=settings.secret_legacy_fallback,
        )
        settings.bind_secret_store(secret_store)

    api = TalosAPIClient(settings)
    talos_config = await _resolve_talos_config(settings, api, db)
    if not talos_config:
        db.close()
        return

    job_effect_store, job_effect_dispatcher = await _setup_job_effects(settings, db, api)
    policy_engine, _policy_loader, policy_middleware = await _setup_policy(
        settings, db, talos_config
    )

    from talos_agent.tools import context as tool_context_module

    console.print("[bold]Starting browser session...[/bold]")
    browser_state, ensure_browser_healthy = await _build_browser_manager(
        settings, api, db, None, job_effect_store, job_effect_dispatcher
    )
    console.print("[green]Browser ready.[/green]")
    tools = browser_state["tools"]
    tool_context = tools.context
    tool_context_module.bind(tool_context)

    from talos_agent.adapters.health import AdapterHealthReporter
    from talos_agent.payments.stellar_kit import StellarKit

    stellar = StellarKit(api)
    await stellar.initialize()
    adapter_health_reporter = AdapterHealthReporter(
        registry=tool_context.adapter_registry,
        browser=browser_state["browser"],
        stellar_kit=stellar,
    )
    await _report_adapter_health(adapter_health_reporter)

    if policy_engine.enabled:
        console.print("[bold cyan]Policy engine ENABLED — actions will be gated.[/bold cyan]")
    else:
        console.print("[dim]Policy engine disabled (set POLICY_ENGINE_ENABLED=true to enable).[/dim]")

    await _run_reconcile(db, api)

    telegram_queue_worker = None
    if settings.telegram_rate_limit_enabled:
        from talos_agent.adapters.telegram_queue import (
            TelegramQueueConfig, TelegramQueueWorker, TelegramSendQueue,
        )
        telegram_queue_worker = TelegramQueueWorker(
            TelegramSendQueue(db, TelegramQueueConfig.from_settings(settings)),
            lambda: tool_context.adapter_registry,
            idle_interval=settings.telegram_queue_drain_interval_seconds,
        )

    shutdown_event = asyncio.Event()
    shutdown_drain_complete = asyncio.Event()
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

    agent_lock = asyncio.Lock()
    await api.update_status(settings.talos_id, online=True)
    console.print("[bold green]Agent is online. Press Ctrl+C to stop.[/bold green]\n")

    async_tasks = _build_task_list(
        shutdown_event=shutdown_event,
        shutdown_drain_complete=shutdown_drain_complete,
        settings=settings, api=api, db=db, talos_config=talos_config,
        agent_lock=agent_lock, tools=tools, stellar=stellar,
        policy_engine=policy_engine, policy_middleware=policy_middleware,
        ensure_browser_healthy=ensure_browser_healthy,
        effective_clock=effective_clock,
        job_effect_store=job_effect_store, job_effect_dispatcher=job_effect_dispatcher,
        telegram_queue_worker=telegram_queue_worker,
        adapter_health_reporter=adapter_health_reporter,
    )

    try:
        await shutdown_event.wait()
        await _graceful_shutdown(async_tasks, settings, db, shutdown_drain_complete)
    finally:
        await _cleanup(api, browser_state, settings, db)


async def run_multi(base_settings: "Settings", api_keys: list[str]) -> None:
    """Run multiple agents concurrently in a single process."""
    console.print(f"[bold green]Starting {len(api_keys)} agents...[/bold green]")

    async def run_one(api_key: str, slot: int) -> None:
        import copy
        agent_settings = copy.copy(base_settings)
        object.__setattr__(agent_settings, "talos_api_key", api_key)
        object.__setattr__(agent_settings, "talos_id", "")
        try:
            await run(agent_settings, agent_slot=slot)
        except Exception as e:
            print(f"[red]Agent {slot} ({api_key[:12]}...) crashed: {e}[/red]")

    await asyncio.gather(*[
        run_one(key, i + 1) for i, key in enumerate(api_keys)
    ])
