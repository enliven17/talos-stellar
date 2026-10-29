"""Composable task coroutines for the scheduler run loop.

Each public function in this module returns a coroutine that implements one
periodic responsibility of the agent.  They are wired together by
``scheduler.runner.build_tasks`` so ``run()`` stays thin.

All tasks share:
- ``shutdown_event`` — set to request a graceful stop.
- ``db`` — for durable state and activity logging.
- ``api`` — for remote API calls.
- ``settings`` — agent configuration.
- A ``DurableBackoff`` instance for retry/restart resilience (where applicable).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING

import structlog
from rich.console import Console

from talos_agent import metrics
from talos_agent.circuit_breaker import cb_registry
from talos_agent.observability import log
from talos_agent.scheduler.backoff import DurableBackoff
from talos_agent.scheduler.helpers import run_dividend_distribution, run_loan_repayment
from talos_agent.scheduler.policy import check_should_run
from talos_agent.tracing import traced_span

if TYPE_CHECKING:
    from talos_agent.clock import ClockProtocol
    from talos_agent.config import Settings

console = Console()
logger = logging.getLogger(__name__)


# ── Shared span helper ─────────────────────────────────────────────────────────


def _traced_task_run(name: str, talos_config: dict):
    return traced_span(
        f"scheduler.{name}",
        {"talos.id": str(talos_config.get("id", ""))},
    )


async def _wait_for_restored_deadline(
    shutdown_event: asyncio.Event,
    backoff: DurableBackoff,
) -> None:
    """Honor a persisted retry deadline before the worker's first post-restart call."""
    remaining = backoff.wait_remaining()
    if remaining <= 0:
        return
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=remaining)
    except asyncio.TimeoutError:
        pass


# ── Individual task coroutines ─────────────────────────────────────────────────


