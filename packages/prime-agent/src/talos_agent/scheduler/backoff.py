"""Backoff helpers for scheduler tasks.

Provides in-memory ``Backoff`` and durable ``DurableBackoff`` which persists
retry state to SQLite so task restarts resume the correct wait.
"""

from __future__ import annotations

import hashlib
import logging
import math
import random
from datetime import datetime, timedelta

from talos_agent.clock import ClockProtocol, SystemClock

logger = logging.getLogger(__name__)


def _validate_jitter(jitter: float) -> None:
    try:
        valid = (
            not isinstance(jitter, bool)
            and isinstance(jitter, (int, float))
            and math.isfinite(float(jitter))
            and 0 <= jitter <= 1
        )
    except (OverflowError, ValueError):
        valid = False
    if not valid:
        raise ValueError("jitter must be a finite number between 0 and 1")


class Backoff:
    """Exponential backoff with jitter for task retries."""

    def __init__(
        self,
        base_delay: float,
        initial_backoff: float = 2.0,
        max_backoff: float = 300.0,
        jitter: float = 0.2,
    ):
        _validate_jitter(jitter)
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

    Retry jitter is stable for a task, agent identity, and failure count. The
    optional identity should be stable and non-sensitive; it is hashed in memory
    and is not persisted or logged.

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
        jitter_identity: str | None = None,
    ):
        _validate_jitter(jitter)
        if jitter_identity is not None and not isinstance(jitter_identity, str):
            raise ValueError("jitter identity must be a string")
        self.task_name = task_name
        self._db = db
        self.base_delay = base_delay
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff
        self.jitter = jitter
        self._jitter_identity = jitter_identity or task_name
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

    @property
    def terminal(self) -> bool:
        """Alias for :attr:`is_terminal` used by scheduler call sites."""
        return self._terminal

    def wait_remaining(self) -> float:
        """Seconds until the next attempt is allowed (0 if overdue or no state)."""
        if self._next_attempt_at is None:
            return 0.0
        remaining = (self._next_attempt_at - self._clock.now()).total_seconds()
        return max(remaining, 0.0)

    def delay_until_next_attempt(self) -> float:
        """Return the persisted deadline remainder, or the next normal delay."""
        if self._next_attempt_at is not None:
            return self.wait_remaining()
        return self.next_delay()

    def next_delay(self) -> float:
        """Compute the next sleep duration (same semantics as ``Backoff.next_delay``)."""
        if self.fail_count == 0:
            return self.base_delay

        delay = self.initial_backoff * (2 ** (self.fail_count - 1))
        delay = min(delay, self.max_backoff)

        if self.jitter > 0:
            material = (
                f"{self.task_name}\0{self._jitter_identity}\0{self.fail_count}"
            ).encode()
            sample = int.from_bytes(
                hashlib.blake2b(material, digest_size=8).digest(), "big"
            ) / ((1 << 64) - 1)
            delay *= 1 - self.jitter + 2 * self.jitter * sample

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
