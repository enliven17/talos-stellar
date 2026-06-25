"""Shared retry helpers for external HTTP and LLM calls.

Transient failures (network timeouts, 429/502/503/504) automatically retry
with exponential backoff plus jitter before propagating. Without this,
every agent cycle pays full price for a single hiccup.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, TypeVar

import httpx
from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
)

logger = logging.getLogger(__name__)

RETRYABLE_STATUSES: frozenset[int] = frozenset({429, 502, 503, 504})
MAX_ATTEMPTS = 3
WAIT_INITIAL = 1.0
WAIT_MAX = 10.0

T = TypeVar("T")


class RetryableHTTPError(Exception):
    """Wraps a retryable HTTP response so tenacity can drive retries."""

    def __init__(self, response: httpx.Response):
        self.response = response
        self.status_code = response.status_code
        try:
            url = str(response.request.url)
        except RuntimeError:
            url = str(response.url)
        super().__init__(f"HTTP {response.status_code} from {url}")


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (RetryableHTTPError, httpx.TimeoutException)):
        return True
    # openai SDK errors — imported lazily so http.py doesn't hard-require openai.
    try:
        import openai
    except ImportError:
        return False
    if isinstance(exc, (openai.APITimeoutError, openai.APIConnectionError)):
        return True
    if isinstance(exc, openai.APIStatusError):
        status = getattr(exc, "status_code", None)
        return status in RETRYABLE_STATUSES
    return False


def _log_before_sleep(retry_state: RetryCallState) -> None:
    exc = retry_state.outcome.exception() if retry_state.outcome else None
    status = getattr(exc, "status_code", None)
    detail = f"status={status}" if status is not None else type(exc).__name__
    next_wait = getattr(retry_state.next_action, "sleep", 0.0) or 0.0
    logger.warning(
        "HTTP retry %d/%d (%s) — sleeping %.2fs",
        retry_state.attempt_number,
        MAX_ATTEMPTS,
        detail,
        next_wait,
    )


def _retry_policy() -> AsyncRetrying:
    return AsyncRetrying(
        stop=stop_after_attempt(MAX_ATTEMPTS),
        wait=wait_exponential_jitter(initial=WAIT_INITIAL, max=WAIT_MAX),
        retry=retry_if_exception(_is_retryable),
        before_sleep=_log_before_sleep,
        reraise=True,
    )


async def request_with_retry(
    send: Callable[[], Awaitable[httpx.Response]],
) -> httpx.Response:
    """Execute an httpx call with bounded retries on transient failures.

    Retries on httpx.TimeoutException or responses with status in
    {429, 502, 503, 504}. After MAX_ATTEMPTS the final exception
    propagates (RetryableHTTPError or httpx.TimeoutException).
    Non-retryable responses (including other 4xx/5xx) are returned
    so callers can inspect status_code as before.
    """
    async for attempt in _retry_policy():
        with attempt:
            response = await send()
            if response.status_code in RETRYABLE_STATUSES:
                raise RetryableHTTPError(response)
            return response
    raise RuntimeError("unreachable: retry loop exited without result")


async def call_with_retry(operation: Callable[[], Awaitable[T]]) -> T:
    """Retry an arbitrary awaitable on transient external failures.

    Used for SDK calls (OpenAI/Groq) where the caller doesn't see the
    raw httpx.Response. Retries on httpx.TimeoutException plus openai
    SDK exceptions matching {429, 502, 503, 504} or connection/timeout.
    """
    async for attempt in _retry_policy():
        with attempt:
            return await operation()
    raise RuntimeError("unreachable: retry loop exited without result")
