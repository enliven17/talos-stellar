"""Tests for scheduler — lock, shutdown, heartbeat, dividend distribution."""

from __future__ import annotations

import asyncio
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from zoneinfo import ZoneInfo

import pytest

from talos_agent.config import Settings
from talos_agent.scheduler import (
    MIN_RECURRING_TASK_INTERVAL_SECONDS,
    check_should_run,
    plan_interval_runs,
    run_dividend_distribution,
    run_loan_repayment,
    validate_recurring_task_interval,
)
from talos_agent.scheduler import runner as scheduler_runner
from talos_agent.scheduler import tasks as scheduler_tasks
from talos_agent.scheduler.tasks import _task_slot


class FixedClock:
    def __init__(self, now: datetime):
        self._now = now

    def now_utc(self) -> datetime:
        return self._now


# ── Scheduler core tests ───────────────────────────────────────────────────────

def test_recurring_interval_rejects_values_below_supported_minimum():
    with pytest.raises(ValueError, match="at least 1 seconds"):
        validate_recurring_task_interval("dividend_distribution", 0.5)


def test_recurring_interval_accepts_supported_boundary():
    validate_recurring_task_interval(
        "dividend_distribution",
        MIN_RECURRING_TASK_INTERVAL_SECONDS,
    )─

def test_check_should_run_uses_clock_and_utc_boundaries():
    clock = FixedClock(datetime(2024, 1, 2, 6, 0, 0, tzinfo=timezone.utc))

    assert check_should_run(
        now=clock.now_utc(),
        last_run=datetime(2024, 1, 1, 5, 59, 59, tzinfo=timezone.utc),
        interval_seconds=3600,
        clock=clock,
    ) is True

    assert check_should_run(
        now=clock.now_utc(),
        last_run=datetime(2024, 1, 2, 5, 59, 59, tzinfo=timezone.utc),
        interval_seconds=3600,
        clock=clock,
    ) is False


def test_check_should_run_respects_configured_timezone_boundary():
    clock = FixedClock(datetime(2024, 1, 2, 17, 0, 0, tzinfo=timezone.utc))

    assert check_should_run(
        now=clock.now_utc(),
        last_run=datetime(2024, 1, 1, 8, 59, 0, tzinfo=timezone.utc),
        schedule_time=time(9, 0),
        timezone_name="America/Los_Angeles",
        clock=clock,
    ) is True


def test_check_should_run_handles_dst_gap_and_overlap():
    try:
        la_tz = ZoneInfo("America/Los_Angeles")
        ny_tz = ZoneInfo("America/New_York")
    except Exception:
        pytest.skip("tzdata not available on this platform")
    gap_now = datetime(2024, 3, 10, 3, 30, 0, tzinfo=la_tz)
    overlap_now = datetime(2024, 11, 3, 1, 30, 0, tzinfo=ny_tz)

    assert check_should_run(
        now=gap_now,
        last_run=gap_now - timedelta(hours=1),
        schedule_time=time(2, 30),
        timezone_name="America/Los_Angeles",
    ) is True

    assert check_should_run(
        now=overlap_now,
        last_run=overlap_now - timedelta(hours=1),
        schedule_time=time(1, 30),
        timezone_name="America/New_York",
    ) is True


@pytest.mark.parametrize(
    ("policy", "expected_runs"),
    [("skip", 0), ("coalesce", 1), ("catch_up", 3)],
)
def test_plan_interval_runs_distinguishes_missed_run_policies(policy, expected_runs):
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    last_run = now - timedelta(seconds=550)

    decision = plan_interval_runs(
        now,
        last_run,
        interval_seconds=100,
        policy=policy,
        max_catch_up_runs=3,
    )

    assert decision.due_runs == 5
    assert decision.runs_to_execute == expected_runs
    assert decision.lateness_seconds == pytest.approx(450)
    assert decision.policy == policy


def test_skip_policy_runs_single_due_interval_at_boundary():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    decision = plan_interval_runs(
        now,
        now - timedelta(seconds=100),
        interval_seconds=100,
        policy="skip",
    )

    assert decision.due_runs == 1
    assert decision.runs_to_execute == 1
    assert decision.lateness_seconds == 0


def test_plan_interval_runs_waits_until_next_interval():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    decision = plan_interval_runs(
        now,
        now - timedelta(seconds=99),
        interval_seconds=100,
        policy="catch_up",
    )

    assert decision.due_runs == 0
    assert decision.runs_to_execute == 0
    assert decision.next_run_in_seconds == 1


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"policy": "replay"}, "policy must be"),
        ({"max_catch_up_runs": 0}, "max_catch_up_runs must be"),
        ({"max_catch_up_runs": True}, "max_catch_up_runs must be"),
        ({"max_catch_up_runs": 11}, "max_catch_up_runs must be"),
    ],
)
def test_plan_interval_runs_rejects_invalid_policy_options(kwargs, message):
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    with pytest.raises(ValueError, match=message):
        plan_interval_runs(now, None, interval_seconds=100, **kwargs)