async def agent_cycle_task(
    *,
    shutdown_event: asyncio.Event,
    agent_lock: asyncio.Lock,
    settings: "Settings",
    tools,
    talos_config: dict,
    db,
    api,
    policy_engine,
    policy_middleware,
    ensure_browser_healthy,
    effective_clock: "ClockProtocol",
) -> None:
    """Run agent loop every ``settings.agent_cycle_interval`` seconds."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.agent.prompt import build_learning_prompt

    while not shutdown_event.is_set():
        async with agent_lock:
            if shutdown_event.is_set():
                break
            cycle_id = str(uuid.uuid4())
            structlog.contextvars.bind_contextvars(cycle_id=cycle_id)
            api.set_request_id(cycle_id)
            try:
                # Hot-reload policies if the file changed
                if policy_engine.enabled:
                    if policy_middleware.hot_reload():
                        console.print("[cyan]Policy engine: policies reloaded (file change detected).[/cyan]")

                if not await ensure_browser_healthy():
                    console.print(
                        "[red]Skipping agent cycle: browser session is down and unrecoverable.[/red]"
                    )
                else:
                    log.info(
                        "agent_cycle_start",
                        talos=talos_config.get("name"),
                        cycle_id=cycle_id,
                    )
                    context = AgentContext.from_db(
                        db, talos_config, clock=effective_clock
                    )

                    # ── Replay recording (optional) ──────────────────────
                    replay_recorder = None
                    if settings.replay_enabled:
                        from talos_agent.replay import ReplayRecorder
                        replay_recorder = ReplayRecorder(
                            session_id=cycle_id,
                            db=db,
                            talos_id=settings.talos_id,
                            redact=settings.replay_redact_payloads,
                        )
                        replay_recorder.record(
                            "agent_cycle_start",
                            {
                                "talos_id": settings.talos_id,
                                "current_time": context.current_time,
                                "pending_approvals": context.pending_approvals,
                                "pending_jobs": context.pending_jobs,
                                "posts_today": context.posts_today,
                            },
                        )

                    messages = await agent_loop(
                        settings=settings,
                        tools=tools,
                        talos_config=talos_config,
                        context=context,
                        db=db,
                        shutdown_event=shutdown_event,
                    )

                    db.update_schedule("agent_cycle")

                    # ── Record completion ────────────────────────────────
                    if replay_recorder is not None:
                        replay_recorder.record(
                            "agent_cycle_complete",
                            {"message_count": len(messages)},
                        )
                        db.finish_replay_session(cycle_id, status="completed")

                    log.info("agent_cycle_complete", cycle_id=cycle_id)
            except Exception as e:
                console.print(f"[red]Agent cycle error: {e}[/red]")
                log.error("agent_cycle_error", error=str(e), cycle_id=cycle_id)

                if settings.replay_enabled:
                    try:
                        from talos_agent.replay import ReplayRecorder
                        err_recorder = ReplayRecorder(
                            session_id=cycle_id,
                            db=db,
                            talos_id=settings.talos_id,
                            redact=settings.replay_redact_payloads,
                        )
                        err_recorder.record(
                            "agent_cycle_error",
                            {"error": str(e), "error_type": type(e).__name__},
                        )
                        db.finish_replay_session(cycle_id, status="error")
                    except Exception:
                        pass

                try:
                    import sentry_sdk
                    sentry_sdk.capture_exception(e)
                except Exception:
                    pass
            finally:
                structlog.contextvars.unbind_contextvars("cycle_id")
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=settings.agent_cycle_interval)
            break
        except asyncio.TimeoutError:
            pass


async def polling_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    api,
    db,
    talos_config: dict,
    job_effect_store,
) -> None:
    """Poll Web API for approvals and commerce jobs."""
    backoff = DurableBackoff(
        task_name="polling",
        db=db,
        base_delay=settings.polling_interval,
        jitter_identity=settings.talos_id,
    )
    await _wait_for_restored_deadline(shutdown_event, backoff)
    while not shutdown_event.is_set():
        try:
            with _traced_task_run("polling", talos_config):
                approvals = await api.get_approvals(settings.talos_id, status="pending")
                for a in approvals:
                    cached = db.get_pending_approvals()
                    cached_ids = {c["approval_id"] for c in cached}
                    if a["id"] not in cached_ids:
                        db.cache_approval(
                            a["id"],
                            a["type"],
                            a["title"],
                            a.get("description"),
                            a.get("amount"),
                        )

            jobs = await api.get_pending_jobs()
            for job in jobs:
                if job_effect_store is not None:
                    try:
                        job_effect_store.ingest(job)
                    except Exception as exc:
                        from talos_agent.job_effects import JobEffectError
                        if isinstance(exc, JobEffectError):
                            log.warning("job_inbox_rejected", error_code=exc.code)
                            continue
                        raise
                else:
                    db.add_commerce_job(
                        job["id"],
                        job["talosId"],
                        job.get("serviceName", ""),
                        job.get("payload"),
                    )

            backoff.success()
        except Exception as e:
            console.print(f"[dim red]Polling error: {e}[/dim red]")
            backoff.failure()
            if backoff.terminal:
                logger.warning("polling_task: reached max_attempts — stopping task")
                break

        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=backoff.delay_until_next_attempt()
            )
            break
        except asyncio.TimeoutError:
            pass


async def heartbeat_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    api,
    db,
    talos_config: dict,
) -> None:
    """Report online status periodically."""
    backoff = DurableBackoff(
        task_name="heartbeat",
        db=db,
        base_delay=settings.heartbeat_interval,
        jitter_identity=settings.talos_id,
    )
    await _wait_for_restored_deadline(shutdown_event, backoff)
    while not shutdown_event.is_set():
        try:
            with _traced_task_run("heartbeat", talos_config):
                await api.update_status(settings.talos_id, online=True)
            backoff.success()
        except Exception as e:
            logger.debug(f"Heartbeat error: {e}")
            backoff.failure()
            if backoff.terminal:
                logger.warning("heartbeat_task: reached max_attempts — stopping task")
                break

        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=backoff.delay_until_next_attempt()
            )
            break
        except asyncio.TimeoutError:
            pass


async def job_heartbeat_task(
    *,
    shutdown_event: asyncio.Event,
    shutdown_drain_complete: asyncio.Event,
    settings: "Settings",
    api,
    db,
    job_effect_store,
) -> None:
    """Extend leases until the graceful shutdown drain has completed."""
    from talos_agent.tools.commerce import get_claimed_jobs_copy

    backoff = DurableBackoff(
        task_name="job_heartbeat",
        db=db,
        base_delay=settings.job_heartbeat_interval,
        jitter_identity=settings.talos_id,
    )
    await _wait_for_restored_deadline(shutdown_event, backoff)
    while True:
        try:
            claimed = (
                job_effect_store.claimed_jobs()
                if job_effect_store is not None
                else get_claimed_jobs_copy()
            )
            for job_id, fencing_token in claimed.items():
                result = await api.heartbeat_job(job_id, fencing_token)
                if not result:
                    logger.warning("job_lease_heartbeat_failed")
            backoff.success()
        except Exception as e:
            logger.debug("Job heartbeat error: %s", e)
            backoff.failure()

        if shutdown_drain_complete.is_set():
            break

        try:
            if shutdown_event.is_set():
                await asyncio.wait_for(
                    shutdown_drain_complete.wait(),
                    timeout=backoff.delay_until_next_attempt(),
                )
                break
            await asyncio.wait_for(
                shutdown_event.wait(),
                timeout=backoff.delay_until_next_attempt(),
            )
        except asyncio.TimeoutError:
            pass


async def activity_flush_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    api,
    db,
    talos_config: dict,
) -> None:
    """Flush buffered activity logs to Web API."""
    backoff = DurableBackoff(
        task_name="activity_flush",
        db=db,
        base_delay=30,
        jitter_identity=settings.talos_id,
    )
    await _wait_for_restored_deadline(shutdown_event, backoff)
    while not shutdown_event.is_set():
        try:
            with _traced_task_run("activity_flush", talos_config):
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
            backoff.success()
        except Exception as e:
            logger.debug(f"Activity flush error: {e}")
            backoff.failure()
            if backoff.terminal:
                logger.warning("activity_flush_task: reached max_attempts — stopping task")
                break

        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=backoff.delay_until_next_attempt()
            )
            break
        except asyncio.TimeoutError:
            pass


async def learning_cycle_task(
    *,
    shutdown_event: asyncio.Event,
    agent_lock: asyncio.Lock,
    settings: "Settings",
    tools,
    talos_config: dict,
    db,
    ensure_browser_healthy,
    effective_clock: "ClockProtocol",
) -> None:
    """Run a dedicated learning cycle every 6 hours: measure → review → evolve."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.agent.prompt import build_learning_prompt

    learning_interval = 6 * 3600  # 6 hours

    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=learning_interval)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown_event.is_set():
        async with agent_lock:
            if shutdown_event.is_set():
                break

            if not await ensure_browser_healthy():
                console.print("[red]Skipping learning cycle: browser session is down and unrecoverable.[/red]")
            else:
                try:
                    with _traced_task_run("learning_cycle", talos_config):
                        context = AgentContext.from_db(
                            db, talos_config, clock=effective_clock
                        )

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


