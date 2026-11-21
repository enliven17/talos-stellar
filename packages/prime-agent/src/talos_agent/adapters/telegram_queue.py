"""Durable rate-limit queue for the Telegram adapter.

Telegram limits bots to roughly one message per second per chat and twenty
messages per minute per group, and answers excess traffic with HTTP 429 plus a
``retry_after`` hint.  This module keeps outgoing messages in SQLite
(``telegram_send_queue``) and releases them in FIFO order at a paced rate.

Design notes
------------
* The queue table is the single source of truth for pacing: attempt timestamps
  live on the rows, and a 429 ``retry_after`` is stored per chat.
* Only message text and the chat target are stored.  Bot tokens, request URLs
  and raw Telegram error bodies never reach the database or the logs; failures
  are recorded as short stable codes.
* A send whose outcome is unknown (crash or timeout after the request was
  sent) is marked ``indeterminate`` and is never re-sent automatically,
  because ``sendMessage`` is not idempotent.  This matches how the adapter
  sandbox treats ambiguous writes.
* Rows are claimed with a lease inside a ``BEGIN IMMEDIATE`` transaction, so
  the inline send path and the background worker cannot send the same row.
"""

from __future__ import annotations

import asyncio
import re
import sqlite3
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Iterator

from talos_agent.clock import ClockProtocol, SystemClock
from talos_agent.observability import log

if TYPE_CHECKING:
    from talos_agent.adapters.registry import AdapterRegistry
    from talos_agent.config import Settings

STATE_PENDING: Final = "pending"
STATE_SENDING: Final = "sending"
STATE_SENT: Final = "sent"
STATE_FAILED: Final = "failed"
STATE_INDETERMINATE: Final = "indeterminate"
_ALL_STATES: Final = (
    STATE_PENDING,
    STATE_SENDING,
    STATE_SENT,
    STATE_FAILED,
    STATE_INDETERMINATE,
)

_KINDS: Final = frozenset({"post", "reply"})
_KEY_RE: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CODE_RE: Final = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_TEXT_CHARS: Final = 4096
MAX_RETRY_AFTER_SECONDS: Final = 86400.0
_RATE_WINDOW_SECONDS: Final = 60.0


class TelegramQueueError(Exception):
    """Base class for queue failures. Messages never contain message text."""


class TelegramQueueFullError(TelegramQueueError):
    """The queue already holds the configured maximum of unsent messages."""


class TelegramQueueBusyError(TelegramQueueError):
    """The database was locked or the queue state changed underneath us."""


class TelegramQueueConflictError(TelegramQueueError):
    """A dedupe key was reused for different content."""


@dataclass(frozen=True)
class TelegramQueueConfig:
    min_interval_seconds: float = 1.0
    max_per_minute: int = 20
    max_queue_size: int = 1000
    max_attempts: int = 5
    max_age_seconds: float = 3600.0
    lease_seconds: float = 60.0
    backoff_initial: float = 2.0
    backoff_max: float = 300.0
    retention_seconds: float = 86400.0

    def __post_init__(self) -> None:
        if self.min_interval_seconds < 0:
            raise ValueError("min_interval_seconds must not be negative")
        if self.max_per_minute < 1 or self.max_queue_size < 1 or self.max_attempts < 1:
            raise ValueError("queue limits must be at least 1")
        if self.max_age_seconds <= 0 or self.lease_seconds <= 0:
            raise ValueError("queue age and lease must be greater than zero")
        if self.backoff_initial <= 0 or self.backoff_initial > self.backoff_max:
            raise ValueError("backoff_initial must be positive and no greater than backoff_max")
        # Sent rows double as the pacing window, so they must outlive it.
        if self.retention_seconds < 2 * _RATE_WINDOW_SECONDS:
            raise ValueError("retention_seconds must cover the pacing window")

    @classmethod
    def from_settings(cls, settings: Settings) -> TelegramQueueConfig:
        return cls(
            min_interval_seconds=settings.telegram_min_interval_seconds,
            max_per_minute=settings.telegram_max_per_minute,
            max_queue_size=settings.telegram_queue_max_size,
            max_attempts=settings.telegram_queue_max_attempts,
            max_age_seconds=settings.telegram_queue_max_age_seconds,
        )


