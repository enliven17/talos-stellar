"""Shared retry helpers for external HTTP and LLM calls.

Transient failures (network timeouts, 429/502/503/504) automatically retry
with exponential backoff plus jitter before propagating. Without this,
every agent cycle pays full price for a single hiccup.

Circuit Breaker Integration
---------------------------
All retry-wrapped calls optionally pass through a per-provider circuit
breaker that stops cascading failures when a provider is degraded.

* Callers may pass ``provider`` to enable circuit-breaker gating.
* When the circuit is OPEN, the request is rejected with
  :class:`CircuitBreakerOpen` *before* any HTTP call is made — no
  network resources are consumed.
* When the circuit is HALF_OPEN, a limited number of probe requests
  are let through to test recovery.
* Successes and failures are recorded on the circuit breaker after
  each request (or after all retry attempts are exhausted).
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx
from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential_jitter,
)

from talos_agent.circuit_breaker import (
    CircuitBreakerOpen,
    ProviderCircuitBreaker,
    cb_registry,
)
from talos_agent.redact import (
    REDACT_FIELD_NAMES as SECRET_FIELD_NAMES,
    redact_json_value as _sanitize_json_value,
    redact_text as _sanitize_response_text,
    redact_value as _strip_control_chars,
)

logger = logging.getLogger(__name__)

RETRYABLE_STATUSES: frozenset[int] = frozenset({429, 502, 503, 504})
MAX_ATTEMPTS = 3
WAIT_INITIAL = 1.0
WAIT_MAX = 10.0
LOG_RESPONSE_SUMMARY_MAX_CHARS = 1024

DEFAULT_TOOL_TIMEOUT_SECONDS = 30.0
MAX_TOOL_TIMEOUT_SECONDS = 300.0

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


class ToolTimeoutError(Exception):
    """Raised when a tool call exceeds its execution deadline."""

    def __init__(self, tool_name: str, timeout: float):
        self.tool_name = tool_name
        self.timeout = timeout
        self.timed_out = True
        self.result = {
            "status": "timeout",
            "tool_name": tool_name,
            "timeout_seconds": timeout,
        }
        super().__init__(f"Tool {tool_name!r} timed out after {timeout:g}s")


# _sanitize_json_value, _strip_control_chars, and _sanitize_response_text are
# imported from talos_agent.redact above and remain available for callers that
# reference them via this module (backward-compatible aliases).


def _extract_safe_response_summary(response: httpx.Response) -> str | None:
    try:
        body = response.text
    except Exception:
        return None
    if not body:
        return None
    return _sanitize_response_text(body)


def _extract_safe_exception_summary(exc: BaseException) -> str | None:
    response = getattr(exc, "response", None)
    if isinstance(response, httpx.Response):
        return _extract_safe_response_summary(response)
    body = getattr(exc, "body", None)
    if isinstance(body, str) and body:
        return _sanitize_response_text(body)
    return None


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
    body_summary = _extract_safe_exception_summary(exc)
    next_wait = getattr(retry_state.next_action, "sleep", 0.0) or 0.0
    if body_summary is not None:
        logger.warning(
            "HTTP retry %d/%d (%s) — sleeping %.2fs — response=%s",
            retry_state.attempt_number,
            MAX_ATTEMPTS,
            detail,
            next_wait,
            body_summary,
        )
    else:
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


def validate_tool_timeout(timeout: float | None) -> float:
    """Validate a tool timeout against safe bounds."""
    if timeout is None:
        return DEFAULT_TOOL_TIMEOUT_SECONDS
    try:
        parsed = float(timeout)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("tool timeout must be a number") from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError("tool timeout must be a positive finite number")
    if parsed > MAX_TOOL_TIMEOUT_SECONDS:
        raise ValueError(
            f"tool timeout cannot exceed {MAX_TOOL_TIMEOUT_SECONDS:g} seconds"
        )
    return parsed


def _record_tool_timeout_metric(tool_name: str, timeout: float) -> None:
    # Keep metrics free of operation args/response bodies.
    logger.warning(
        "Tool execution timeout; tool_name=%s timeout_seconds=%.3f",
        _strip_control_chars(str(tool_name)),
        timeout,
    )


async def call_with_tool_timeout(
    operation: Callable[[], Awaitable[T]],
    *,
    tool_name: str,
    timeout: float | None = None,
) -> T:
    """Run an external tool call under a bounded execution deadline.

    Shared by legacy and routed agent loops; ``asyncio.wait_for`` cancels the
    underlying operation when the deadline elapses and on caller cancellation.
    """
    deadline = validate_tool_timeout(timeout)
    try:
        return await asyncio.wait_for(operation(), timeout=deadline)
    except asyncio.TimeoutError:
        _record_tool_timeout_metric(tool_name, deadline)
        raise ToolTimeoutError(tool_name, deadline) from None


async def request_with_retry(
    send: Callable[[], Awaitable[httpx.Response]],
    provider: str | None = None,
    timeout: float | None = None,
) -> httpx.Response:
    """Execute an httpx call with bounded retries on transient failures.

    Parameters
    ----------
    send:
        Async callable that returns an httpx.Response.
    provider:
        Optional provider name for circuit-breaker gating (e.g.
        ``"groq"``, ``"talos_web_api"``, ``"discord"``).  When set,
        the circuit breaker is checked *before* each call attempt and
        failures are recorded after exhausting retries.

    Returns
    -------
    httpx.Response from the successful call.

    Raises
    ------
    CircuitBreakerOpen
        If the circuit is OPEN and *provider* was given.
    RetryableHTTPError
        After MAX_ATTEMPTS retryable failures.
    httpx.TimeoutException
        After MAX_ATTEMPTS timeouts.

    Non-retryable responses (including other 4xx/5xx) are returned
    so callers can inspect status_code as before.
    """
    timeout = validate_tool_timeout(timeout)
    breaker: ProviderCircuitBreaker | None = None
    if provider:
        breaker = cb_registry.get(provider)
        if not await breaker.allow_request():
            retry_after = breaker.remaining_cooldown() or 0.0
            raise CircuitBreakerOpen(provider, retry_after)

    async for attempt in _retry_policy():
        with attempt:
            try:
                response = await call_with_tool_timeout(
                    send,
                    tool_name=provider or "http_request",
                    timeout=timeout,
                )
                if response.status_code in RETRYABLE_STATUSES:
                    raise RetryableHTTPError(response)
            except Exception:
                if breaker:
                    await breaker.record_failure()
                raise

            # Success — record on circuit breaker.
            if breaker:
                await breaker.record_success()
            return response

    raise RuntimeError("unreachable: retry loop exited without result")


async def call_with_retry(
    operation: Callable[[], Awaitable[T]],
    provider: str | None = None,
    timeout: float | None = None,
) -> T:
    """Retry an arbitrary awaitable on transient external failures.

    Used for SDK calls (OpenAI/Groq) where the caller doesn't see the
    raw httpx.Response. Retries on httpx.TimeoutException plus openai
    SDK exceptions matching {429, 502, 503, 504} or connection/timeout.

    Parameters
    ----------
    operation:
        Async callable to retry.
    provider:
        Optional provider name for circuit-breaker gating (e.g.
        ``"groq"``, ``"openai"``).

    Raises
    ------
    CircuitBreakerOpen
        If the circuit is OPEN and *provider* was given.
    """
    timeout = validate_tool_timeout(timeout)
    breaker: ProviderCircuitBreaker | None = None
    if provider:
        breaker = cb_registry.get(provider)
        if not await breaker.allow_request():
            retry_after = breaker.remaining_cooldown() or 0.0
            raise CircuitBreakerOpen(provider, retry_after)

    async for attempt in _retry_policy():
        with attempt:
            try:
                return await call_with_tool_timeout(
                    operation,
                    tool_name=provider or "llm_call",
                    timeout=timeout,
                )
            except Exception:
                if breaker:
                    await breaker.record_failure()
                raise

    raise RuntimeError("unreachable: retry loop exited without result")