async def dividend_distribution_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    stellar,
    api,
    db,
    talos_config: dict,
    effective_clock: "ClockProtocol",
) -> None:
    """Periodically check USDC balance and distribute dividends to patrons."""
    distribution_interval = settings.dividend_distribution_interval

    # Wait for the first interval before starting
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=distribution_interval)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown_event.is_set():
        try:
            # Prevent duplicate runs after restart
            last_run = db.get_last_run("dividend_distribution")
            if last_run and not check_should_run(
                now=effective_clock.now_utc()
                if hasattr(effective_clock, "now_utc")
                else effective_clock.now(),
                last_run=last_run,
                interval_seconds=distribution_interval,
                clock=effective_clock,
            ):
                now_val = (
                    effective_clock.now_utc()
                    if hasattr(effective_clock, "now_utc")
                    else effective_clock.now()
                )
                elapsed = (now_val - last_run).total_seconds()
                remaining = distribution_interval - elapsed
                if remaining > 0:
                    console.print(
                        f"[dim]Dividend distribution skipped — "
                        f"next run in {int(remaining)}s[/dim]"
                    )
                    try:
                        await asyncio.wait_for(shutdown_event.wait(), timeout=remaining)
                        return  # shutdown requested during wait
                    except asyncio.TimeoutError:
                        pass
                    continue

            with _traced_task_run("dividend_distribution", talos_config):
                result = await run_dividend_distribution(
                    talos_id=settings.talos_id,
                    talos_config=talos_config,
                    settings=settings,
                    stellar=stellar,
                    api=api,
                    db=db,
                )

            _RESULT_MESSAGES = {
                "no_wallet": ("[dim yellow]", "No wallet public key configured — skipping dividend distribution"),
                "missing_creator": ("[bold red]", "No creator public key configured — aborting dividend distribution"),
                "balance_error": ("[bold red]", "USDC balance check failed — skipping dividend distribution"),
                "below_threshold": ("[dim]", f"USDC balance below threshold {settings.dividend_usdc_threshold} — skipping"),
                "preview_failed": ("[bold red]", "Distribution preview failed — aborting"),
                "distribution_failed": ("[bold red]", "Dividend distribution failed"),
                "success": ("[bold green]", "Dividend distribution successful"),
            }
            color, msg = _RESULT_MESSAGES.get(result, ("[dim]", f"Unknown result: {result}"))
            console.print(f"{color}{msg}[/]")

        except Exception as e:
            console.print(f"[red]Dividend distribution task error: {e}[/red]")

        try:
            await asyncio.wait_for(
                shutdown_event.wait(),
                timeout=distribution_interval,
            )
            break
        except asyncio.TimeoutError:
            pass


