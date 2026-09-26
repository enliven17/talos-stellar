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

import json
import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field, asdict
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import ClassVar
from typing import Any, ClassVar, TypeVar

from talos_agent.observability import log as structured_log

from talos_agent.config import APP_DIR
T = TypeVar("T")

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

    retry_budget: int = 3
    """Number of retries permitted for one adapter invocation."""

    backoff_initial: float = 1.0
    """Initial exponential backoff delay in seconds."""

    backoff_max: float = 30.0
    """Maximum exponential backoff delay in seconds."""

    # ── Pre-built defaults for known providers ────────────────────────────

    PROVIDER_DEFAULTS: ClassVar[dict[str, CircuitBreakerConfig]] = {}

    def __post_init__(self) -> None:
        if self.failure_threshold < 1 or self.half_open_max_probes < 1 or self.success_threshold < 1:
            raise ValueError("circuit thresholds and probe limits must be at least 1")
        if self.recovery_timeout <= 0 or self.window_size <= 0:
            raise ValueError("circuit timeouts must be greater than zero")
        if self.retry_budget < 0:
            raise ValueError("retry_budget must not be negative")
        if self.backoff_initial <= 0 or self.backoff_max <= 0 or self.backoff_initial > self.backoff_max:
            raise ValueError("backoff_initial must be positive and no greater than backoff_max")

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any] | None = None) -> CircuitBreakerConfig:
        """Build a validated config from user-provided adapter settings."""
        if values is None:
            return cls()
        allowed = {field for field in cls.__dataclass_fields__ if field != "PROVIDER_DEFAULTS"}
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"unknown circuit breaker settings: {', '.join(sorted(unknown))}")
        return cls(**dict(values))

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
        self._lock = asyncio.Lock()

    # ── Public API ────────────────────────────────────────────────────────

    async def allow_request(self) -> bool:
        """Check whether a request is allowed through the circuit.

        Returns ``True`` if the request may proceed, ``False`` if the
        circuit is OPEN and the caller should fail fast.

        Side effects:
        * If OPEN and recovery_timeout has elapsed, transitions to HALF_OPEN.
        * If HALF_OPEN, increments the probe counter.
        """
        async with self._lock:
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
        async with self._lock:
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
        async with self._lock:
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
        last_failure_age = (
            now - self._last_failure_time if self._last_failure_time > 0 else None
        )
        return CircuitBreakerMetrics(
            provider=self.provider,
            state=self.state,
            failures_in_window=self.failures_in_window(),
            half_open_probes_used=self._half_open_probes_used,
            consecutive_successes=self._consecutive_successes,
            last_failure_age=last_failure_age,
            remaining_cooldown=self.remaining_cooldown(),
            total_successes=self._total_successes,
            total_failures=self._total_failures,
            total_rejected=self._total_rejected,
            total_probes=self._total_probes,
        )

    # ── Internal helpers ──────────────────────────────────────────────────

    def _prune_window(self) -> None:
        """Remove failures outside the rolling window."""
        if not self._failures:
            return
        cutoff = time.monotonic() - self.config.window_size
        while self._failures and self._failures[0] < cutoff:
            self._failures.popleft()

    def _transition_to(self, new_state: CircuitState, now: float | None = None) -> None:
        """Transition to a new state and update timestamps."""
        if now is None:
            now = time.monotonic()
        previous_state = self.state
        logger.info(
            "Circuit breaker '%s': %s → %s",
            self.provider,
            self.state.value.upper(),
            new_state.value.upper(),
        )
        self.state = new_state
        self._last_state_change = now
        structured_log.info(
            "circuit_state_change",
            adapter=self.provider,
            previous_state=previous_state.value,
            state=new_state.value,
            reason="failure_threshold" if new_state == CircuitState.OPEN else "recovery",
        )

        if new_state == CircuitState.CLOSED:
            self._half_open_probes_used = 0
            self._consecutive_successes = 0
        elif new_state == CircuitState.HALF_OPEN:
            self._half_open_probes_used = 0
            self._consecutive_successes = 0
        # OPEN keeps existing probe/success counters until transition

    # ── Persistence ───────────────────────────────────────────────────────

    def _state_key(self) -> str:
        """Return the storage key for this breaker's state."""
        return f"circuit_breaker_{self.provider}"

    def _serialize_state(self) -> str:
        """Serialize current state to JSON string."""
        state_data = {
            "provider": self.provider,
            "state": self.state.value,
            "_last_state_change": self._last_state_change,
            "_last_failure_time": self._last_failure_time,
            "_half_open_probes_used": self._half_open_probes_used,
            "_consecutive_successes": self._consecutive_successes,
            "_total_successes": self._total_successes,
            "_total_failures": self._total_failures,
            "_total_rejected": self._total_rejected,
            "_total_probes": self._total_probes,
            # Note: _failures deque is not persisted to avoid bloating state;
            # it will be empty on restart, which is safe (conservative).
        }
        return json.dumps(state_data)

    def _deserialize_state(self, data: str) -> None:
        """Deserialize state from JSON string."""
        try:
            state_data = json.loads(data)
        except json.JSONDecodeError:
            logger.warning(
                "Malformed circuit breaker state for '%s', resetting to default",
                self.provider,
            )
            return

        # Validate expected fields
        required_fields = [
            "provider",
            "state",
            "_last_state_change",
            "_last_failure_time",
            "_half_open_probes_used",
            "_consecutive_successes",
            "_total_successes",
            "_total_failures",
            "_total_rejected",
            "_total_probes",
        ]
        for field_name in required_fields:
            if field_name not in state_data:
                logger.warning(
                    "Missing field '%s' in circuit breaker state for '%s', resetting to default",
                    field_name,
                    self.provider,
                )
                return

        # Validate state value
        try:
            self.state = CircuitState(state_data["state"])
        except ValueError:
            logger.warning(
                "Invalid state '%s' in circuit breaker state for '%s', resetting to default",
                state_data["state"],
                self.provider,
            )
            return

        self._last_state_change = float(state_data["_last_state_change"])
        self._last_failure_time = float(state_data["_last_failure_time"])
        self._half_open_probes_used = int(state_data["_half_open_probes_used"])
        self._consecutive_successes = int(state_data["_consecutive_successes"])
        self._total_successes = int(state_data["_total_successes"])
        self._total_failures = int(state_data["_total_failures"])
        self._total_rejected = int(state_data["_total_rejected"])
        self._total_probes = int(state_data["_total_probes"])

        # Reset transient state that should not persist
        self._failures.clear()

    async def save_state(self, storage_adapter) -> None:
        """Persist circuit breaker state to storage.

        Args:
            storage_adapter: A BaseStorageAdapter instance.
        """
        try:
            await storage_adapter.write(self._state_key(), self._serialize_state())
        except Exception as e:
            logger.error(
                "Failed to persist circuit breaker state for '%s': %s",
                self.provider,
                e,
                exc_info=True,
            )

    async def load_state(self, storage_adapter) -> None:
        """Load circuit breaker state from storage.

        Args:
            storage_adapter: A BaseStorageAdapter instance.
        """
        try:
            data = await storage_adapter.read(self._state_key())
            self._deserialize_state(data)
            logger.info(
                "Loaded circuit breaker state for '%s': %s",
                self.provider,
                self.state.value,
            )
        except Exception as e:
            logger.info(
                "No persisted state for '%s' or load failed (%s), starting fresh",
                self.provider,
                type(e).__name__,
            )
            # Ensure state is reset to default if load fails
            self.state = CircuitState.CLOSED
            self._last_state_change = time.monotonic()
            self._last_failure_time = 0.0
            self._half_open_probes_used = 0
            self._consecutive_successes = 0
            self._total_successes = 0
            self._total_failures = 0
            self._total_rejected = 0
            self._total_probes = 0
            self._failures.clear()