def test_plan_interval_runs_rejects_unrepresentable_interval():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    with pytest.raises(ValueError, match="interval_seconds must be"):
        plan_interval_runs(now, None, interval_seconds=10**1000)


def test_plan_interval_runs_bounds_extreme_backlog():
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    decision = plan_interval_runs(
        now,
        now - timedelta(seconds=1),
        interval_seconds=1e-320,
        policy="catch_up",
        max_catch_up_runs=3,
    )

    assert decision.due_runs > 3
    assert decision.runs_to_execute == 3


def test_scheduler_missed_run_settings_are_validated():
    settings = Settings(_env_file=None)
    assert settings.scheduler_missed_run_policy == "coalesce"
    assert settings.scheduler_max_catch_up_runs == 3

    with pytest.raises(ValueError):
        Settings(_env_file=None, scheduler_missed_run_policy="replay")
    with pytest.raises(ValueError):
        Settings(_env_file=None, scheduler_max_catch_up_runs=11)


@pytest.mark.parametrize(
    ("policy", "expected_runs"),
    [("skip", 0), ("coalesce", 1), ("catch_up", 3)],
)
@pytest.mark.asyncio
async def test_dividend_task_executes_missed_runs_according_to_policy(
    policy, expected_runs, monkeypatch
):
    from talos_agent.scheduler import tasks

    interval = 3600
    now = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    db = MagicMock()
    db.get_last_run.return_value = now - timedelta(seconds=interval * 5 + interval // 2)
    settings = MagicMock()
    settings.dividend_distribution_interval = interval
    settings.scheduler_missed_run_policy = policy
    settings.scheduler_max_catch_up_runs = 3
    settings.dividend_usdc_threshold = 100
    settings.talos_id = "test-talos"
    shutdown_event = asyncio.Event()
    run_distribution = AsyncMock(return_value="success")
    lateness_records = []
    wait_calls = 0

    async def fake_wait_for(awaitable, timeout):
        nonlocal wait_calls
        wait_calls += 1
        awaitable.close()
        if wait_calls == 1:
            raise asyncio.TimeoutError
        shutdown_event.set()
        return True

    monkeypatch.setattr(tasks, "run_dividend_distribution", run_distribution)
    monkeypatch.setattr(
        tasks.metrics,
        "record_schedule_lateness",
        lambda task, selected_policy, lateness: lateness_records.append(
            (task, selected_policy, lateness)
        ),
    )
    monkeypatch.setattr(tasks.asyncio, "wait_for", fake_wait_for)

    await tasks.dividend_distribution_task(
        shutdown_event=shutdown_event,
        settings=settings,
        stellar=MagicMock(),
        api=MagicMock(),
        db=db,
        talos_config={},
        effective_clock=FixedClock(now),
    )

    assert run_distribution.await_count == expected_runs
    assert lateness_records == [
        ("dividend_distribution", policy, interval * 4 + interval // 2)
    ]
    assert db.update_schedule.call_count == (1 if policy == "skip" else 0)


@pytest.mark.asyncio
async def test_agent_lock_prevents_concurrent_execution():
    """Two coroutines competing for a lock should not interleave."""
    lock = asyncio.Lock()
    execution_log: list[str] = []

    async def worker(name: str):
        async with lock:
            execution_log.append(f"{name}-start")
            await asyncio.sleep(0.05)
            execution_log.append(f"{name}-end")

    await asyncio.gather(worker("A"), worker("B"))

    assert execution_log[0].endswith("-start")
    assert execution_log[1].endswith("-end")
    assert execution_log[0][0] == execution_log[1][0]


@pytest.mark.asyncio
async def test_shutdown_event_stops_task():
    """A task checking shutdown_event should exit promptly."""
    shutdown = asyncio.Event()
    iterations = 0

    async def loop():
        nonlocal iterations
        while not shutdown.is_set():
            iterations += 1
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=0.01)
                break
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(loop())
    await asyncio.sleep(0.05)
    shutdown.set()
    await task
    assert iterations >= 1


@pytest.mark.asyncio
async def test_shutdown_stops_multiple_tasks():
    """Multiple tasks should all stop when shutdown is set."""
    shutdown = asyncio.Event()
    stopped: list[str] = []

    async def worker(name: str):
        while not shutdown.is_set():
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=0.01)
                break
            except asyncio.TimeoutError:
                pass
        stopped.append(name)

    tasks = [asyncio.create_task(worker(n)) for n in ["A", "B", "C"]]
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.gather(*tasks)
    assert sorted(stopped) == ["A", "B", "C"]


