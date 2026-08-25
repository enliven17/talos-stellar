"""Tests for adapter retry budgets and circuit admission."""

from __future__ import annotations

import asyncio

import pytest

from talos_agent.circuit_breaker import (
    CircuitBreakerConfig,
    CircuitState,
    ProviderCircuitBreaker,
    execute_with_retry,
)
from talos_agent.config import Settings


@pytest.mark.asyncio
async def test_retry_budget_uses_exponential_backoff_and_records_final_failure():
    breaker = ProviderCircuitBreaker(
        "discord",
        CircuitBreakerConfig(
            retry_budget=2,
            backoff_initial=0.25,
            backoff_max=1.0,
            failure_threshold=1,
        ),
    )
    delays: list[float] = []
    calls = 0

    async def operation() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("temporary failure")

    async def record_delay(delay: float) -> None:
        delays.append(delay)

    with pytest.raises(RuntimeError):
        await execute_with_retry(operation, breaker, sleep=record_delay)

    assert calls == 3
    assert delays == [0.25, 0.5]
    assert breaker.state == CircuitState.OPEN
    assert breaker.metrics().total_failures == 1


@pytest.mark.asyncio
async def test_success_resets_budget_after_half_open_probe():
    breaker = ProviderCircuitBreaker(
        "telegram",
        CircuitBreakerConfig(
            failure_threshold=1,
            recovery_timeout=0.01,
            success_threshold=1,
            retry_budget=1,
        ),
    )
    await breaker.record_failure()
    await asyncio.sleep(0.02)

    assert await breaker.allow_request()
    await breaker.record_success()
    assert breaker.state == CircuitState.CLOSED
    assert breaker.failures_in_window() == 0


@pytest.mark.asyncio
async def test_concurrent_half_open_calls_are_limited_to_probes():
    breaker = ProviderCircuitBreaker(
        "x",
        CircuitBreakerConfig(
            failure_threshold=1,
            recovery_timeout=0.01,
            half_open_max_probes=2,
        ),
    )
    await breaker.record_failure()
    await asyncio.sleep(0.02)

    allowed = await asyncio.gather(*(breaker.allow_request() for _ in range(8)))
    assert sum(allowed) == 2
    assert breaker.metrics().total_rejected == 6


def test_config_validation_and_restart_defaults():
    with pytest.raises(ValueError):
        CircuitBreakerConfig(retry_budget=-1)
    with pytest.raises(ValueError):
        CircuitBreakerConfig(backoff_initial=2, backoff_max=1)

    first = ProviderCircuitBreaker("new-adapter")
    second = ProviderCircuitBreaker("new-adapter")
    assert first.state == second.state == CircuitState.CLOSED
    assert first.config == second.config == CircuitBreakerConfig()


def test_settings_validate_per_adapter_retry_configuration():
    settings = Settings(
        _env_file=None,
        adapter_retry_configs={
            "Discord": {
                "retry_budget": 4,
                "backoff_initial": 0.5,
                "backoff_max": 8,
            }
        },
    )
    assert settings.adapter_retry_configs["discord"]["retry_budget"] == 4

    with pytest.raises(ValueError):
        Settings(_env_file=None, adapter_retry_configs={"discord": {"retry_budget": -1}})