# ── Registry ──────────────────────────────────────────────────────────────────


class CircuitBreakerRegistry:
    """Registry for per-provider circuit breakers."""

    def __init__(self, storage_adapter=None) -> None:
        self._breakers: dict[str, ProviderCircuitBreaker] = {}
        self._storage_adapter = storage_adapter

    def get(self, provider: str) -> ProviderCircuitBreaker:
        """Get or create a circuit breaker for *provider*."""
        if provider not in self._breakers:
            self._breakers[provider] = ProviderCircuitBreaker(provider)
        return self._breakers[provider]

    async def load_all(self) -> None:
        """Load persisted state for all registered breakers."""
        if not self._storage_adapter:
            return
        for provider, breaker in self._breakers.items():
            await breaker.load_state(self._storage_adapter)

    async def save_all(self) -> None:
        """Persist state for all registered breakers."""
        if not self._storage_adapter:
            return
        for provider, breaker in self._breakers.items():
            await breaker.save_state(self._storage_adapter)

    def reset(self) -> None:
        """Reset all breakers to initial state."""
        self._breakers.clear()


# Singleton registry instance
cb_registry = CircuitBreakerRegistry()
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


async def execute_with_retry(
    operation: Callable[[], Awaitable[T]],
    breaker: ProviderCircuitBreaker,
    *,
    is_failure: Callable[[T], bool] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    """Run one adapter operation with its budget and exponential backoff.

    The breaker is admitted once per logical operation. Only the final failed
    operation consumes a failure, so internal retries do not open the circuit
    prematurely.
    """
    if not await breaker.allow_request():
        raise CircuitBreakerOpen(
            breaker.provider, breaker.remaining_cooldown() or 0.0
        )
    failure_check = is_failure or (lambda result: False)
    for attempt in range(breaker.config.retry_budget + 1):
        try:
            result = await operation()
        except Exception:
            if attempt >= breaker.config.retry_budget:
                await breaker.record_failure()
                raise
        else:
            if not failure_check(result):
                await breaker.record_success()
                return result
            if attempt >= breaker.config.retry_budget:
                await breaker.record_failure()
                return result
        delay = min(
            breaker.config.backoff_initial * (2**attempt),
            breaker.config.backoff_max,
        )
        await sleep(delay)
    raise RuntimeError("unreachable: retry loop exited without result")


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
    "execute_with_retry",
]