async def loan_repayment_task(
    *,
    shutdown_event: asyncio.Event,
    agent_lock: asyncio.Lock,
    settings: "Settings",
    api,
    db,
    talos_config: dict,
) -> None:
    """Monitor and auto-repay loan interests. Runs every 24 hours."""
    from talos_agent.payments.stellar_kit import StellarKit

    repayment_interval = 24 * 3600

    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=repayment_interval)
        return
    except asyncio.TimeoutError:
        pass

    stellar_kit = StellarKit(api)

    while not shutdown_event.is_set():
        async with agent_lock:
            if shutdown_event.is_set():
                break
            try:
                with _traced_task_run("loan_repayment", talos_config):
                    result = await run_loan_repayment(
                        settings=settings,
                        stellar_kit=stellar_kit,
                        api=api,
                        db=db,
                    )
                console.print(
                    f"[bold cyan]Loan repayment cycle complete: {result}[/bold cyan]"
                )
            except Exception as e:
                console.print(f"[red]Loan repayment cycle error: {e}[/red]")
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=repayment_interval)
            break
        except asyncio.TimeoutError:
            pass


async def telemetry_log_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    db,
    talos_config: dict,
    adapter_health_reporter,
    policy_engine,
) -> None:
    """Periodically log runtime telemetry for operator observability.

    Privacy-safe: no prompts, API keys, signatures, or wallet secrets
    are included in the output.  Runs once every 30 minutes.
    """
    from talos_agent.telemetry import TelemetryCollector

    telemetry_interval = 30 * 60  # 30 minutes

    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=telemetry_interval)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown_event.is_set():
        try:
            collector = TelemetryCollector(
                db=db,
                agent_name=talos_config.get("name", settings.talos_id),
            )
            report = collector.collect(
                cb_registry=cb_registry,
                policy_engine=policy_engine if policy_engine.enabled else None,
            )
            try:
                health_report = await adapter_health_reporter.report()
                collector.add_adapter_health(report, health_report.adapters)
            except Exception as _ah_exc:
                logger.debug("Telemetry adapter health probe failed: %s", _ah_exc)

            log.info(
                "telemetry_snapshot",
                tasks=[
                    {"name": t.name, "last_run": t.last_run_at, "retries": t.retry_attempts}
                    for t in report.tasks
                ],
                queues=[
                    {"name": q.name, "pending": q.pending_count, "total": q.total_count}
                    for q in report.queues
                ],
                posts_7d=report.total_posts_7d,
                impressions_7d=report.total_impressions_7d,
                circuit_breakers=[
                    {"provider": c.get("provider"), "state": c.get("state")}
                    for c in report.circuit_breakers
                ],
                adapters=[
                    {"name": a.name, "state": a.state, "error_category": a.error_category}
                    for a in report.adapters
                ],
                policy_evaluations=report.policy_evaluation_count,
            )
        except Exception as _tel_exc:
            logger.debug("Telemetry snapshot failed: %s", _tel_exc)

        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=telemetry_interval)
            break
        except asyncio.TimeoutError:
            pass


async def job_effect_dispatch_task(
    *,
    shutdown_event: asyncio.Event,
    settings: "Settings",
    db,
    job_effect_dispatcher,
) -> None:
    """Recover and dispatch durable provider-job effects."""
    if job_effect_dispatcher is None:
        return

    backoff = DurableBackoff(
        task_name="job_effect_dispatch",
        db=db,
        base_delay=settings.talos_job_effect_dispatch_interval,
        jitter_identity=settings.talos_id,
    )
    await _wait_for_restored_deadline(shutdown_event, backoff)
    while not shutdown_event.is_set():
        try:
            result = await job_effect_dispatcher.dispatch_once()
            if result["claimed"]:
                log.info(
                    "job_effect_dispatch_batch",
                    claimed=result["claimed"],
                    succeeded=result["succeeded"],
                    retryable=result["retryable"],
                    indeterminate=result["indeterminate"],
                    conflict=result["conflict"],
                    dead=result["dead"],
                )
            backoff.success()
        except Exception:
            log.error("job_effect_dispatch_batch_failed", error_code="batch_failure")
            backoff.failure()
        try:
            await asyncio.wait_for(
                shutdown_event.wait(), timeout=backoff.delay_until_next_attempt()
            )
            break
        except asyncio.TimeoutError:
            pass


async def telegram_queue_task(
    *,
    shutdown_event: asyncio.Event,
    telegram_queue_worker,
) -> None:
    """Drain the durable Telegram send queue at the paced rate."""
    if telegram_queue_worker is None:
        return
    await telegram_queue_worker.run(shutdown_event)
