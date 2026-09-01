"""Fallback chain for trying providers in order until one succeeds.

The :class:`FallbackChain` executes an operation against a sequence of
providers, moving to the next on failure.  It integrates with the circuit
breaker system to skip providers that are currently OPEN and records
successes/failures on the appropriate breakers.
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from talos_agent.circuit_breaker import CircuitBreakerOpen, cb_registry
from talos_agent.telemetry import _is_sensitive_key

logger = logging.getLogger(__name__)

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 300.0



@dataclass(frozen=True)
class FallbackMetricsSnapshot:
    """A typed snapshot of fallback operational metrics for diagnostics."""

    attempts: dict[str, int]
    successes: dict[str, int]
    skips: dict[str, int]
    exhaustions: dict[str, int]
    timeouts: dict[str, int] = field(default_factory=dict)


class FallbackMetrics:
    """Registry for fallback operational metrics."""

    def __init__(self) -> None:
        self._attempts: dict[str, int] = {}
        self._successes: dict[str, int] = {}
        self._skips: dict[str, int] = {}
        self._exhaustions: dict[str, int] = {}
        self._timeouts: dict[str, int] = {}

    def _increment(self, counter: dict[str, int], provider: str) -> None:
        """Increment the metric for the given provider, bounding cardinality and redacting if sensitive."""
        # Hard limit on unique providers to prevent unbounded memory growth
        if len(counter) >= 100 and provider not in counter:
            provider = "OTHER_OVERFLOW"
        elif _is_sensitive_key(provider):
            provider = "[REDACTED]"
        
        counter[provider] = counter.get(provider, 0) + 1

    def record_attempt(self, provider: str) -> None:
        self._increment(self._attempts, provider)

    def record_success(self, provider: str) -> None:
        self._increment(self._successes, provider)

    def record_skip(self, provider: str) -> None:
        self._increment(self._skips, provider)

    def record_timeout(self, provider: str) -> None:
        self._increment(self._timeouts, provider)

    def record_exhaustion(self, provider: str) -> None:
        self._increment(self._exhaustions, provider)

    def snapshot(self) -> FallbackMetricsSnapshot:
        """Return a typed snapshot of the current metric state."""
        return FallbackMetricsSnapshot(
            attempts=dict(self._attempts),
            successes=dict(self._successes),
            skips=dict(self._skips),
            exhaustions=dict(self._exhaustions),
            timeouts=dict(self._timeouts),
        )

    def reset(self) -> None:
        """Clear all metric counters."""
        self._attempts.clear()
        self._successes.clear()
        self._skips.clear()
        self._exhaustions.clear()
        self._timeouts.clear()


fallback_metrics = FallbackMetrics()


class FallbackStrategy(str, Enum):
    """Strategy for ordering fallback attempts."""

    ORDERED = "ordered"
    """Try providers in the exact order specified (default)."""

    ROUND_ROBIN = "round_robin"
    """Rotate through the provider list, skipping the last-used one."""


@dataclass(frozen=True)
class FallbackResult:
    """The result of a fallback chain execution.

    Attributes
    ----------
    success:
        Whether any provider succeeded.
    provider_name:
        The name of the provider that succeeded, or ``""`` if none.
    result:
        The result returned by the successful provider, or ``None``.
    attempts:
        List of ``(provider_name, error_message)`` for each failed attempt.
    total_attempts:
        Total number of providers attempted.
    timeouts:
        List of ``(provider_name, timeout_seconds)`` for each timed-out attempt.
    """

    success: bool
    provider_name: str
    result: Any = None
    attempts: list[tuple[str, str]] = field(default_factory=list)
    total_attempts: int = 0
    timeouts: list[tuple[str, float]] = field(default_factory=list)


class FallbackChain:
    """Execute an operation across a sequence of providers with fallback.

    Usage
    -----
    >>> chain = FallbackChain(["groq", "openai"])
    >>>
    >>> async def call(model: str, messages, ...):
    ...     ...
    >>>
    >>> result = await chain.execute(call)
    >>> if result.success:
    ...     print(f"Succeeded with {result.provider_name}")
    """

    def __init__(
        self,
        providers: list[str],
        strategy: FallbackStrategy = FallbackStrategy.ORDERED,
        timeout_seconds: float = DEFAULT_TOOL_TIMEOUT_SECONDS,
    ) -> None:
        self._providers = list(providers)
        self._strategy = strategy
        self._round_robin_index: int = 0
        self._timeout_seconds = self._validate_timeout(timeout_seconds)

    @property
    def providers(self) -> list[str]:
        """The ordered list of provider names in this chain."""
        return list(self._providers)

    @property
    def strategy(self) -> FallbackStrategy:
        return self._strategy

    @property
    def timeout_seconds(self) -> float:
        """The configured per-attempt timeout in seconds."""
        return self._timeout_seconds

    async def execute(
        self,
        operation: Callable[..., Any],
        *args: Any,
        **kwargs: Any,
    ) -> FallbackResult:
        """Try each provider in the chain until one succeeds.

        Parameters
        ----------
        operation:
            An async callable that accepts ``provider_name`` as its first
            positional argument (or via the ``provider_keyword`` parameter).
        *args:
            Additional positional arguments forwarded to *operation*.
        **kwargs:
            Additional keyword arguments forwarded to *operation*.

        Returns
        -------
        FallbackResult
            The result of the first successful attempt, or a summary of
            all failures.
        """
        provider_list = self._resolve_order()
        attempts: list[tuple[str, str]] = []
        timeout_events: list[tuple[str, float]] = []

        for provider_name in provider_list:
            # Check circuit breaker before attempting
            breaker = cb_registry.get(provider_name)
            if not await breaker.allow_request():
                cooldown = breaker.remaining_cooldown() or 0.0
                msg = f"Circuit breaker OPEN (retry in {cooldown:.1f}s)"
                attempts.append((provider_name, msg))
                fallback_metrics.record_skip(provider_name)
                logger.warning(
                    "Fallback skipping '%s' — %s",
                    provider_name,
                    msg,
                )
                continue

            fallback_metrics.record_attempt(provider_name)
            try:
                result = await asyncio.wait_for(
                    operation(provider_name, *args, **kwargs),
                    timeout=self._timeout_seconds,
                )
                await breaker.record_success()
                fallback_metrics.record_success(provider_name)
                logger.info(
                    "Fallback succeeded with '%s' after %d attempt(s)",
                    provider_name,
                    len(attempts) + 1,
                )
                return FallbackResult(
                    success=True,
                    provider_name=provider_name,
                    result=result,
                    attempts=attempts,
                    total_attempts=len(attempts) + 1,
                    timeouts=timeout_events,
                )
            except CircuitBreakerOpen as exc:
                await breaker.record_failure()
                attempts.append((provider_name, str(exc)))
                logger.warning(
                    "Fallback: '%s' rejected by circuit breaker — %s",
                    provider_name,
                    exc,
                )
                continue
            except asyncio.TimeoutError:
                await breaker.record_failure()
                fallback_metrics.record_timeout(provider_name)
                timeout_msg = f"Timeout after {self._timeout_seconds:g}s"
                attempts.append((provider_name, timeout_msg))
                timeout_events.append((provider_name, self._timeout_seconds))
                logger.warning(
                    "Fallback: '%s' timed out after %.1fs",
                    provider_name,
                    self._timeout_seconds,
                )
                continue
            except Exception as exc:
                await breaker.record_failure()
                exc_msg = _summarise_exception(exc)
                attempts.append((provider_name, exc_msg))
                logger.warning(
                    "Fallback: '%s' failed — %s",
                    provider_name,
                    exc_msg,
                )

        # All providers exhausted
        for p, _ in attempts:
            fallback_metrics.record_exhaustion(p)

        logger.error(
            "Fallback chain exhausted after %d provider(s): %s",
            len(attempts),
            "; ".join(f"{p}: {e}" for p, e in attempts),
        )
        return FallbackResult(
            success=False,
            provider_name="",
            attempts=attempts,
            total_attempts=len(attempts),
            timeouts=timeout_events,
        )

    @staticmethod
    def _validate_timeout(timeout_seconds: float) -> float:
        """Validate and normalise a per-attempt timeout value."""
        if not isinstance(timeout_seconds, (int, float)):
            raise TypeError("timeout_seconds must be a number")
        if not math.isfinite(timeout_seconds):
            raise ValueError("timeout_seconds must be finite")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than 0")
        if timeout_seconds > MAX_TOOL_TIMEOUT_SECONDS:
            raise ValueError(
                f"timeout_seconds must not exceed {MAX_TOOL_TIMEOUT_SECONDS}"
            )
        return float(timeout_seconds)

    def _resolve_order(self) -> list[str]:
        """Return the provider order based on the strategy."""
        if self._strategy == FallbackStrategy.ORDERED:
            return self._providers

        if self._strategy == FallbackStrategy.ROUND_ROBIN:
            if not self._providers:
                return []
            idx = self._round_robin_index % len(self._providers)
            self._round_robin_index = (idx + 1) % len(self._providers)
            return self._providers[idx:] + self._providers[:idx]

        return self._providers


def _summarise_exception(exc: Exception) -> str:
    """Return a concise, safe summary of an exception for logging."""
    exc_type = type(exc).__name__
    msg = str(exc)
    # Truncate long messages to avoid log floods
    if len(msg) > 200:
        msg = msg[:197] + "..."
    return f"{exc_type}: {msg}"