@pytest.mark.asyncio
async def test_task_slots_bound_concurrent_work():
    slots = asyncio.BoundedSemaphore(2)
    shutdown = asyncio.Event()
    release = asyncio.Event()
    both_started = asyncio.Event()
    active = 0
    peak_active = 0

    async def worker():
        nonlocal active, peak_active
        async with _task_slot(slots, shutdown) as acquired:
            assert acquired
            active += 1
            peak_active = max(peak_active, active)
            if active == 2:
                both_started.set()
            await release.wait()
            active -= 1

    workers = [asyncio.create_task(worker()) for _ in range(5)]
    await asyncio.wait_for(both_started.wait(), timeout=1)
    assert active == 2
    release.set()
    await asyncio.gather(*workers)

    assert peak_active == 2
    assert active == 0


@pytest.mark.asyncio
async def test_task_slot_shutdown_and_cancellation_release_capacity():
    slots = asyncio.BoundedSemaphore(1)
    holder_entered = asyncio.Event()
    holder_shutdown = asyncio.Event()
    waiting_shutdown = asyncio.Event()

    async def hold_slot():
        async with _task_slot(slots, holder_shutdown) as acquired:
            assert acquired
            holder_entered.set()
            await asyncio.Event().wait()

    async def wait_for_slot():
        async with _task_slot(slots, waiting_shutdown) as acquired:
            return acquired

    holder = asyncio.create_task(hold_slot())
    await holder_entered.wait()
    waiter = asyncio.create_task(wait_for_slot())
    await asyncio.sleep(0)
    waiting_shutdown.set()
    assert await asyncio.wait_for(waiter, timeout=1) is False

    holder.cancel()
    with pytest.raises(asyncio.CancelledError):
        await holder

    async with _task_slot(slots, asyncio.Event()) as acquired:
        assert acquired


@pytest.mark.asyncio
async def test_polling_wait_does_not_hold_task_slot(monkeypatch):
    class NoWaitBackoff:
        def __init__(self, **kwargs):
            pass

        def wait_remaining(self):
            return 0

        def success(self):
            pass

        def delay_until_next_attempt(self):
            return 3600

    monkeypatch.setattr(scheduler_tasks, "DurableBackoff", NoWaitBackoff)
    shutdown = asyncio.Event()
    slots = asyncio.BoundedSemaphore(1)
    poll_completed = asyncio.Event()
    api = MagicMock()
    api.get_approvals = AsyncMock(return_value=[])

    async def get_pending_jobs():
        poll_completed.set()
        return []

    api.get_pending_jobs = AsyncMock(side_effect=get_pending_jobs)
    settings = MagicMock(polling_interval=1, talos_id="agent-1")

    polling = asyncio.create_task(
        scheduler_tasks.polling_task(
            shutdown_event=shutdown,
            settings=settings,
            api=api,
            db=MagicMock(),
            talos_config={},
            job_effect_store=None,
            task_slots=slots,
        )
    )
    await asyncio.wait_for(poll_completed.wait(), timeout=1)

    assert await asyncio.wait_for(slots.acquire(), timeout=1)
    slots.release()
    shutdown.set()
    await asyncio.wait_for(polling, timeout=1)


@pytest.mark.asyncio
async def test_task_list_gets_a_distinct_limiter_per_agent(monkeypatch):
    observed_slots = []
    task_names = (
        "activity_flush_task",
        "agent_cycle_task",
        "dividend_distribution_task",
        "heartbeat_task",
        "job_heartbeat_task",
        "learning_cycle_task",
        "loan_repayment_task",
        "polling_task",
        "telemetry_log_task",
    )

    for task_name in task_names:
        async def capture(**kwargs):
            observed_slots.append(
                (kwargs["settings"].talos_id, kwargs.get("task_slots"))
            )

        monkeypatch.setattr(scheduler_tasks, task_name, capture)

    def build_tasks(agent_id):
        return scheduler_runner._build_task_list(
            shutdown_event=asyncio.Event(),
            shutdown_drain_complete=asyncio.Event(),
            settings=SimpleNamespace(
                scheduler_max_concurrent_tasks=2,
                talos_id=agent_id,
            ),
            api=object(),
            db=object(),
            talos_config={},
            agent_lock=asyncio.Lock(),
            tools=object(),
            stellar=object(),
            policy_engine=object(),
            policy_middleware=object(),
            ensure_browser_healthy=object(),
            effective_clock=object(),
            job_effect_store=None,
            job_effect_dispatcher=None,
            telegram_queue_worker=None,
            adapter_health_reporter=object(),
        )

    first_agent_tasks = build_tasks("agent-1")
    await asyncio.gather(*first_agent_tasks)
    second_agent_tasks = build_tasks("agent-2")
    await asyncio.gather(*second_agent_tasks)

    first_agent_slots = [slots for agent, slots in observed_slots if agent == "agent-1"]
    second_agent_slots = [slots for agent, slots in observed_slots if agent == "agent-2"]
    first_limiter_ids = {id(slots) for slots in first_agent_slots if slots is not None}
    second_limiter_ids = {id(slots) for slots in second_agent_slots if slots is not None}

    assert len(first_limiter_ids) == 1
    assert len(second_limiter_ids) == 1
    assert first_limiter_ids.isdisjoint(second_limiter_ids)
    assert first_agent_slots.count(None) == 2
    assert second_agent_slots.count(None) == 2


