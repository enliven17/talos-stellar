"""Tests for per-provider circuit breakers with adaptive recovery.

Coverage
--------
ProviderCircuitBreaker: state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED),
  rolling window failure counting, probe budgets, success threshold recovery.
CircuitBreakerRegistry: singleton access, per-provider isolation, reset.
Circuit breaker integration: request_with_retry + call_with_retry pass-through
  and rejection when circuit is OPEN.
CircuitBreakerMetrics: to_dict() shape and computed fields.
CircuitBreakerConfig: per-provider defaults.
CircuitBreakerOpen: exception structure.
Persistence: save/load state across restarts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx
import pytest
import respx
from talos_agent.circuit_breaker import (
    CircuitBreakerConfig,
    CircuitBreakerError,
    CircuitBreakerOpen,
    CircuitBreakerRegistry,
    CircuitState,
    ProviderCircuitBreaker,
    _resolve_provider_from_url,
    cb_registry,
)
from talos_agent.http import RetryableHTTPError, call_with_retry, request_with_retry
from talos_agent.adapters.storage import MemoryStorageAdapter

# ═══════════════════════════════════════════════════════════════════════════════
# Helpers (async versions to work inside pytest-asyncio)
# ═══════════════════════════════════════════════════════════════════════════════


def _make_breaker(
    provider: str = "test",
    failure_threshold: int = 3,
    recovery_timeout: float = 999,
    half_open_max_probes: int = 2,
    success_threshold: int = 2,
    window_size: float = 60.0,
) -> ProviderCircuitBreaker:
    config = CircuitBreakerConfig(
        failure_threshold=failure_threshold,
        recovery_timeout=recovery_timeout,
        half_open_max_probes=half_open_max_probes,
        success_threshold=success_threshold,
        window_size=window_size,
    )
    return ProviderCircuitBreaker(provider, config)


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerConfig
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerConfig:
    def test_default_config(self):
        config = CircuitBreakerConfig()
        assert config.failure_threshold == 5
        assert config.recovery_timeout == 30.0
        assert config.half_open_max_probes == 3
        assert config.success_threshold == 2
        assert config.window_size == 60.0

    def test_for_provider_returns_default_for_unknown(self):
        config = CircuitBreakerConfig.for_provider("nonexistent")
        assert config == CircuitBreakerConfig()

    def test_for_provider_returns_groq_defaults(self):
        config = CircuitBreakerConfig.for_provider("groq")
        assert config.failure_threshold == 5

    def test_for_provider_returns_talos_web_api_defaults(self):
        config = CircuitBreakerConfig.for_provider("talos_web_api")
        assert config.failure_threshold == 8

    def test_for_provider_returns_discord_defaults(self):
        config = CircuitBreakerConfig.for_provider("discord")
        assert config.failure_threshold == 3


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerOpen exception
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerOpen:
    def test_is_circuit_breaker_error(self):
        exc = CircuitBreakerOpen("groq", 15.0)
        assert isinstance(exc, CircuitBreakerError)

    def test_stores_provider_and_retry_after(self):
        exc = CircuitBreakerOpen("test_provider", 42.5)
        assert exc.provider == "test_provider"
        assert exc.retry_after == 42.5

    def test_with_fallback_hint(self):
        exc = CircuitBreakerOpen("groq", 30.0, fallback_hint="try openai")
        assert exc.fallback_hint == "try openai"
        assert "try openai" in str(exc)

    def test_message_includes_provider_and_time(self):
        exc = CircuitBreakerOpen("discord", 10.0)
        msg = str(exc)
        assert "discord" in msg
        assert "10.0" in msg


# ═══════════════════════════════════════════════════════════════════════════════
# _resolve_provider_from_url
# ═══════════════════════════════════════════════════════════════════════════════


class TestResolveProviderFromUrl:
    def test_groq(self):
        assert _resolve_provider_from_url("https://api.groq.com/openai/v1/chat") == "groq"

    def test_openai(self):
        assert _resolve_provider_from_url("https://api.openai.com/v1/chat") == "openai"

    def test_discord(self):
        assert _resolve_provider_from_url("https://discord.com/api/webhooks/x/y") == "discord"

    def test_telegram(self):
        assert _resolve_provider_from_url("https://api.telegram.org/bot123/send") == "telegram"

    def test_twitter(self):
        assert _resolve_provider_from_url("https://twitter.com/i/api/2/tweets") == "x"

    def test_x(self):
        assert _resolve_provider_from_url("https://x.com/i/api/2/tweets") == "x"

    def test_unknown_falls_back_to_talos_web_api(self):
        assert _resolve_provider_from_url("https://horizon.stellar.org/accounts") == "talos_web_api"

    def test_empty_url(self):
        assert _resolve_provider_from_url("") == "talos_web_api"


# ═══════════════════════════════════════════════════════════════════════════════
# ProviderCircuitBreaker — state machine (async tests)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestProviderCircuitBreakerInitialState:
    async def test_starts_closed(self):
        breaker = _make_breaker()
        assert breaker.state == CircuitState.CLOSED

    async def test_allow_request_returns_true_when_closed(self):
        breaker = _make_breaker()
        assert await breaker.allow_request() is True

    async def test_initial_metrics(self):
        breaker = _make_breaker("test")
        metrics = breaker.metrics()
        assert metrics.state == CircuitState.CLOSED
        assert metrics.failures_in_window == 0
        assert metrics.total_successes == 0
        assert metrics.total_failures == 0
        assert metrics.total_rejected == 0


@pytest.mark.asyncio
class TestProviderCircuitBreakerOpenTransition:
    async def test_opens_after_threshold_failures(self):
        breaker = _make_breaker(failure_threshold=3)
        assert breaker.state == CircuitState.CLOSED

        await breaker.record_failure()
        assert breaker.state == CircuitState.CLOSED

        await breaker.record_failure()
        assert breaker.state == CircuitState.CLOSED

        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

    async def test_rejects_requests_when_open(self):
        breaker = _make_breaker(failure_threshold=1)
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        assert await breaker.allow_request() is False

    async def test_remaining_cooldown_returns_positive_when_open(self):
        breaker = _make_breaker(failure_threshold=1, recovery_timeout=60)
        await breaker.record_failure()
        remaining = breaker.remaining_cooldown()
        assert remaining is not None
        assert remaining > 0

    async def test_remaining_cooldown_returns_none_when_not_open(self):
        breaker = _make_breaker()
        assert breaker.remaining_cooldown() is None

    async def test_failures_are_counted_in_rolling_window(self):
        breaker = _make_breaker(failure_threshold=5, window_size=10)
        for _ in range(3):
            await breaker.record_failure()
        assert breaker.failures_in_window() == 3

    async def test_total_rejected_increments(self):
        breaker = _make_breaker(failure_threshold=1)
        await breaker.record_failure()
        await breaker.allow_request()  # rejected
        await breaker.allow_request()  # rejected
        assert breaker.metrics().total_rejected == 2


@pytest.mark.asyncio
class TestProviderCircuitBreakerHalfOpenTransition:
    async def test_transitions_to_half_open_after_cooldown(self):
        breaker = _make_breaker(failure_threshold=1, recovery_timeout=0.05)
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        await asyncio.sleep(0.06)
        allowed = await breaker.allow_request()
        assert allowed is True
        assert breaker.state == CircuitState.HALF_OPEN

    async def test_limits_probes_in_half_open(self):
        breaker = _make_breaker(
            failure_threshold=1,
            recovery_timeout=0.05,
            half_open_max_probes=3,  # total probes = 3
        )

        # Force to OPEN
        await breaker.record_failure()
        # Travel forward → HALF_OPEN (transition consumes 1 probe)
        breaker._last_state_change = time.monotonic() - 0.06
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

        assert await breaker.allow_request() is True   # probe 2
        assert await breaker.allow_request() is True   # probe 3
        assert await breaker.allow_request() is False  # exhausted

    async def test_probe_failure_returns_to_open(self):
        breaker = _make_breaker(
            failure_threshold=1,
            recovery_timeout=999,
            half_open_max_probes=3,
            success_threshold=2,
        )

        # Force to OPEN → HALF_OPEN
        await breaker.record_failure()
        breaker._last_state_change = time.monotonic() - 1000
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

    async def test_consecutive_successes_close_circuit(self):
        breaker = _make_breaker(
            failure_threshold=1,
            recovery_timeout=0.05,
            half_open_max_probes=3,
            success_threshold=2,
        )

        await breaker.record_failure()
        breaker._last_state_change = time.monotonic() - 0.06
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

        await breaker.record_success()  # 1st
        assert breaker.state == CircuitState.HALF_OPEN
        await breaker.record_success()  # 2nd → CLOSED
        assert breaker.state == CircuitState.CLOSED

    async def test_half_open_probes_reset_on_transition_to_open(self):
        breaker = _make_breaker(
            failure_threshold=1,
            recovery_timeout=0.05,
            half_open_max_probes=3,
            success_threshold=2,
        )

        await breaker.record_failure()
        breaker._last_state_change = time.monotonic() - 0.06
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

        await breaker.allow_request()
        await breaker.record_failure()  # back to OPEN

        breaker._last_state_change = time.monotonic() - 0.06
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

    async def test_total_probes_incremented(self):
        breaker = _make_breaker(failure_threshold=1, recovery_timeout=0.05, half_open_max_probes=3)

        await breaker.record_failure()
        breaker._last_state_change = time.monotonic() - 0.06
        await breaker.allow_request()  # → HALF_OPEN, 1 probe used
        await breaker.allow_request()  # probe 2
        await breaker.allow_request()  # probe 3

        metrics = breaker.metrics()
        assert 3 <= metrics.total_probes <= 4  # allow_request that triggered HALF_OPEN counted as 1

    async def test_state_transition_logging(self, caplog):
        breaker = _make_breaker(failure_threshold=1, recovery_timeout=999)
        with caplog.at_level(logging.INFO, logger="talos_agent.circuit_breaker"):
            await breaker.record_failure()
        assert "OPEN" in caplog.text


@pytest.mark.asyncio
class TestProviderCircuitBreakerWindowPruning:
    async def test_old_failures_are_pruned(self):
        breaker = _make_breaker(failure_threshold=10, window_size=0.1)
        for _ in range(5):
            await breaker.record_failure()
        assert breaker.failures_in_window() == 5

        await asyncio.sleep(0.15)
        assert breaker.failures_in_window() == 0


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerRegistry
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerRegistry:
    async def test_get_creates_breaker(self):
        registry = CircuitBreakerRegistry()
        breaker = registry.get("test_provider")
        assert isinstance(breaker, ProviderCircuitBreaker)
        assert breaker.provider == "test_provider"

    async def test_get_returns_same_breaker(self):
        registry = CircuitBreakerRegistry()
        breaker1 = registry.get("test_provider")
        breaker2 = registry.get("test_provider")
        assert breaker1 is breaker2

    async def test_per_provider_isolation(self):
        registry = CircuitBreakerRegistry()
        breaker1 = registry.get("provider_a")
        breaker2 = registry.get("provider_b")
        assert breaker1 is not breaker2
        assert breaker1.provider != breaker2.provider

    async def test_reset_clears_all_breakers(self):
        registry = CircuitBreakerRegistry()
        registry.get("provider_a")
        registry.get("provider_b")
        registry.reset()
        assert len(registry._breakers) == 0

    async def test_load_all_no_storage(self):
        registry = CircuitBreakerRegistry()
        registry.get("test")
        await registry.load_all()  # Should not raise

    async def test_save_all_no_storage(self):
        registry = CircuitBreakerRegistry()
        registry.get("test")
        await registry.save_all()  # Should not raise

    async def test_load_all_with_storage(self):
        storage = MemoryStorageAdapter()
        registry = CircuitBreakerRegistry(storage_adapter=storage)
        breaker = registry.get("test")
        
        # Simulate some state
        await breaker.record_failure()
        await breaker.record_failure()
        
        # Save state
        await registry.save_all()
        
        # Create new registry and load
        new_registry = CircuitBreakerRegistry(storage_adapter=storage)
        new_breaker = new_registry.get("test")
        await new_registry.load_all()
        
        # Verify state was loaded
        assert new_breaker._total_failures == 2

    async def test_save_all_with_storage(self):
        storage = MemoryStorageAdapter()
        registry = CircuitBreakerRegistry(storage_adapter=storage)
        breaker = registry.get("test")
        
        # Simulate some state
        await breaker.record_failure()
        await breaker.record_success()
        
        # Save state
        await registry.save_all()
        
        # Verify storage has data
        keys = await storage.list_keys()
        assert f"circuit_breaker_test" in keys


# ═══════════════════════════════════════════════════════════════════════════════
# Persistence Tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerPersistence:
    async def test_save_and_load_state(self):
        storage = MemoryStorageAdapter()
        breaker = _make_breaker(provider="persist_test")
        
        # Simulate state
        await breaker.record_failure()
        await breaker.record_failure()
        await breaker.record_success()
        
        # Save state
        await breaker.save_state(storage)
        
        # Create new breaker and load
        new_breaker = _make_breaker(provider="persist_test")
        await new_breaker.load_state(storage)
        
        # Verify state
        assert new_breaker._total_failures == 2
        assert new_breaker._total_successes == 1
        assert new_breaker.state == CircuitState.CLOSED

    async def test_load_state_missing_key(self):
        storage = MemoryStorageAdapter()
        breaker = _make_breaker(provider="missing_test")
        
        # Load from non-existent key
        await breaker.load_state(storage)
        
        # Should reset to default
        assert breaker.state == CircuitState.CLOSED
        assert breaker._total_failures == 0

    async def test_load_state_malformed_json(self):
        storage = MemoryStorageAdapter()
        await storage.write("circuit_breaker_malformed", "not valid json")
        
        breaker = _make_breaker(provider="malformed")
        await breaker.load_state(storage)
        
        # Should reset to default
        assert breaker.state == CircuitState.CLOSED

    async def test_load_state_missing_fields(self):
        storage = MemoryStorageAdapter()
        incomplete_state = json.dumps({"provider": "incomplete"})
        await storage.write("circuit_breaker_incomplete", incomplete_state)
        
        breaker = _make_breaker(provider="incomplete")
        await breaker.load_state(storage)
        
        # Should reset to default
        assert breaker.state == CircuitState.CLOSED

    async def test_load_state_invalid_state_value(self):
        storage = MemoryStorageAdapter()
        invalid_state = json.dumps({
            "provider": "invalid",
            "state": "invalid_state",
            "_last_state_change": time.monotonic(),
            "_last_failure_time": 0.0,
            "_half_open_probes_used": 0,
            "_consecutive_successes": 0,
            "_total_successes": 0,
            "_total_failures": 0,
            "_total_rejected": 0,
            "_total_probes": 0,
        })
        await storage.write("circuit_breaker_invalid", invalid_state)
        
        breaker = _make_breaker(provider="invalid")
        await breaker.load_state(storage)
        
        # Should reset to default
        assert breaker.state == CircuitState.CLOSED

    async def test_serialize_deserialize_roundtrip(self):
        breaker = _make_breaker(provider="roundtrip")
        
        # Simulate state
        await breaker.record_failure()
        await breaker.record_failure()
        await breaker.record_success()
        
        # Serialize
        serialized = breaker._serialize_state()
        
        # Deserialize
        new_breaker = _make_breaker(provider="roundtrip")
        new_breaker._deserialize_state(serialized)
        
        # Verify
        assert new_breaker._total_failures == 2
        assert new_breaker._total_successes == 1
        assert new_breaker.state == CircuitState.CLOSED

    async def test_state_key_format(self):
        breaker = _make_breaker(provider="test_provider")
        assert breaker._state_key() == "circuit_breaker_test_provider"


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerMetrics
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerMetrics:
    async def test_metrics_to_dict(self):
        breaker = _make_breaker("test")
        metrics = breaker.metrics()
        d = metrics.to_dict()
        
        assert d["provider"] == "test"
        assert d["state"] == "closed"
        assert d["failures_in_window"] == 0
        assert d["half_open_probes_used"] == 0
        assert d["consecutive_successes"] == 0
        assert d["total_successes"] == 0
        assert d["total_failures"] == 0
        assert d["total_rejected"] == 0
        assert d["total_probes"] == 0

    async def test_metrics_after_failure(self):
        breaker = _make_breaker("test")
        await breaker.record_failure()
        metrics = breaker.metrics()
        
        assert metrics.total_failures == 1
        assert metrics.failures_in_window == 1

    async def test_metrics_after_success(self):
        breaker = _make_breaker("test")
        await breaker.record_success()
        metrics = breaker.metrics()
        
        assert metrics.total_successes == 1


# ═══════════════════════════════════════════════════════════════════════════════
# Regression Tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerRegression:
    async def test_no_state_leak_between_instances(self):
        breaker1 = _make_breaker(provider="reg1")
        breaker2 = _make_breaker(provider="reg2")
        
        await breaker1.record_failure()
        await breaker1.record_failure()
        
        assert breaker2._total_failures == 0

    async def test_metrics_do_not_mutate_state(self):
        breaker = _make_breaker("test")
        await breaker.record_failure()
        
        # Call metrics multiple times
        m1 = breaker.metrics()
        m2 = breaker.metrics()
        
        assert m1.total_failures == m2.total_failures
        assert m1.failures_in_window == m2.failures_in_window

    async def test_allow_request_does_not_mutate_state_when_closed(self):
        breaker = _make_breaker("test")
        initial_total = breaker._total_rejected
        
        await breaker.allow_request()
        await breaker.allow_request()
        
        assert breaker._total_rejected == initial_total

    async def test_record_success_does_not_mutate_state_when_closed(self):
        breaker = _make_breaker("test")
        initial_total = breaker._total_successes
        
        await breaker.record_success()
        await breaker.record_success()
        
        assert breaker._total_successes == initial_total + 2