@dataclass(frozen=True)
class QueuedMessage:
    id: int
    chat_id: str
    kind: str
    text: str
    reply_to_message_id: int | None
    state: str
    attempt_count: int
    message_id: int | None
    last_error_code: str | None


@dataclass(frozen=True)
class EnqueueResult:
    item_id: int
    created: bool
    state: str
    message_id: int | None


@dataclass(frozen=True)
class ClaimOutcome:
    """Result of a claim attempt.

    ``item`` is set when a message was claimed.  Otherwise ``wait_seconds`` is
    how long until the head of the queue may be attempted, or ``None`` when
    nothing is waiting.
    """

    item: QueuedMessage | None
    wait_seconds: float | None


def _row_to_message(row: sqlite3.Row) -> QueuedMessage:
    return QueuedMessage(
        id=row["id"],
        chat_id=row["chat_id"],
        kind=row["kind"],
        text=row["text"],
        reply_to_message_id=row["reply_to_message_id"],
        state=row["state"],
        attempt_count=row["attempt_count"],
        message_id=row["message_id"],
        last_error_code=row["last_error_code"],
    )


class TelegramSendQueue:
    """SQLite-backed FIFO queue with per-chat pacing."""

    def __init__(
        self,
        db: object,
        config: TelegramQueueConfig | None = None,
        *,
        clock: ClockProtocol | None = None,
    ) -> None:
        self._conn: sqlite3.Connection = db._conn  # type: ignore[attr-defined]
        self.config = config or TelegramQueueConfig()
        self._clock = clock or SystemClock()

    # ── helpers ────────────────────────────────────────────

    def _now(self) -> float:
        return self._clock.now().timestamp()

    @contextmanager
    def _tx(self) -> Iterator[None]:
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            yield
            self._conn.commit()
        except sqlite3.OperationalError as exc:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise TelegramQueueBusyError("telegram queue state is busy") from exc
        except BaseException:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise

    def backoff_delay(self, attempt_count: int) -> float:
        """Exponential delay for the given (1-based) attempt, capped."""
        exponent = max(attempt_count - 1, 0)
        return min(self.config.backoff_initial * (2 ** min(exponent, 30)), self.config.backoff_max)

    # ── producer side ──────────────────────────────────────

    def enqueue(
        self,
        *,
        chat_id: str,
        kind: str,
        text: str,
        reply_to_message_id: int | None = None,
        dedupe_key: str | None = None,
    ) -> EnqueueResult:
        if kind not in _KINDS:
            raise ValueError("invalid queue message kind")
        if not isinstance(chat_id, str) or not chat_id.strip():
            raise ValueError("chat_id must be a non-empty string")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("message text must not be empty")
        if len(text) > MAX_TEXT_CHARS:
            raise ValueError("message text exceeds the Telegram limit")
        if dedupe_key is not None and not _KEY_RE.fullmatch(dedupe_key):
            raise ValueError("dedupe key is invalid")
        now = self._now()
        with self._tx():
            if dedupe_key is not None:
                row = self._conn.execute(
                    "SELECT * FROM telegram_send_queue WHERE dedupe_key = ?", (dedupe_key,)
                ).fetchone()
                if row is not None:
                    if (
                        row["chat_id"] != chat_id
                        or row["kind"] != kind
                        or row["text"] != text
                        or row["reply_to_message_id"] != reply_to_message_id
                    ):
                        raise TelegramQueueConflictError("dedupe key was already used for different content")
                    return EnqueueResult(row["id"], False, row["state"], row["message_id"])
            self._expire_locked(now)
            depth = self._conn.execute(
                "SELECT COUNT(*) FROM telegram_send_queue WHERE state IN ('pending', 'sending')"
            ).fetchone()[0]
            if depth >= self.config.max_queue_size:
                raise TelegramQueueFullError("telegram send queue is full")
            cursor = self._conn.execute(
                """
                INSERT INTO telegram_send_queue (
                    dedupe_key, chat_id, kind, text, reply_to_message_id, state,
                    next_attempt_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (dedupe_key, chat_id, kind, text, reply_to_message_id, now, now, now),
            )
            item_id = int(cursor.lastrowid)
        return EnqueueResult(item_id, True, STATE_PENDING, None)

    # ── consumer side ──────────────────────────────────────

    def claim_next(self, *, only_id: int | None = None) -> ClaimOutcome:
        """Claim the head of the queue if it is due and pacing allows.

        With ``only_id`` the claim succeeds only when that message is the head,
        so an inline send never jumps ahead of older backlog.
        """
        now = self._now()
        with self._tx():
            self._expire_locked(now)
            if self._conn.execute(
                "SELECT 1 FROM telegram_send_queue WHERE state = 'sending' LIMIT 1"
            ).fetchone():
                return ClaimOutcome(None, max(self.config.min_interval_seconds, 0.25))
            head = self._conn.execute(
                "SELECT * FROM telegram_send_queue WHERE state = 'pending' ORDER BY id LIMIT 1"
            ).fetchone()
            if head is None:
                return ClaimOutcome(None, None)
            if only_id is not None and head["id"] != only_id:
                return ClaimOutcome(None, self._wait_locked(head, now))
            wait = self._wait_locked(head, now)
            if wait > 0:
                return ClaimOutcome(None, wait)
            self._conn.execute(
                """
                UPDATE telegram_send_queue
                SET state = 'sending', attempt_count = attempt_count + 1,
                    last_attempt_at = ?, lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND state = 'pending'
                """,
                (now, now + self.config.lease_seconds, now, head["id"]),
            )
            claimed = self._conn.execute(
                "SELECT * FROM telegram_send_queue WHERE id = ?", (head["id"],)
            ).fetchone()
        return ClaimOutcome(_row_to_message(claimed), 0.0)

    def get(self, item_id: int) -> QueuedMessage | None:
        row = self._conn.execute(
            "SELECT * FROM telegram_send_queue WHERE id = ?", (item_id,)
        ).fetchone()
        return _row_to_message(row) if row is not None else None

    def mark_sent(self, item_id: int, message_id: int | None) -> None:
        self._finish(item_id, STATE_SENT, code=None, message_id=message_id)

    def mark_failed(self, item_id: int, code: str) -> None:
        self._finish(item_id, STATE_FAILED, code=code)

    def mark_indeterminate(self, item_id: int, code: str) -> None:
        self._finish(item_id, STATE_INDETERMINATE, code=code)

    def mark_retry(
        self,
        item_id: int,
        delay_seconds: float,
        code: str,
        *,
        consume_attempt: bool = True,
    ) -> str:
        """Return a claimed message to the queue; returns the resulting state.

        A rate-limit response does not consume an attempt (the message was
        never rejected for its content); ``max_age_seconds`` bounds those
        retries instead.  Otherwise the row fails once attempts are exhausted.
        """
        self._check_code(code)
        delay = min(max(float(delay_seconds), 0.0), MAX_RETRY_AFTER_SECONDS)
        now = self._now()
        with self._tx():
            row = self._conn.execute(
                "SELECT state, attempt_count FROM telegram_send_queue WHERE id = ?", (item_id,)
            ).fetchone()
            if row is None or row["state"] != STATE_SENDING:
                raise TelegramQueueBusyError("telegram queue message is no longer claimed")
            attempts = row["attempt_count"] - (0 if consume_attempt else 1)
            if consume_attempt and attempts >= self.config.max_attempts:
                state = STATE_FAILED
                code = "max_attempts"
            else:
                state = STATE_PENDING
            self._conn.execute(
                """
                UPDATE telegram_send_queue
                SET state = ?, attempt_count = ?, next_attempt_at = ?, lease_expires_at = NULL,
                    last_error_code = ?, updated_at = ?
                WHERE id = ?
                """,
                (state, attempts, now + delay, code, now, item_id),
            )
        return state

    def block_chat(self, chat_id: str, seconds: float) -> None:
        """Record a Telegram ``retry_after`` for a chat (never shortens an existing block)."""
        until = self._now() + min(max(float(seconds), 0.0), MAX_RETRY_AFTER_SECONDS)
        with self._tx():
            self._conn.execute(
                """
                INSERT INTO telegram_rate_state (chat_id, blocked_until) VALUES (?, ?)
                ON CONFLICT(chat_id) DO UPDATE SET
                    blocked_until = MAX(blocked_until, excluded.blocked_until)
                """,
                (chat_id, until),
            )

    def prune(self) -> int:
        """Delete finished rows older than the retention window.

        ``indeterminate`` rows are kept until an operator reconciles them.
        """
        cutoff = self._now() - self.config.retention_seconds
        with self._tx():
            cursor = self._conn.execute(
                """
                DELETE FROM telegram_send_queue
                WHERE state IN ('sent', 'failed') AND updated_at < ?
                """,
                (cutoff,),
            )
            self._conn.execute("DELETE FROM telegram_rate_state WHERE blocked_until < ?", (cutoff,))
            return cursor.rowcount

    def stats(self) -> dict[str, Any]:
        """Operator-facing counters. Contains no message content."""
        now = self._now()
        counts = dict.fromkeys(_ALL_STATES, 0)
        for row in self._conn.execute(
            "SELECT state, COUNT(*) AS n FROM telegram_send_queue GROUP BY state"
        ):
            counts[row["state"]] = row["n"]
        oldest = self._conn.execute(
            "SELECT MIN(created_at) FROM telegram_send_queue WHERE state IN ('pending', 'sending')"
        ).fetchone()[0]
        blocked = self._conn.execute(
            "SELECT MAX(blocked_until) FROM telegram_rate_state"
        ).fetchone()[0]
        return {
            "counts": counts,
            "oldest_unsent_age_seconds": None if oldest is None else max(now - oldest, 0.0),
            "rate_limited_for_seconds": None if not blocked or blocked <= now else blocked - now,
        }

    # ── internals ──────────────────────────────────────────

    @staticmethod
    def _check_code(code: str) -> None:
        if not isinstance(code, str) or not _CODE_RE.fullmatch(code):
            raise ValueError("error code must be a short snake_case identifier")

    def _finish(
        self,
        item_id: int,
        state: str,
        *,
        code: str | None,
        message_id: int | None = None,
    ) -> None:
        if code is not None:
            self._check_code(code)
        now = self._now()
        with self._tx():
            cursor = self._conn.execute(
                """
                UPDATE telegram_send_queue
                SET state = ?, last_error_code = ?, message_id = ?, lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ? AND state = 'sending'
                """,
                (state, code, message_id, now, item_id),
            )
            if cursor.rowcount != 1:
                raise TelegramQueueBusyError("telegram queue message is no longer claimed")

    def _expire_locked(self, now: float) -> None:
        """Resolve stale rows. Must run inside ``_tx``."""
        self._conn.execute(
            """
            UPDATE telegram_send_queue
            SET state = 'indeterminate', last_error_code = 'lease_expired',
                lease_expires_at = NULL, updated_at = ?
            WHERE state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
            """,
            (now, now),
        )
        self._conn.execute(
            """
            UPDATE telegram_send_queue
            SET state = 'failed', last_error_code = 'expired', updated_at = ?
            WHERE state = 'pending' AND created_at + ? <= ?
            """,
            (now, self.config.max_age_seconds, now),
        )

    def _wait_locked(self, head: sqlite3.Row, now: float) -> float:
        """Seconds until ``head`` may be attempted (0 when it may go now)."""
        chat_id = head["chat_id"]
        waits = [head["next_attempt_at"] - now]
        blocked = self._conn.execute(
            "SELECT blocked_until FROM telegram_rate_state WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        if blocked is not None:
            waits.append(blocked["blocked_until"] - now)
        recent = [
            r[0]
            for r in self._conn.execute(
                """
                SELECT last_attempt_at FROM telegram_send_queue
                WHERE chat_id = ? AND last_attempt_at IS NOT NULL AND last_attempt_at > ?
                ORDER BY last_attempt_at ASC
                """,
                (chat_id, now - _RATE_WINDOW_SECONDS),
            )
        ]
        if recent:
            waits.append(recent[-1] + self.config.min_interval_seconds - now)
            if len(recent) >= self.config.max_per_minute:
                waits.append(recent[len(recent) - self.config.max_per_minute] + _RATE_WINDOW_SECONDS - now)
        return max(max(waits), 0.0)


@dataclass(frozen=True)
class DrainReport:
    delivered: int
    wait_seconds: float | None


class TelegramQueueWorker:
    """Background drain loop. Delivers through the registered adapter.

    Delivery goes through ``adapter.post(..., queue_item_id=...)`` so that,
    when the adapter sandbox is enabled, every send is still admitted,
    budgeted and network-restricted by the sandbox.
    """

    def __init__(
        self,
        queue: TelegramSendQueue,
        registry_provider: Callable[[], AdapterRegistry | None],
        *,
        channel: str = "telegram",
        idle_interval: float = 1.0,
        max_batch: int = 20,
        prune_interval: float = 3600.0,
    ) -> None:
        self._queue = queue
        self._registry_provider = registry_provider
        self._channel = channel
        self._idle_interval = idle_interval
        self._max_batch = max_batch
        self._prune_interval = prune_interval
        self._last_prune = 0.0

    async def drain_once(self) -> DrainReport:
        delivered = 0
        wait: float | None = None
        for _ in range(self._max_batch):
            registry = self._registry_provider()
            adapter = registry.get(self._channel) if registry is not None else None
            if adapter is None:
                # Checked before claiming so an unavailable adapter never leaves rows leased.
                return DrainReport(delivered, self._idle_interval)
            outcome = self._queue.claim_next()
            if outcome.item is None:
                return DrainReport(delivered, outcome.wait_seconds)
            item = outcome.item
            try:
                await adapter.post(
                    item.text,
                    queue_item_id=item.id,
                    operation_id=f"tgq-{item.id}-{item.attempt_count}",
                )
                delivered += 1
            except Exception as exc:
                # Only stable codes are logged; exception text may carry provider detail.
                log.warning(
                    "telegram_queue_delivery_error",
                    queue_id=item.id,
                    error_type=type(exc).__name__,
                )
                self._release_if_unsent(item.id, exc)
        return DrainReport(delivered, wait)

    def _release_if_unsent(self, item_id: int, exc: Exception) -> None:
        """Requeue a claimed row when the failure happened before any I/O."""
        from talos_agent.adapters.capability import (
            AdapterBusyError,
            AdapterResourceLimitError,
            CapabilityDeniedError,
            DuplicateInvocationError,
            InvocationConflictError,
        )

        pre_io = (
            AdapterBusyError,
            AdapterResourceLimitError,
            CapabilityDeniedError,
            DuplicateInvocationError,
            InvocationConflictError,
        )
        if not isinstance(exc, pre_io):
            return  # ambiguous: the lease expires into 'indeterminate'
        current = self._queue.get(item_id)
        if current is not None and current.state == STATE_SENDING:
            try:
                self._queue.mark_retry(item_id, self._queue.backoff_delay(current.attempt_count), "delivery_denied")
            except TelegramQueueError:
                pass

    async def run(self, shutdown_event: asyncio.Event) -> None:
        while not shutdown_event.is_set():
            delay = self._idle_interval
            try:
                self._maybe_prune()
                report = await self.drain_once()
                if report.delivered:
                    log.info("telegram_queue_batch", delivered=report.delivered, **self._queue.stats()["counts"])
                if report.wait_seconds is not None:
                    delay = min(max(report.wait_seconds, 0.05), 30.0)
            except TelegramQueueError:
                log.error("telegram_queue_batch_failed", error_code="queue_busy")
            except Exception as exc:
                log.error("telegram_queue_batch_failed", error_code="batch_failure", error_type=type(exc).__name__)
            try:
                await asyncio.wait_for(shutdown_event.wait(), timeout=delay)
                break
            except asyncio.TimeoutError:
                pass

    def _maybe_prune(self) -> None:
        now = self._queue._now()
        if now - self._last_prune >= self._prune_interval:
            self._last_prune = now
            self._queue.prune()


__all__ = [
    "ClaimOutcome",
    "DrainReport",
    "EnqueueResult",
    "QueuedMessage",
    "TelegramQueueBusyError",
    "TelegramQueueConfig",
    "TelegramQueueConflictError",
    "TelegramQueueError",
    "TelegramQueueFullError",
    "TelegramQueueWorker",
    "TelegramSendQueue",
]
