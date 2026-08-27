"""Main async scheduler — orchestrates all agent tasks."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import signal
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from talos_agent.clock import ClockProtocol, SystemClock
from talos_agent import metrics

import structlog
from rich.console import Console

if TYPE_CHECKING:
    from talos_agent.config import Settings

from talos_agent.circuit_breaker import cb_registry
from talos_agent.observability import log, setup as setup_observability
from talos_agent.tracing import (
    force_flush as force_flush_tracing,
    shutdown_tracing,
    traced_span,
)

console = Console()
logger = logging.getLogger(__name__)

SHUTDOWN_GRACE_PERIOD = 10  # seconds before force-exit on second signal


def _traced_task_run(name: str, talos_config: dict):
    return traced_span(
        f"scheduler.{name}",
        {"talos.id": str(talos_config.get("id", ""))},
    )


async def run_dividend_distribution(
    *,
    talos_id: str,
    talos_config: dict,
    settings,
    stellar,
    api,
    db,
) -> str:
    """
    Core dividend distribution logic extracted for testability.
    Returns a status string: 'no_wallet', 'missing_creator', 'below_threshold',
    'preview_failed', 'distribution_failed', 'success', or 'balance_error'.
    """
    stellar_account_id = talos_config.get("walletPublicKey", "")
    if not stellar_account_id:
        return "no_wallet"

    balance_result = await stellar.get_token_balance(stellar_account_id, "USDC")

    if "error" in balance_result:
        db.update_schedule("dividend_distribution")
        return "balance_error"

    usdc_balance = balance_result.get("balance", 0)

    if usdc_balance < float(settings.dividend_usdc_threshold):
        return "below_threshold"

    preview = await api.get_distribution_preview(talos_id)
    if not preview or "error" in preview:
        return "preview_failed"

    creator_public_key = talos_config.get("creatorPublicKey", "")
    if not creator_public_key:
        return "missing_creator"

    result = await api.distribute_dividends(
        talos_id,
        requester_public_key=creator_public_key,
    )

    if not result or "error" in result:
        return "distribution_failed"

    db.update_schedule("dividend_distribution")
    return "success"


def _is_stellar_public_key(value: object) -> bool:
    return isinstance(value, str) and value.startswith("G") and len(value) == 56


async def run_loan_repayment(
    *,
    settings,
    stellar_kit,
    api,
    db,
    days: int = 7,
) -> dict:
    loans_due = db.get_loans_due_soon(days=days)
    result = {
        "status": "no_loans" if not loans_due else "processed",
        "processed": 0,
        "repaid": 0,
        "warnings": 0,
        "errors": 0,
    }

    if not loans_due:
        db.update_schedule("loan_repayment")
        return result

    if not settings.auto_repay_loans:
        for loan in loans_due:
            db.add_activity(
                "loan_warning",
                f"Loan {loan['id']} due but auto-repay disabled. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                "defi",
            )
            result["warnings"] += 1
        db.update_schedule("loan_repayment")
        return result

    await stellar_kit.initialize()
    balance_result = await stellar_kit.get_balance()
    if "error" in balance_result:
        for loan in loans_due:
            db.add_activity(
                "loan_warning",
                f"Loan {loan['id']} due but balance query failed. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                "defi",
            )
            result["warnings"] += 1
        result["status"] = "balance_error"
        db.update_schedule("loan_repayment")
        return result

    available_balance = float(balance_result.get("balance_xlm", 0))

    for loan in loans_due:
        result["processed"] += 1
        loan_id = loan["id"]
        outstanding = float(loan["outstanding_amount"])
        loan_asset = loan["loan_asset"]
        repayment_address = loan.get("repayment_address")

        if loan_asset != "XLM":
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but auto-repay only supports XLM (asset: {loan_asset})",
                "defi",
            )
            result["warnings"] += 1
            continue

        if not _is_stellar_public_key(repayment_address):
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but repayment destination is missing or invalid",
                "defi",
            )
            result["warnings"] += 1
            continue

        repay_amount = min(outstanding, available_balance)
        if repay_amount <= 0:
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but insufficient funds. Outstanding: {outstanding}, Available: {available_balance}",
                "defi",
            )
            result["warnings"] += 1
            continue

        transfer_result = await api.request_transfer(
            to_account=repayment_address,
            amount=repay_amount,
            currency="XLM",
        )

        if not transfer_result or "error" in transfer_result:
            db.add_activity(
                "loan_error",
                f"Auto-repay failed for loan {loan_id}: {transfer_result.get('error', 'Unknown error') if transfer_result else 'No result'}",
                "defi",
            )
            result["errors"] += 1
            continue

        db.record_repayment(loan_id, repay_amount, tx_hash=transfer_result.get("tx_hash"))
        db.add_activity(
            "loan_repayment",
            f"Auto-repaid loan {loan_id}: {repay_amount} XLM. TX: {transfer_result.get('tx_hash', 'pending')}",
            "defi",
        )
        available_balance -= repay_amount
        result["repaid"] += 1

    db.update_schedule("loan_repayment")
    return result


class Backoff:
    """Exponential backoff with jitter for task retries."""

    def __init__(
        self,
        base_delay: float,
        initial_backoff: float = 2.0,
        max_backoff: float = 300.0,
        jitter: float = 0.2,
    ):
        self.base_delay = base_delay
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff
        self.jitter = jitter
        self.fail_count = 0

    def next_delay(self) -> float:
        if self.fail_count == 0:
            return self.base_delay

        # Exponential backoff: initial * 2^(fail_count - 1)
        delay = self.initial_backoff * (2 ** (self.fail_count - 1))
        delay = min(delay, self.max_backoff)

        # Add jitter (+- 20%)
        if self.jitter > 0:
            j = delay * self.jitter
            delay = delay + random.uniform(-j, j)

        actual_delay = max(delay, 0.1)  # floor at 100ms
        logger.debug(
            f"Backoff state: fail_count={self.fail_count}, next_delay={actual_delay:.2f}s"
        )
        return actual_delay

    def success(self):
        if self.fail_count > 0:
            logger.debug("Backoff reset on success")
        self.fail_count = 0

    def failure(self):
        self.fail_count += 1


class DurableBackoff:
    """Backoff that persists state to SQLite so restarts resume where they left off.

    On construction the persisted state (if any) is loaded immediately so the
    first ``next_delay()`` call after a restart returns the *remaining* wait
    time rather than the base delay.  A successful run clears the persisted
    state; a failed run writes the updated attempt count and the wall-clock
    time at which the next attempt is allowed.

    ``max_attempts`` is enforced: once exceeded the task is marked *terminal*
    and ``is_terminal`` returns ``True`` so callers can stop scheduling it.
    Pass ``max_attempts=0`` (the default) to disable the cap entirely.
    """

    MAX_ATTEMPTS_DEFAULT = 0  # 0 = unlimited

    def __init__(
        self,
        task_name: str,
        db,
        base_delay: float,
        initial_backoff: float = 2.0,
        max_backoff: float = 300.0,
        jitter: float = 0.2,
        max_attempts: int = MAX_ATTEMPTS_DEFAULT,
        clock: ClockProtocol | None = None,
    ):
        self.task_name = task_name
        self._db = db
        self.base_delay = base_delay
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff
        self.jitter = jitter
        self.max_attempts = max_attempts
        self._clock: ClockProtocol = clock if clock is not None else SystemClock()

        # In-memory state — restored from DB on construction
        self.fail_count: int = 0
        self._next_attempt_at: datetime | None = None
        self._terminal: bool = False

        self._restore()

    # ── Persistence helpers ────────────────────────────────

    def _restore(self) -> None:
        """Load persisted state from the DB (no-op if no row exists)."""
        try:
            state = self._db.get_retry_state(self.task_name)
        except Exception:
            # DB unavailable — start fresh rather than crash
            return
        if state is None:
            return

        self.fail_count = state["attempt_count"]
        self._next_attempt_at = state["next_attempt_at"]
        self._terminal = state["terminal"]
        logger.debug(
            "DurableBackoff restored: task=%s fail_count=%d terminal=%s",
            self.task_name,
            self.fail_count,
            self._terminal,
        )

    def _persist(self) -> None:
        """Write current in-memory state to the DB."""
        next_at = self._next_attempt_at or self._clock.now()
        try:
            self._db.upsert_retry_state(
                self.task_name,
                attempt_count=self.fail_count,
                next_attempt_at=next_at,
                terminal=self._terminal,
            )
        except Exception as exc:
            logger.warning("DurableBackoff: failed to persist state for %s: %s", self.task_name, exc)

    # ── Public API ─────────────────────────────────────────

    @property
    def is_terminal(self) -> bool:
        """True when max_attempts is set and has been exceeded."""
        return self._terminal

    def wait_remaining(self) -> float:
        """Seconds until the next attempt is allowed (0 if overdue or no state)."""
        if self._next_attempt_at is None:
            return 0.0
        remaining = (self._next_attempt_at - self._clock.now()).total_seconds()
        return max(remaining, 0.0)

    def next_delay(self) -> float:
        """Compute the next sleep duration (same semantics as ``Backoff.next_delay``)."""
        if self.fail_count == 0:
            return self.base_delay

        delay = self.initial_backoff * (2 ** (self.fail_count - 1))
        delay = min(delay, self.max_backoff)

        if self.jitter > 0:
            j = delay * self.jitter
            delay = delay + random.uniform(-j, j)

        actual_delay = max(delay, 0.1)
        logger.debug(
            "DurableBackoff state: task=%s fail_count=%d next_delay=%.2fs",
            self.task_name,
            self.fail_count,
            actual_delay,
        )
        return actual_delay

    def success(self) -> None:
        """Record a successful attempt: reset counters and remove persisted state."""
        if self.fail_count > 0:
            logger.debug("DurableBackoff reset on success: task=%s", self.task_name)
        self.fail_count = 0
        self._next_attempt_at = None
        self._terminal = False
        try:
            self._db.clear_retry_state(self.task_name)
        except Exception as exc:
            logger.warning("DurableBackoff: failed to clear state for %s: %s", self.task_name, exc)

    def failure(self) -> None:
        """Record a failed attempt, advance counters, and persist state."""
        self.fail_count += 1

        if self.max_attempts > 0 and self.fail_count >= self.max_attempts:
            self._terminal = True
            logger.warning(
                "DurableBackoff: task %s reached max_attempts=%d — marking terminal",
                self.task_name,
                self.max_attempts,
            )

        delay = self.next_delay()
        self._next_attempt_at = self._clock.now() + timedelta(seconds=delay)
        self._persist()

async def run(settings: Settings, agent_slot: int = 0) -> None:
    """Entry point called by `talos-agent start`. agent_slot used for log prefixes in multi mode."""
    setup_observability()
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB, get_db_path

    db = LocalDB(
        path=get_db_path(settings.talos_api_key[:16] if agent_slot > 0 else None),
        timeout_ms=settings.secret_db_timeout_ms,
    )
    if settings.secret_rotation_enabled:
        from talos_agent.secret_store import SecretStore, decode_keyring

        secret_store = SecretStore(
            db,
            keyring=decode_keyring(settings.secret_keyring),
            active_key_id=settings.secret_active_key_id,
            scope=settings.secret_scope,
            max_value_bytes=settings.secret_max_bytes,
            dual_read=settings.secret_dual_read,
            legacy_fallback=settings.secret_legacy_fallback,
        )
        settings.bind_secret_store(secret_store)
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
    from talos_agent.payments.stellar_kit import StellarKit
    from talos_agent.tools.registry import build_all_tools

    job_effect_store = None
    job_effect_dispatcher = None
    if settings.talos_durable_job_effects_enabled:
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
        job_effect_store = JobEffectStore(
            db,
            owner_talos_id=settings.talos_id,
            limits=limits,
        )
        job_effect_dispatcher = JobEffectDispatcher(job_effect_store, api)

    # Start browser session
    console.print("[bold]Starting browser session...[/bold]")
    browser_model_key = settings.llm_api_key
    browser = await BrowserSession.start(model_api_key=browser_model_key)
    console.print("[green]Browser ready.[/green]")

    # ── Policy engine (disabled by default — opt-in via config) ─────
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

    # Budget getter for policy middleware context
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
        return {
            "approval_threshold": float(settings.approval_threshold),
        }

    policy_middleware = PolicyMiddleware(
        policy_engine,
        policy_loader,
        budget_getter=_get_budget_context,
        config_getter=_get_config_context,
    )

    if policy_enabled:
        console.print("[bold cyan]Policy engine ENABLED — actions will be gated.[/bold cyan]")
    else:
        console.print("[dim]Policy engine disabled (set POLICY_ENGINE_ENABLED=true to enable).[/dim]")
    # ──────────────────────────────────────────────────────────────

    # Build tools — pass policy middleware for pre-execution policy checks
    tools = build_all_tools(api=api, db=db, browser=browser, settings=settings,
                            policy_middleware=policy_middleware)
    console.print(f"[green]Registered {len(tools)} tools.[/green]")

    # Initialize StellarKit for balance checks
    stellar = StellarKit(api)
    await stellar.initialize()

    # ── Adapter health snapshot (#421) ──────────────────────────────────
    from talos_agent.adapters.health import AdapterHealthReporter
    from talos_agent.tools.publishing import _adapter_registry

    adapter_health_reporter = AdapterHealthReporter(
        registry=_adapter_registry,
        browser=browser,
        stellar_kit=stellar,
    )
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
            console.print(f"[green]Adapter health check: {startup_health.overall.value.upper()}[/green]")
    except Exception as _health_exc:
        logger.debug("Initial adapter health check failed (non-fatal): %s", _health_exc)

    # ── Post-restore reconciliation (#296) ──────────────────────────────────
    # Reconcile backoff state, schedule timestamps, fencing tokens, and
    # completion markers before starting any tasks.  This ensures stale state
    # from a previous run (crashed or checkpointed) does not cause duplicate
    # work, stale heartbeats, or frozen backoff waits.
    from talos_agent.restore import ReconcileConfig, reconcile_after_restore

    _reconcile_config = ReconcileConfig(
        max_backoff_future_secs=3_600.0,
        backoff_cap_secs=60.0,
        max_clock_skew_secs=300.0,
        api_verify_leases=True,
        api_timeout_secs=10.0,
    )
    try:
        reconcile_result = await reconcile_after_restore(db, api, config=_reconcile_config)
        console.print(
            f"[dim cyan]Restore reconciliation: "
            f"backoff_capped={reconcile_result.backoff_rows_capped}, "
            f"schedules_reset={reconcile_result.schedules_reset}, "
            f"jobs_restored={reconcile_result.claimed_jobs_restored}, "
            f"jobs_dropped={reconcile_result.claimed_jobs_dropped}, "
            f"markers_pruned={reconcile_result.markers_pruned}"
            f"[/dim cyan]"
        )
        if reconcile_result.errors:
            console.print(
                f"[yellow]Restore reconciliation warnings ({len(reconcile_result.errors)}): "
                + "; ".join(reconcile_result.errors[:3])
                + ("[...]" if len(reconcile_result.errors) > 3 else "")
                + "[/yellow]"
            )
    except Exception as _rec_exc:
        console.print(f"[yellow]Restore reconciliation failed (non-fatal): {_rec_exc}[/yellow]")
        logger.warning("reconcile_after_restore failed: %s", _rec_exc)
    # ────────────────────────────────────────────────────────────────────────

    # Tracking restart parameters
    browser_restart_attempts = 0
    max_restart_attempts = 3
    is_degraded = False

    async def ensure_browser_healthy() -> bool:
        """Checks browser health, attempts automatic recovery, and updates tools reference."""
        nonlocal browser, tools, browser_model_key, browser_restart_attempts, is_degraded

        current_model_key = settings.llm_api_key
        if current_model_key != browser_model_key:
            # Start the replacement before swapping references. A failed
            # credential never tears down the still-working browser session.
            try:
                replacement = await BrowserSession.start(model_api_key=current_model_key)
                replacement_tools = build_all_tools(
                    api=api,
                    db=db,
                    browser=replacement,
                    settings=settings,
                )
                previous = browser
                browser = replacement
                tools = replacement_tools
                browser_model_key = current_model_key
                browser_restart_attempts = 0
                is_degraded = False
                log.info(
                    "secret_consumer_reloaded",
                    consumer="browser",
                    secret_name="llm_api_key",
                    outcome="success",
                )
                try:
                    await asyncio.wait_for(previous.close(), timeout=5)
                except Exception:
                    pass
            except Exception as exc:
                log.warning(
                    "secret_consumer_reload_failed",
                    consumer="browser",
                    secret_name="llm_api_key",
                    outcome="failure",
                    error_type=type(exc).__name__,
                )

        if is_degraded:
            return False

        is_healthy = False
        if browser is not None:
            try:
                if hasattr(browser, "context") and browser.context:
                    is_healthy = True
            except Exception:
                is_healthy = False

        if is_healthy:
            return True

        console.print("[yellow]Browser session health check failed. Attempting recovery...[/yellow]")
        while browser_restart_attempts < max_restart_attempts:
            browser_restart_attempts += 1
            console.print(f"[bold yellow]Attempting browser reconnection ({browser_restart_attempts}/{max_restart_attempts})...[/bold yellow]")
            
            try:
                if browser:
                    try:
                        await asyncio.wait_for(browser.close(), timeout=3)
                    except Exception:
                        pass
                
                browser = await BrowserSession.start(model_api_key=settings.llm_api_key)
                tools = build_all_tools(
                    api=api,
                    db=db,
                    browser=browser,
                    settings=settings,
                    job_effect_store=job_effect_store,
                    job_effect_dispatcher=job_effect_dispatcher,
                )
                
                console.print(f"[bold green]Browser reconnection event logged successfully on attempt {browser_restart_attempts}.[/bold green]")
                return True
            except Exception as restart_err:
                console.print(f"[red]Browser reconnection failed on attempt {browser_restart_attempts}: {restart_err}[/red]")
                await asyncio.sleep(2)

        console.print("[bold red]Maximum browser restart attempts reached. Marking agent runtime status as degraded.[/bold red]")
        is_degraded = True
        try:
            await api.update_status(settings.talos_id, online=True)
        except Exception:
            pass
        return False

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
                        context = AgentContext.from_db(db, talos_config)

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

                    # ── Record error ─────────────────────────────────────────
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

    async def polling_task():
        """Poll Web API for approvals and commerce jobs."""
        backoff = DurableBackoff(task_name="polling", db=db, base_delay=settings.polling_interval)
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
                                log.warning(
                                    "job_inbox_rejected",
                                    error_code=exc.code,
                                )
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
                await asyncio.wait_for(shutdown_event.wait(), timeout=backoff.next_delay())
                break
            except asyncio.TimeoutError:
                pass

    async def heartbeat_task():
        """Report online status periodically."""
        backoff = DurableBackoff(task_name="heartbeat", db=db, base_delay=settings.heartbeat_interval)
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
                await asyncio.wait_for(shutdown_event.wait(), timeout=backoff.next_delay())
                break
            except asyncio.TimeoutError:
                pass

    async def job_heartbeat_task():
        """Extend leases on claimed jobs periodically."""
        from talos_agent.tools.commerce import get_claimed_jobs_copy
        backoff = DurableBackoff(task_name="job_heartbeat", db=db, base_delay=settings.job_heartbeat_interval)
        while not shutdown_event.is_set():
            try:
                claimed = (
                    job_effect_store.claimed_jobs()
                    if job_effect_store is not None
                    else get_claimed_jobs_copy()
                )
                for job_id, fencing_token in claimed.items():
                    result = await api.heartbeat_job(job_id, fencing_token)
                    if not result:
                        logger.warning("job_lease_heartbeat_failed", job_id=job_id)
                backoff.success()
            except Exception as e:
                logger.debug(f"Job heartbeat error: {e}")
                backoff.failure()

            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=backoff.next_delay())
                break
            except asyncio.TimeoutError:
                pass

    async def job_effect_dispatch_task():
        """Recover and dispatch durable provider-job effects."""
        if job_effect_dispatcher is None:
            return
        backoff = DurableBackoff(
            task_name="job_effect_dispatch",
            db=db,
            base_delay=settings.talos_job_effect_dispatch_interval,
        )
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
                # Error details can contain driver or remote payload fragments.
                # Emit only a stable code and let the next bounded scan retry.
                log.error("job_effect_dispatch_batch_failed", error_code="batch_failure")
                backoff.failure()
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=backoff.next_delay())
                break
            except asyncio.TimeoutError:
                pass

    async def activity_flush_task():
        """Flush buffered activity logs to Web API."""
        backoff = DurableBackoff(task_name="activity_flush", db=db, base_delay=30)
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
                await asyncio.wait_for(shutdown_event.wait(), timeout=backoff.next_delay())
                break
            except asyncio.TimeoutError:
                pass

    async def learning_cycle_task():
        """Run a dedicated learning cycle every 6 hours: measure → review → evolve."""
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
                            context = AgentContext.from_db(db, talos_config)

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

    async def dividend_distribution_task():
        """Periodically check USDC balance and distribute dividends to patrons when threshold is met."""
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
                if last_run:
                    elapsed = (datetime.now(timezone.utc) - last_run).total_seconds()
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

    async def loan_repayment_task():
        """Monitor and auto-repay loan interests from generated revenues. Runs every 24 hours."""
        repayment_interval = 24 * 3600

        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=repayment_interval)
            return
        except asyncio.TimeoutError:
            pass

        from talos_agent.payments.stellar_kit import StellarKit

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

    async def telemetry_log_task():
        """Periodically log runtime telemetry for operator observability.

        Privacy-safe: no prompts, API keys, signatures, or wallet secrets
        are included in the output.

        Runs once every 30 minutes (or immediately after the first cycle
        completes so startup state is captured).
        """
        from talos_agent.telemetry import TelemetryCollector

        telemetry_interval = 30 * 60  # 30 minutes

        # Wait for initial startup to settle
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

    tasks = [
        asyncio.create_task(agent_cycle_task(), name="agent_cycle"),
        asyncio.create_task(polling_task(), name="polling"),
        asyncio.create_task(heartbeat_task(), name="heartbeat"),
        asyncio.create_task(job_heartbeat_task(), name="job_heartbeat"),
        asyncio.create_task(activity_flush_task(), name="activity_flush"),
        asyncio.create_task(learning_cycle_task(), name="learning_cycle"),
        asyncio.create_task(dividend_distribution_task(), name="dividend_distribution"),
        asyncio.create_task(loan_repayment_task(), name="loan_repayment"),
        asyncio.create_task(telemetry_log_task(), name="telemetry_log"),
    ]
    if job_effect_dispatcher is not None:
        tasks.append(
            asyncio.create_task(job_effect_dispatch_task(), name="job_effect_dispatch")
        )

    try:
        await shutdown_event.wait()

        # ── Graceful shutdown (#182) ──────────────────────────────────────
        # Stop polling: shutdown_event is already set so each task's inner
        # wait() will break on the next iteration without starting new work.
        #
        # Wait up to shutdown_deadline seconds for running tasks to finish
        # naturally before we force-cancel them.
        deadline = settings.shutdown_deadline
        if deadline > 0:
            console.print(
                f"[yellow]Waiting up to {deadline:.0f}s for in-flight tasks to finish...[/yellow]"
            )
            try:
                await asyncio.wait_for(
                    asyncio.shield(asyncio.gather(*tasks, return_exceptions=True)),
                    timeout=deadline,
                )
                console.print("[green]All tasks finished within deadline.[/green]")
            except asyncio.TimeoutError:
                still_running = [t for t in tasks if not t.done()]
                console.print(
                    f"[red]Deadline exceeded — cancelling {len(still_running)} task(s): "
                    + ", ".join(t.get_name() for t in still_running)
                    + "[/red]"
                )
                # Record each cancelled task so operators can inspect what was cut short.
                for t in still_running:
                    try:
                        db.add_activity(
                            "shutdown_cancelled",
                            f"Task '{t.get_name()}' was cancelled at shutdown (deadline={deadline:.0f}s)",
                            "system",
                        )
                    except Exception:
                        pass
                for t in still_running:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        else:
            # Immediate cancel when deadline == 0.
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        # ─────────────────────────────────────────────────────────────────
    finally:
        console.print("[yellow]Cleaning up...[/yellow]")
        try:
            await asyncio.wait_for(api.update_status(settings.talos_id, online=False), timeout=5)
        except Exception:
            pass
        try:
            if browser:
                await asyncio.wait_for(browser.close(), timeout=5)
        except Exception:
            pass
        await api.close()
        db.close()
        # Flush any spans/metrics buffered by the batch processors before exit
        # so a graceful shutdown doesn't drop the last few seconds of data.
        force_flush_tracing()
        metrics.force_flush_metrics()
        shutdown_tracing()
        metrics.shutdown_metrics()
        console.print("[bold]Agent stopped.[/bold]")


async def run_multi(base_settings: Settings, api_keys: list[str]) -> None:
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
