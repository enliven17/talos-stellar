"""Fallback chain for trying providers in order until one succeeds.

The :class:`FallbackChain` executes an operation against a sequence of
providers, moving to the next on failure.  It integrates with the circuit
breaker system to skip providers that are currently OPEN and records
successes/failures on the appropriate breakers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from talos_agent.circuit_breaker import CircuitBreakerOpen, cb_registry

logger = logging.getLogger(__name__)


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
    """

    success: bool
    provider_name: str
    result: Any = None
    attempts: list[tuple[str, str]] = field(default_factory=list)
    total_attempts: int = 0


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
    ) -> None:
        self._providers = list(providers)
        self._strategy = strategy
        self._round_robin_index: int = 0

    @property
    def providers(self) -> list[str]:
        """The ordered list of provider names in this chain."""
        return list(self._providers)

    @property
    def strategy(self) -> FallbackStrategy:
        return self._strategy

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

        for provider_name in provider_list:
            # Check circuit breaker before attempting
            breaker = cb_registry.get(provider_name)
            if not await breaker.allow_request():
                cooldown = breaker.remaining_cooldown() or 0.0
                msg = f"Circuit breaker OPEN (retry in {cooldown:.1f}s)"
                attempts.append((provider_name, msg))
                logger.warning(
                    "Fallback skipping '%s' — %s",
                    provider_name,
                    msg,
                )
                continue

            try:
                result = await operation(provider_name, *args, **kwargs)
                await breaker.record_success()
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
        )

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
