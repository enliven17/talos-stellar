"""Shared retry helpers for external HTTP and LLM calls.

Transient failures (network timeouts, 429/502/503/504) automatically retry
with exponential backoff plus jitter before propagating. Without this,
every agent cycle pays full price for a single hiccup.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, TypeVar

import httpx
import json
import re
import unicodedata
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
LOG_RESPONSE_SUMMARY_MAX_CHARS = 1024
SECRET_FIELD_NAMES = {
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "apiKey",
    "authorization",
    "auth",
    "token",
    "secret",
    "password",
    "private_key",
    "privateKey",
}

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


def _sanitize_json_value(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: ("[REDACTED]" if key.lower() in SECRET_FIELD_NAMES else _sanitize_json_value(val))
            for key, val in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_json_value(item) for item in value]
    return value

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _strip_control_chars(text: str) -> str:
    """Neutralize CR/LF and other control chars to prevent log injection."""
    return _CONTROL_CHAR_RE.sub(" ", text)

def _sanitize_response_text(text: str) -> str:
    normalized = _strip_control_chars(unicodedata.normalize("NFC", text))
    try:
        payload = json.loads(normalized)
    except Exception:
        sanitized = normalized
    else:
        sanitized = json.dumps(_sanitize_json_value(payload), ensure_ascii=False)

    sanitized = re.sub(
        r"(?i)(Bearer|Token)\s+[A-Za-z0-9\-\._~\+/]+=*",
        "[REDACTED]",
        sanitized,
    )
    sanitized = re.sub(r"S[A-Z2-7]{55}", "[REDACTED]", sanitized)
    sanitized = re.sub(
        r"""(?i)(?:api[_-]?key|token|secret|authorization|password|private[_-]?key)["'`]?\s*[:=]\s*["'`]([^"'`\s]+)["'`]?""",
        lambda m: f"{m.group(0).split(m.group(1))[0]}[REDACTED]",
        sanitized,
    )
    if len(sanitized) > LOG_RESPONSE_SUMMARY_MAX_CHARS:
        return sanitized[: LOG_RESPONSE_SUMMARY_MAX_CHARS - 1] + "…"
    return sanitized


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
