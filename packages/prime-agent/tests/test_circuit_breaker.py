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
"""

from __future__ import annotations

import asyncio
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
        breaker = _make_breaker(failure_threshold=1, window_size=0.05)
        await breaker.record_failure()
        assert breaker.failures_in_window() == 1

        await asyncio.sleep(0.06)
        assert breaker.failures_in_window() == 0

    async def test_consecutive_successes_reset_on_reopen(self):
        breaker = _make_breaker(
            failure_threshold=1,
            recovery_timeout=0.05,
            half_open_max_probes=3,
            success_threshold=3,
        )

        await breaker.record_failure()
        breaker._last_state_change = time.monotonic() - 0.06
        assert await breaker.allow_request() is True

        await breaker.record_success()  # 1 consecutive
        await breaker.record_success()  # 2 consecutive
        await breaker.record_failure()  # back to OPEN

        metrics = breaker.metrics()
        assert metrics.consecutive_successes == 0

    async def test_exact_threshold_opens_circuit(self):
        breaker = _make_breaker(failure_threshold=5)
        for _ in range(4):
            await breaker.record_failure()
        assert breaker.state == CircuitState.CLOSED
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerRegistry
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerRegistry:
    def setup_method(self):
        self.registry = CircuitBreakerRegistry()

    async def test_get_creates_new_breaker(self):
        breaker = self.registry.get("groq")
        assert breaker.provider == "groq"
        assert breaker.state == CircuitState.CLOSED

    async def test_get_returns_same_instance(self):
        b1 = self.registry.get("groq")
        b2 = self.registry.get("groq")
        assert b1 is b2

    async def test_get_or_create_with_explicit_config(self):
        config = CircuitBreakerConfig(failure_threshold=10)
        breaker = self.registry.get_or_create("custom", config)
        assert breaker.config.failure_threshold == 10

    async def test_providers_are_isolated(self):
        groq = self.registry.get("groq")
        openai = self.registry.get("openai")
        assert groq is not openai

        await groq.record_failure()
        assert groq.failures_in_window() == 1
        assert openai.failures_in_window() == 0

    async def test_all_metrics_returns_dict(self):
        self.registry.get("groq")
        self.registry.get("openai")
        metrics = self.registry.all_metrics()
        assert "groq" in metrics
        assert "openai" in metrics
        assert metrics["groq"]["state"] == "closed"

    async def test_reset_all(self):
        breaker = self.registry.get("groq")
        await breaker.record_failure()
        assert breaker.metrics().total_failures == 1

        self.registry.reset_all()
        assert breaker.state == CircuitState.CLOSED
        assert breaker.failures_in_window() == 0
        assert breaker.metrics().total_failures == 0
        assert breaker.metrics().total_rejected == 0


# ═══════════════════════════════════════════════════════════════════════════════
# CircuitBreakerMetrics
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestCircuitBreakerMetrics:
    async def test_to_dict_keys(self):
        breaker = _make_breaker("test", failure_threshold=3, window_size=60)
        await breaker.record_failure()

        metrics = breaker.metrics()
        d = metrics.to_dict()
        expected_keys = {
            "provider", "state", "failures_in_window",
            "half_open_probes_used", "consecutive_successes",
            "last_failure_age_s", "remaining_cooldown_s",
            "total_successes", "total_failures", "total_rejected",
            "total_probes",
        }
        assert set(d.keys()) == expected_keys

    async def test_last_failure_age_is_none_when_no_failures(self):
        breaker = _make_breaker()
        metrics = breaker.metrics()
        assert metrics.last_failure_age is None

    async def test_last_failure_age_is_set_after_failure(self):
        breaker = _make_breaker()
        await breaker.record_failure()
        metrics = breaker.metrics()
        assert metrics.last_failure_age is not None
        assert metrics.last_failure_age >= 0

    async def test_remaining_cooldown_is_none_when_not_open(self):
        breaker = _make_breaker()
        metrics = breaker.metrics()
        assert metrics.remaining_cooldown is None


# ═══════════════════════════════════════════════════════════════════════════════
# Integration: request_with_retry + circuit breaker
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestRequestWithRetryWithCircuitBreaker:
    @respx.mock
    async def test_passes_request_when_closed(self):
        route = respx.get("https://api.example.com/ok").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/ok"),
                provider="talos_web_api",
            )

        assert response.status_code == 200
        assert route.call_count == 1

    @respx.mock
    async def test_rejects_request_when_open(self):
        test_provider = "test_integ_reject"
        breaker = cb_registry.get(test_provider)
        cb_registry.reset_all()
        # Record enough failures to open the circuit.
        for _ in range(breaker.config.failure_threshold):
            await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        async with httpx.AsyncClient() as client:
            with pytest.raises(CircuitBreakerOpen) as exc_info:
                await request_with_retry(
                    lambda: client.get("https://api.example.com/should-not-reach"),
                    provider=test_provider,
                )

        assert exc_info.value.provider == test_provider

    @respx.mock
    async def test_records_failure_on_retryable_error(self):
        provider_name = "test_integ_fail"
        cb_registry.reset_all()

        respx.get("https://api.example.com/always-503").mock(
            return_value=httpx.Response(503, json={"error": "down"})
        )

        async with httpx.AsyncClient() as client:
            with pytest.raises(RetryableHTTPError):
                await request_with_retry(
                    lambda: client.get("https://api.example.com/always-503"),
                    provider=provider_name,
                )

        breaker = cb_registry.get(provider_name)
        assert breaker.metrics().total_failures >= 1

    async def test_no_provider_skips_circuit_check(self):
        async def op():
            return "hello"

        result = await call_with_retry(op)  # no provider
        assert result == "hello"

    @respx.mock
    async def test_half_open_allows_probe_requests(self):
        provider_name = "test_integ_half_open"
        breaker = cb_registry.get(provider_name)
        cb_registry.reset_all()

        # Record enough failures to open the circuit.
        for _ in range(breaker.config.failure_threshold):
            await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        # Travel forward past recovery timeout.
        breaker._last_state_change = time.monotonic() - 1000
        assert await breaker.allow_request() is True  # → HALF_OPEN
        assert breaker.state == CircuitState.HALF_OPEN

        route = respx.get("https://api.example.com/probe").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/probe"),
                provider=provider_name,
            )

        assert response.status_code == 200
        assert route.call_count == 1

    @respx.mock
    async def test_open_without_provider_still_works(self):
        route = respx.get("https://api.example.com/works").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/works"),
            )

        assert response.status_code == 200
        assert route.call_count == 1


@pytest.mark.asyncio
class TestCallWithRetryWithCircuitBreaker:
    async def test_passes_when_closed(self):
        provider_name = "test_call_closed"
        cb_registry.reset_all()

        calls = 0

        async def op():
            nonlocal calls
            calls += 1
            return "done"

        result = await call_with_retry(op, provider=provider_name)
        assert result == "done"
        assert calls == 1

    async def test_rejects_when_open(self):
        provider_name = "test_call_reject"
        breaker = cb_registry.get(provider_name)
        cb_registry.reset_all()
        # Record enough failures to open the circuit.
        for _ in range(breaker.config.failure_threshold):
            await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        async def op():
            return "never reached"

        with pytest.raises(CircuitBreakerOpen) as exc_info:
            await call_with_retry(op, provider=provider_name)

        assert exc_info.value.provider == provider_name

    async def test_records_failure_on_exception(self):
        provider_name = "test_call_fail_record"
        breaker = cb_registry.get(provider_name)
        cb_registry.reset_all()

        async def op():
            raise ValueError("boom")

        with pytest.raises(ValueError):
            await call_with_retry(op, provider=provider_name)

        assert breaker.metrics().total_failures >= 1

    async def test_skipped_when_no_provider(self):
        cb_registry.reset_all()

        async def op():
            return "ok"

        result = await call_with_retry(op)
        assert result == "ok"


# ═══════════════════════════════════════════════════════════════════════════════
# Edge cases
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
class TestEdgeCases:
    async def test_zero_failure_threshold_opens_immediately(self):
        breaker = _make_breaker(failure_threshold=1)
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

    async def test_very_short_window_prunes_aggressively(self):
        breaker = _make_breaker(failure_threshold=3, window_size=0.02)
        await breaker.record_failure()
        await breaker.record_failure()
        assert breaker.failures_in_window() == 2
        await asyncio.sleep(0.03)
        assert breaker.failures_in_window() == 0

    async def test_full_lifecycle(self):
        """CLOSED → OPEN → HALF_OPEN → CLOSED."""
        breaker = _make_breaker(
            failure_threshold=2,
            recovery_timeout=0.05,
            half_open_max_probes=3,
            success_threshold=2,
        )

        await breaker.record_failure()
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        await asyncio.sleep(0.06)
        assert await breaker.allow_request() is True
        assert breaker.state == CircuitState.HALF_OPEN

        await breaker.record_success()
        await breaker.record_success()
        assert breaker.state == CircuitState.CLOSED

        assert await breaker.allow_request() is True

    async def test_metrics_after_full_cycle(self):
        breaker = _make_breaker(
            failure_threshold=2,
            recovery_timeout=0.05,
            half_open_max_probes=3,
            success_threshold=2,
        )

        await breaker.record_failure()
        await breaker.record_failure()
        assert breaker.state == CircuitState.OPEN

        metrics = breaker.metrics()
        assert metrics.total_failures == 2
        assert metrics.state == CircuitState.OPEN
