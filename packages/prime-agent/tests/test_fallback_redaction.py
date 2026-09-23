"""Redaction of retry and circuit-breaker diagnostics (#439).

Every diagnostic path a provider failure can reach, the fallback chain's exception,
timeout-cause and open-circuit branches and the HTTP retry log, must go through the
existing redaction helper, while the safe metadata (provider, attempt count, exception
type) stays readable and the retry and breaker decisions do not change.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest
import respx
from httpx import Response
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_none

from talos_agent import http as http_module
from talos_agent.circuit_breaker import CircuitBreakerOpen, cb_registry
from talos_agent.http import MAX_ATTEMPTS, RetryableHTTPError, request_with_retry
from talos_agent.routing.fallback import (
    FallbackChain,
    _summarise_exception,
    fallback_metrics,
)

BEARER = "sk-live-4f9c2a7e1b"
API_KEY = "ak-9d8c7b6a5f"
PAYMENT = "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QifQ"
NESTED_TOKEN = "tok-nested-31337"

SECRETS = (BEARER, API_KEY, PAYMENT, NESTED_TOKEN)


@pytest.fixture(autouse=True)
def _reset_state():
    fallback_metrics.reset()
    cb_registry.reset_all()
    yield
    cb_registry.reset_all()


@pytest.fixture(autouse=True)
def _no_sleep_between_retries(monkeypatch):
    def fast_policy() -> AsyncRetrying:
        return AsyncRetrying(
            stop=stop_after_attempt(MAX_ATTEMPTS),
            wait=wait_none(),
            retry=retry_if_exception(http_module._is_retryable),
            before_sleep=http_module._log_before_sleep,
            reraise=True,
        )

    monkeypatch.setattr(http_module, "_retry_policy", fast_policy)


def _assert_no_secret(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text, f"secret leaked: {text!r}"


def _failing_with(message: str):
    async def op(provider, *args):
        if provider == "groq":
            raise RuntimeError(message)
        return "ok"

    return op


# ── Fallback chain: exception path ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_exception_path_redacts_tokens(caplog):
    chain = FallbackChain(["groq", "openai"])
    message = f"upstream refused: Authorization: Bearer {BEARER} and api_key={API_KEY}"

    with caplog.at_level(logging.WARNING, logger="talos_agent.routing.fallback"):
        result = await chain.execute(_failing_with(message))

    assert result.success is True
    assert result.provider_name == "openai"
    ((provider, detail),) = result.attempts
    assert provider == "groq"
    assert detail.startswith("RuntimeError: ")
    assert "[REDACTED]" in detail
    _assert_no_secret(detail)
    for record in caplog.records:
        _assert_no_secret(record.getMessage())
    assert any("'groq' failed" in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_exception_path_redacts_payment_header(caplog):
    chain = FallbackChain(["groq", "openai"])
    message = f"402 on retry, sent X-PAYMENT: {PAYMENT}"

    with caplog.at_level(logging.WARNING, logger="talos_agent.routing.fallback"):
        result = await chain.execute(_failing_with(message))

    _assert_no_secret(result.attempts[0][1])
    for record in caplog.records:
        _assert_no_secret(record.getMessage())


@pytest.mark.asyncio
async def test_exception_path_redacts_nested_payload():
    chain = FallbackChain(["groq", "openai"])
    payload = {
        "request": {
            "headers": {"X-PAYMENT": PAYMENT},
            "body": {"auth": {"token": NESTED_TOKEN}, "model": "llama-3"},
        }
    }

    result = await chain.execute(_failing_with(json.dumps(payload)))

    detail = result.attempts[0][1]
    _assert_no_secret(detail)
    # The non-sensitive parts of the payload stay readable.
    assert "llama-3" in detail


@pytest.mark.asyncio
async def test_exhausted_chain_log_carries_no_secret(caplog):
    chain = FallbackChain(["groq", "openai"])

    async def op(provider, *args):
        raise RuntimeError(f"Bearer {BEARER} rejected by {provider}")

    with caplog.at_level(logging.ERROR, logger="talos_agent.routing.fallback"):
        result = await chain.execute(op)

    assert result.success is False
    assert result.total_attempts == 2
    exhausted = [
        r.getMessage() for r in caplog.records if "exhausted" in r.getMessage()
    ]
    assert exhausted
    _assert_no_secret(exhausted[0])
    assert "groq" in exhausted[0] and "openai" in exhausted[0]


def test_secret_straddling_the_truncation_point_is_not_partially_leaked():
    # Redaction must run BEFORE truncation: cutting first would leave a token prefix the
    # pattern no longer matches.
    message = "x" * 180 + f" Bearer {BEARER}" + "y" * 100

    summary = _summarise_exception(RuntimeError(message))

    assert "sk-live" not in summary
    assert len(summary) <= len("RuntimeError: ") + 200


# ── Fallback chain: open-circuit path ────────────────────────────────────────


@pytest.mark.asyncio
async def test_open_circuit_path_redacts_hint_and_keeps_metadata(caplog):
    chain = FallbackChain(["groq", "openai"])

    async def op(provider, *args):
        if provider == "groq":
            raise CircuitBreakerOpen("groq", 12.5, fallback_hint=f"token={API_KEY}")
        return "ok"

    with caplog.at_level(logging.WARNING, logger="talos_agent.routing.fallback"):
        result = await chain.execute(op)

    detail = result.attempts[0][1]
    _assert_no_secret(detail)
    assert "Circuit breaker OPEN for 'groq'" in detail
    assert "12.5s" in detail
    for record in caplog.records:
        _assert_no_secret(record.getMessage())


# ── Decisions are unchanged ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redaction_does_not_change_breaker_or_fallback_decisions():
    chain = FallbackChain(["groq", "openai"])

    result = await chain.execute(_failing_with(f"Bearer {BEARER}"))

    assert result.success is True
    assert result.provider_name == "openai"
    assert result.total_attempts == 2
    assert cb_registry.get("groq").metrics().to_dict()["total_failures"] == 1
    assert cb_registry.get("openai").metrics().to_dict()["total_successes"] == 1
    snap = fallback_metrics.snapshot()
    assert snap.attempts.get("groq") == 1
    assert snap.successes.get("openai") == 1


# ── HTTP retry path ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
@respx.mock
async def test_retry_log_redacts_payment_header_in_nested_body(caplog):
    body = {"error": "payment required", "echo": {"headers": {"X-PAYMENT": PAYMENT}}}
    respx.get("https://api.example.com/pay").mock(return_value=Response(503, json=body))

    async with httpx.AsyncClient() as client:
        with (
            caplog.at_level(logging.WARNING, logger="talos_agent.http"),
            pytest.raises(RetryableHTTPError),
        ):
            await request_with_retry(lambda: client.get("https://api.example.com/pay"))

    retry_logs = [
        r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()
    ]
    assert len(retry_logs) == MAX_ATTEMPTS - 1
    for message in retry_logs:
        _assert_no_secret(message)
        assert "status=503" in message
        assert "payment required" in message


@pytest.mark.asyncio
@respx.mock
async def test_retry_log_redacts_payment_header_in_text_body(caplog):
    respx.get("https://api.example.com/pay").mock(
        return_value=Response(503, text=f"upstream echoed x-payment={PAYMENT}")
    )

    async with httpx.AsyncClient() as client:
        with (
            caplog.at_level(logging.WARNING, logger="talos_agent.http"),
            pytest.raises(RetryableHTTPError),
        ):
            await request_with_retry(lambda: client.get("https://api.example.com/pay"))

    retry_logs = [
        r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()
    ]
    assert retry_logs
    for message in retry_logs:
        _assert_no_secret(message)
