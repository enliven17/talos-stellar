"""Per-provider circuit breakers with adaptive recovery.

Prevents cascading failures when external providers degrade, and
gradually recovers capacity as providers return to health.

States
------
CLOSED
    Normal operation. Requests pass through; failures counted in a
    rolling window.  When **failure_count** >= failure_threshold the
    breaker transitions to OPEN.

OPEN
    Requests are rejected immediately with a :class:`CircuitBreakerOpen`
    exception.  After **recovery_timeout** seconds the breaker
    transitions to HALF_OPEN.

HALF_OPEN
    A limited number of **probe requests** are allowed through (up to
    half_open_max_probes).  If a probe fails the breaker goes back to
    OPEN.  If **success_threshold** consecutive probes succeed the
    breaker transitions back to CLOSED and the failure window resets.

Usage
-----
.. code:: python

    from talos_agent.circuit_breaker import ProviderCircuitBreaker, cb_registry

    breaker = cb_registry.get("groq")
    if not await breaker.allow_request():
        raise CircuitBreakerOpen("groq", breaker.remaining_cooldown())

    try:
        response = await make_call()
        await breaker.record_success()
    except Exception:
        await breaker.record_failure()
        raise
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import ClassVar

logger = logging.getLogger(__name__)


# ── Exceptions ────────────────────────────────────────────────────────────────


class CircuitBreakerError(Exception):
    """Base exception for circuit-breaker failures."""


class CircuitBreakerOpen(CircuitBreakerError):
    """Raised when a request is rejected because the circuit is OPEN.

    The caller should either fail-fast or consult *fallback_hint* for an
    alternative strategy.
    """

    def __init__(self, provider: str, retry_after: float, fallback_hint: str = "") -> None:
        self.provider = provider
        self.retry_after = retry_after
        self.fallback_hint = fallback_hint
        super().__init__(
            f"Circuit breaker OPEN for '{provider}' — retry in {retry_after:.1f}s"
            + (f" ({fallback_hint})" if fallback_hint else "")
        )


# ── State ─────────────────────────────────────────────────────────────────────


class CircuitState(str, Enum):
    """Circuit breaker lifecycle states."""

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


# ── Configuration ─────────────────────────────────────────────────────────────


@dataclass
class CircuitBreakerConfig:
    """Tunable parameters for a single circuit breaker."""

    failure_threshold: int = 5
    """Number of failures within *window_size* seconds to open the circuit."""

    recovery_timeout: float = 30.0
    """Seconds to wait before transitioning from OPEN to HALF_OPEN."""

    half_open_max_probes: int = 3
    """Maximum number of probe requests allowed while HALF_OPEN."""

    success_threshold: int = 2
    """Consecutive HALF_OPEN successes required to close the circuit."""

    window_size: float = 60.0
    """Rolling window size in seconds for failure counting."""

    # ── Pre-built defaults for known providers ────────────────────────────

    PROVIDER_DEFAULTS: ClassVar[dict[str, CircuitBreakerConfig]] = {}

    @classmethod
    def for_provider(cls, provider: str) -> CircuitBreakerConfig:
        """Return the configuration for *provider*, or the default."""
        return cls.PROVIDER_DEFAULTS.get(provider, cls())


# Register per-provider defaults.

CircuitBreakerConfig.PROVIDER_DEFAULTS["groq"] = CircuitBreakerConfig(
    failure_threshold=5,
    recovery_timeout=30.0,
    half_open_max_probes=3,
    success_threshold=2,
    window_size=60.0,
)
CircuitBreakerConfig.PROVIDER_DEFAULTS["openai"] = CircuitBreakerConfig(
    failure_threshold=5,
    recovery_timeout=30.0,
    half_open_max_probes=3,
    success_threshold=2,
    window_size=60.0,
)
CircuitBreakerConfig.PROVIDER_DEFAULTS["talos_web_api"] = CircuitBreakerConfig(
    failure_threshold=8,
    recovery_timeout=15.0,
    half_open_max_probes=3,
    success_threshold=2,
    window_size=60.0,
)
CircuitBreakerConfig.PROVIDER_DEFAULTS["discord"] = CircuitBreakerConfig(
    failure_threshold=3,
    recovery_timeout=60.0,
    half_open_max_probes=2,
    success_threshold=2,
    window_size=120.0,
)
CircuitBreakerConfig.PROVIDER_DEFAULTS["telegram"] = CircuitBreakerConfig(
    failure_threshold=3,
    recovery_timeout=60.0,
    half_open_max_probes=2,
    success_threshold=2,
    window_size=120.0,
)
CircuitBreakerConfig.PROVIDER_DEFAULTS["x"] = CircuitBreakerConfig(
    failure_threshold=4,
    recovery_timeout=45.0,
    half_open_max_probes=2,
    success_threshold=3,
    window_size=90.0,
)


# ── Provider resolution ───────────────────────────────────────────────────────


def _resolve_provider_from_url(url: str) -> str:
    """Map a URL to its provider name for circuit breaker routing.

    Used internally when the caller does not supply an explicit provider.
    """
    lower = url.lower()
    if "groq.com" in lower:
        return "groq"
    if "openai.com" in lower or "api.openai" in lower:
        return "openai"
    if "discord.com" in lower:
        return "discord"
    if "telegram" in lower:
        return "telegram"
    if "x.com" in lower or "twitter.com" in lower:
        return "x"
    # Fallback — anything not recognised goes through the talos_web_api breaker.
    return "talos_web_api"


# ── Metrics ───────────────────────────────────────────────────────────────────


@dataclass
class CircuitBreakerMetrics:
    """Snapshot of circuit breaker state for telemetry."""

    provider: str
    state: CircuitState
    failures_in_window: int
    half_open_probes_used: int
    consecutive_successes: int
    last_failure_age: float | None  # seconds since last failure; None if no failures
    remaining_cooldown: float | None  # None if not OPEN
    total_successes: int = 0
    total_failures: int = 0
    total_rejected: int = 0
    total_probes: int = 0

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "state": self.state.value,
            "failures_in_window": self.failures_in_window,
            "half_open_probes_used": self.half_open_probes_used,
            "consecutive_successes": self.consecutive_successes,
            "last_failure_age_s": self.last_failure_age,
            "remaining_cooldown_s": self.remaining_cooldown,
            "total_successes": self.total_successes,
            "total_failures": self.total_failures,
            "total_rejected": self.total_rejected,
            "total_probes": self.total_probes,
        }


# ── Circuit Breaker ───────────────────────────────────────────────────────────


class ProviderCircuitBreaker:
    """Per-provider circuit breaker with rolling window and adaptive recovery.

    This implementation is designed for single-threaded async contexts.
    For multi-threaded use, callers should synchronise access externally.
    """

    def __init__(self, provider: str, config: CircuitBreakerConfig | None = None) -> None:
        self.provider = provider
        self.config = config or CircuitBreakerConfig.for_provider(provider)

        self.state: CircuitState = CircuitState.CLOSED

        # Rolling window of failure timestamps (monotonic time).
        self._failures: deque[float] = deque()

        # Probe tracking for HALF_OPEN.
        self._half_open_probes_used: int = 0
        self._consecutive_successes: int = 0

        # State transition timestamps (monotonic time).
        self._last_state_change: float = time.monotonic()
        self._last_failure_time: float = 0.0

        # Lifetime counters for telemetry.
        self._total_successes: int = 0
        self._total_failures: int = 0
        self._total_rejected: int = 0
        self._total_probes: int = 0

    # ── Public API ────────────────────────────────────────────────────────

    async def allow_request(self) -> bool:
        """Check whether a request is allowed through the circuit.

        Returns ``True`` if the request may proceed, ``False`` if the
        circuit is OPEN and the caller should fail fast.

        Side effects:
        * If OPEN and recovery_timeout has elapsed, transitions to HALF_OPEN.
        * If HALF_OPEN, increments the probe counter.
        """
        now = time.monotonic()

        if self.state == CircuitState.CLOSED:
            return True

        if self.state == CircuitState.OPEN:
            elapsed = now - self._last_state_change
            if elapsed >= self.config.recovery_timeout:
                self._transition_to(CircuitState.HALF_OPEN, now)
                self._half_open_probes_used = 1
                self._total_probes += 1
                return True
            self._total_rejected += 1
            return False

        # HALF_OPEN — allow up to half_open_max_probes probes.
        if self._half_open_probes_used < self.config.half_open_max_probes:
            self._half_open_probes_used += 1
            self._total_probes += 1
            return True

        self._total_rejected += 1
        return False

    async def record_success(self) -> None:
        """Record a successful request.

        Side effects:
        * If HALF_OPEN, increments consecutive successes; closes circuit
          when success_threshold is reached.
        * If CLOSED, prunes the failure window.
        """
        self._total_successes += 1

        if self.state == CircuitState.HALF_OPEN:
            self._consecutive_successes += 1
            if self._consecutive_successes >= self.config.success_threshold:
                logger.info(
                    "Circuit breaker CLOSED for '%s' — recovery confirmed (%d consecutive successes)",
                    self.provider,
                    self._consecutive_successes,
                )
                self._transition_to(CircuitState.CLOSED)
                self._failures.clear()
        elif self.state == CircuitState.CLOSED:
            self._prune_window()

    async def record_failure(self) -> None:
        """Record a failed request.

        Side effects:
        * Appends the failure to the rolling window.
        * If HALF_OPEN, transitions back to OPEN.
        * If CLOSED and failure_threshold is met, transitions to OPEN.
        """
        now = time.monotonic()
        self._total_failures += 1
        self._last_failure_time = now
        self._failures.append(now)

        if self.state == CircuitState.HALF_OPEN:
            logger.warning(
                "Circuit breaker HALF_OPEN → OPEN for '%s' — probe failed (back to recovery)",
                self.provider,
            )
            self._transition_to(CircuitState.OPEN, now)
        elif self.state == CircuitState.CLOSED:
            self._prune_window()
            if len(self._failures) >= self.config.failure_threshold:
                logger.warning(
                    "Circuit breaker OPEN for '%s' — %d failures in %.0fs window",
                    self.provider,
                    len(self._failures),
                    self.config.window_size,
                )
                self._transition_to(CircuitState.OPEN, now)

    def remaining_cooldown(self) -> float | None:
        """Seconds until OPEN → HALF_OPEN transition, or ``None``."""
        if self.state != CircuitState.OPEN:
            return None
        elapsed = time.monotonic() - self._last_state_change
        return max(0.0, self.config.recovery_timeout - elapsed)

    def failures_in_window(self) -> int:
        """Number of failures in the current rolling window (prunes stale)."""
        self._prune_window()
        return len(self._failures)

    def metrics(self) -> CircuitBreakerMetrics:
        """Return a snapshot of current state for telemetry / logging."""
        now = time.monotonic()
        last_failure_age = now - self._last_failure_time if self._last_failure_time else None
        remaining = self.remaining_cooldown()
        return CircuitBreakerMetrics(
            provider=self.provider,
            state=self.state,
            failures_in_window=len(self._failures),
            half_open_probes_used=self._half_open_probes_used,
            consecutive_successes=self._consecutive_successes,
            last_failure_age=last_failure_age,
            remaining_cooldown=remaining,
            total_successes=self._total_successes,
            total_failures=self._total_failures,
            total_rejected=self._total_rejected,
            total_probes=self._total_probes,
        )

    # ── Internal helpers ─────────────────────────────────────────────────

    def _transition_to(self, new_state: CircuitState, now: float | None = None) -> None:
        if self.state == new_state:
            return
        logger.info(
            "Circuit breaker '%s': %s → %s",
            self.provider,
            self.state.value,
            new_state.value,
        )
        self.state = new_state
        self._last_state_change = now or time.monotonic()

        if new_state == CircuitState.OPEN:
            # When transitioning to OPEN from HALF_OPEN, reset consecutive
            # successes so the next half-open cycle starts fresh.
            self._consecutive_successes = 0
        elif new_state == CircuitState.HALF_OPEN or new_state == CircuitState.CLOSED:
            self._half_open_probes_used = 0
            self._consecutive_successes = 0

    def _prune_window(self) -> None:
        """Remove failures outside the rolling window."""
        cutoff = time.monotonic() - self.config.window_size
        while self._failures and self._failures[0] < cutoff:
            self._failures.popleft()


# ── Registry ──────────────────────────────────────────────────────────────────


class CircuitBreakerRegistry:
    """Holds all :class:`ProviderCircuitBreaker` instances, keyed by provider name.

    Usage
    -----
    .. code:: python

        from talos_agent.circuit_breaker import cb_registry

        await cb_registry.get("groq").allow_request()
    """

    def __init__(self) -> None:
        self._breakers: dict[str, ProviderCircuitBreaker] = {}

    def get(self, provider: str) -> ProviderCircuitBreaker:
        """Return the breaker for *provider*, creating one on first access."""
        if provider not in self._breakers:
            config = CircuitBreakerConfig.for_provider(provider)
            self._breakers[provider] = ProviderCircuitBreaker(provider, config)
            logger.debug("Created circuit breaker for '%s'", provider)
        return self._breakers[provider]

    def get_or_create(self, provider: str, config: CircuitBreakerConfig | None = None) -> ProviderCircuitBreaker:
        """Return or create a breaker with an optional explicit *config*."""
        if provider not in self._breakers:
            self._breakers[provider] = ProviderCircuitBreaker(provider, config or CircuitBreakerConfig.for_provider(provider))
        return self._breakers[provider]

    def all_metrics(self) -> dict[str, dict]:
        """Return metrics for all registered breakers."""
        return {name: br.metrics().to_dict() for name, br in self._breakers.items()}

    def reset_all(self) -> None:
        """Reset every registered breaker to CLOSED state (for testing)."""
        for br in self._breakers.values():
            br._failures.clear()
            br.state = CircuitState.CLOSED
            br._half_open_probes_used = 0
            br._consecutive_successes = 0
            br._total_successes = 0
            br._total_failures = 0
            br._total_rejected = 0
            br._total_probes = 0
            br._last_state_change = time.monotonic()
            br._last_failure_time = 0.0


# Module-level singleton — imported by http.py and callers.
cb_registry: CircuitBreakerRegistry = CircuitBreakerRegistry()

__all__ = [
    "CircuitBreakerConfig",
    "CircuitBreakerError",
    "CircuitBreakerMetrics",
    "CircuitBreakerOpen",
    "CircuitBreakerRegistry",
    "CircuitState",
    "ProviderCircuitBreaker",
    "_resolve_provider_from_url",
    "cb_registry",
]