# ── Dividend distribution helper tests ────────────────────────────────────────

def _make_deps(
    *,
    wallet_public_key="GABC123",
    creator_public_key="GCREATOR456",
    usdc_balance=150.0,
    threshold=100.0,
    balance_error=False,
    preview=None,
    distribute_result=None,
):
    """Build mock dependencies for run_dividend_distribution."""
    talos_config = {
        "walletPublicKey": wallet_public_key,
        "creatorPublicKey": creator_public_key,
    }

    settings = MagicMock()
    settings.dividend_usdc_threshold = threshold

    stellar = MagicMock()
    if balance_error:
        stellar.get_token_balance = AsyncMock(return_value={"error": "Horizon timeout"})
    else:
        stellar.get_token_balance = AsyncMock(return_value={"balance": usdc_balance})

    api = MagicMock()
    api.get_distribution_preview = AsyncMock(
        return_value=preview if preview is not None else {
            "distributableAmount": 50.0,
            "breakdown": [{"patron": "GPATRON1", "amount": 50.0}],
        }
    )
    api.distribute_dividends = AsyncMock(
        return_value=distribute_result if distribute_result is not None else {
            "message": "Distribution complete",
        }
    )

    db = MagicMock()
    db.update_schedule = MagicMock()

    return talos_config, settings, stellar, api, db


@pytest.mark.asyncio
async def test_dividend_missing_wallet_returns_no_wallet():
    """Missing walletPublicKey should return 'no_wallet' without calling API."""
    talos_config, settings, stellar, api, db = _make_deps(wallet_public_key="")

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "no_wallet"
    stellar.get_token_balance.assert_not_called()
    api.get_distribution_preview.assert_not_called()
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_below_threshold_skips_distribution():
    """Balance below threshold should return 'below_threshold' without distributing."""
    talos_config, settings, stellar, api, db = _make_deps(usdc_balance=50.0, threshold=100.0)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "below_threshold"
    api.get_distribution_preview.assert_not_called()
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_horizon_failure_returns_balance_error():
    """Horizon API error should return 'balance_error' and advance schedule."""
    talos_config, settings, stellar, api, db = _make_deps(balance_error=True)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "balance_error"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_called_once_with("dividend_distribution")


@pytest.mark.asyncio
async def test_dividend_preview_failure_aborts_distribution():
    """Failed preview should return 'preview_failed' without calling distribute."""
    talos_config, settings, stellar, api, db = _make_deps(
        preview={"error": "No patrons found"}
    )

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "preview_failed"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_none_preview_aborts_distribution():
    """None preview response should return 'preview_failed' without calling distribute."""
    talos_config, settings, _stellar, api, db = _make_deps(preview=False)

    # Force None from the mock
    stellar2 = MagicMock()
    stellar2.get_token_balance = AsyncMock(return_value={"balance": 150.0})
    api.get_distribution_preview = AsyncMock(return_value=None)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar2,
        api=api,
        db=db,
    )

    assert result == "preview_failed"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_distribute_failure_returns_distribution_failed():
    """Failed distribute call should return 'distribution_failed' without updating schedule."""
    talos_config, settings, stellar, api, db = _make_deps(
        distribute_result={"error": "Unauthorized"}
    )

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "distribution_failed"
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_success_updates_schedule():
    """Successful distribution should return 'success' and update the schedule."""
    talos_config, settings, stellar, api, db = _make_deps()

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "success"
    api.distribute_dividends.assert_called_once_with(
        "talos-1", requester_public_key="GCREATOR456"
    )
    db.update_schedule.assert_called_once_with("dividend_distribution")


@pytest.mark.asyncio
async def test_dividend_uses_creator_public_key_not_wallet():
    """distribute_dividends must be called with creatorPublicKey, not walletPublicKey."""
    talos_config, settings, stellar, api, db = _make_deps(
        wallet_public_key="GWALLET999",
        creator_public_key="GCREATOR456",
    )

    await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    call_kwargs = api.distribute_dividends.call_args
    assert call_kwargs.kwargs["requester_public_key"] == "GCREATOR456"
    assert call_kwargs.kwargs["requester_public_key"] != "GWALLET999"

@pytest.mark.asyncio
async def test_dividend_missing_creator_aborts_before_distribute():
    """Missing creatorPublicKey should abort before distribute_dividends is called."""
    talos_config, settings, stellar, api, db = _make_deps(creator_public_key="")

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "missing_creator"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


def _make_loan_deps(*, loans=None, auto_repay=True, balance=150.0, transfer_result=None):
    settings = MagicMock()
    settings.auto_repay_loans = auto_repay

    stellar_kit = MagicMock()
    stellar_kit.initialize = AsyncMock()
    stellar_kit.get_balance = AsyncMock(return_value={"balance_xlm": balance})

    api = MagicMock()
    api.request_transfer = AsyncMock(
        return_value=transfer_result if transfer_result is not None else {"tx_hash": "tx_abc"}
    )

    db = MagicMock()
    db.get_loans_due_soon = MagicMock(return_value=loans or [])
    db.add_activity = MagicMock()
    db.update_schedule = MagicMock()
    db.record_repayment = MagicMock()

    return settings, stellar_kit, api, db


@pytest.mark.asyncio
async def test_loan_repayment_disabled_logs_warning_without_transfer():
    loan = {
        "id": 1,
        "outstanding_amount": 25.0,
        "loan_asset": "XLM",
        "repayment_address": "G" + "A" * 55,
    }
    settings, stellar_kit, api, db = _make_loan_deps(loans=[loan], auto_repay=False)

    result = await run_loan_repayment(
        settings=settings,
        stellar_kit=stellar_kit,
        api=api,
        db=db,
    )

    assert result["warnings"] == 1
    stellar_kit.initialize.assert_not_called()
    api.request_transfer.assert_not_called()
    db.update_schedule.assert_called_once_with("loan_repayment")


@pytest.mark.asyncio
async def test_loan_repayment_requires_valid_repayment_address():
    loan = {
        "id": 2,
        "outstanding_amount": 25.0,
        "loan_asset": "XLM",
        "repayment_address": "aave",
    }
    settings, stellar_kit, api, db = _make_loan_deps(loans=[loan])

    result = await run_loan_repayment(
        settings=settings,
        stellar_kit=stellar_kit,
        api=api,
        db=db,
    )

    assert result["warnings"] == 1
    api.request_transfer.assert_not_called()
    db.record_repayment.assert_not_called()
    db.update_schedule.assert_called_once_with("loan_repayment")


@pytest.mark.asyncio
async def test_loan_repayment_records_success_to_repayment_address():
    repayment_address = "G" + "A" * 55
    loan = {
        "id": 3,
        "outstanding_amount": 40.0,
        "loan_asset": "XLM",
        "repayment_address": repayment_address,
    }
    settings, stellar_kit, api, db = _make_loan_deps(loans=[loan], balance=100.0)

    result = await run_loan_repayment(
        settings=settings,
        stellar_kit=stellar_kit,
        api=api,
        db=db,
    )

    assert result["repaid"] == 1
    api.request_transfer.assert_called_once_with(
        to_account=repayment_address,
        amount=40.0,
        currency="XLM",
    )
    db.record_repayment.assert_called_once_with(3, 40.0, tx_hash="tx_abc")
    db.update_schedule.assert_called_once_with("loan_repayment")


@pytest.mark.asyncio
async def test_loan_repayment_transfer_failure_does_not_record_repayment():
    loan = {
        "id": 4,
        "outstanding_amount": 40.0,
        "loan_asset": "XLM",
        "repayment_address": "G" + "A" * 55,
    }
    settings, stellar_kit, api, db = _make_loan_deps(
        loans=[loan],
        transfer_result={"error": "transfer denied"},
    )

    result = await run_loan_repayment(
        settings=settings,
        stellar_kit=stellar_kit,
        api=api,
        db=db,
    )

    assert result["errors"] == 1
    db.record_repayment.assert_not_called()
    db.add_activity.assert_any_call(
        "loan_error",
        "Auto-repay failed for loan 4: transfer denied",
        "defi",
    )
