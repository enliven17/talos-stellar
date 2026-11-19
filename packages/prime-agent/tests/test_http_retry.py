"""Retry helper tests — exponential backoff on transient HTTP failures."""

from __future__ import annotations

import logging

import httpx
import pytest
import respx
from httpx import Response
from tenacity import (
    AsyncRetrying,
    retry_if_exception,
    stop_after_attempt,
    wait_none,
)

from talos_agent import http as http_module
from talos_agent.http import (
    MAX_ATTEMPTS,
    RetryableHTTPError,
    call_with_retry,
    request_with_retry,
)


@pytest.fixture(autouse=True)
def _no_sleep_between_retries(monkeypatch):
    """Drop tenacity's backoff sleeps so tests run instantly."""

    def fast_policy() -> AsyncRetrying:
        return AsyncRetrying(
            stop=stop_after_attempt(MAX_ATTEMPTS),
            wait=wait_none(),
            retry=retry_if_exception(http_module._is_retryable),
            before_sleep=http_module._log_before_sleep,
            reraise=True,
        )

    monkeypatch.setattr(http_module, "_retry_policy", fast_policy)


class TestRequestWithRetry:
    @pytest.mark.asyncio
    @respx.mock
    async def test_recovers_after_two_429s(self, caplog):
        """[429, 429, 200] succeeds within MAX_ATTEMPTS."""
        route = respx.get("https://api.example.com/widget").mock(
            side_effect=[
                Response(429, json={"error": "rate limited"}),
                Response(429, json={"error": "rate limited"}),
                Response(200, json={"ok": True}),
            ]
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                response = await request_with_retry(
                    lambda: client.get("https://api.example.com/widget")
                )

        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert route.call_count == 3
        retry_logs = [r for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert len(retry_logs) == 2
        assert all("status=429" in r.getMessage() for r in retry_logs)

    @pytest.mark.asyncio
    @respx.mock
    async def test_persistent_503_raises_after_exhaustion(self):
        """Persistent retryable status raises after MAX_ATTEMPTS."""
        route = respx.get("https://api.example.com/broken").mock(
            return_value=Response(
                503,
                json={"error": "down", "token": "super-secret-token"},
            )
        )

        async with httpx.AsyncClient() as client:
            with pytest.raises(RetryableHTTPError) as exc_info:
                await request_with_retry(
                    lambda: client.get("https://api.example.com/broken")
                )

        assert exc_info.value.status_code == 503
        assert route.call_count == MAX_ATTEMPTS

    @pytest.mark.asyncio
    @respx.mock
    async def test_logs_redacted_and_truncated_body(self, caplog):
        """Retry logs include truncated, redacted response summaries."""
        long_body = {"password": "hunter2", "message": "x" * 2000}
        respx.get("https://api.example.com/broken").mock(
            return_value=Response(503, json=long_body)
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                with pytest.raises(RetryableHTTPError):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/broken")
                    )

        retry_logs = [r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert retry_logs
        assert any("[REDACTED]" in msg for msg in retry_logs)
        assert all("hunter2" not in msg for msg in retry_logs)
        assert all("password" in msg for msg in retry_logs)
        assert all(len(msg) <= 1200 for msg in retry_logs)

    @pytest.mark.asyncio
    @respx.mock
    async def test_logs_unicode_response_body(self, caplog):
        """Retry logs preserve Unicode and redact secrets in response body."""
        respx.get("https://api.example.com/broken").mock(
            return_value=Response(
                503,
                text='{"message": "こんにちは 👋", "apiKey": "tok_ABC123"}',
                headers={"Content-Type": "application/json"},
            )
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                with pytest.raises(RetryableHTTPError):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/broken")
                    )

        retry_logs = [r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert retry_logs
        assert any("こんにちは 👋" in msg for msg in retry_logs)
        assert all("tok_ABC123" not in msg for msg in retry_logs)
        assert any("[REDACTED]" in msg for msg in retry_logs)

    @pytest.mark.asyncio
    @respx.mock
    async def test_response_body_preserves_status_and_endpoint_class(self, caplog):
        """Retry logs keep status and endpoint classification while redacting body."""
        route = respx.get("https://api.example.com/broken").mock(
            return_value=Response(503, json={"error": "down", "token": "abc123"})
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                with pytest.raises(RetryableHTTPError):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/broken")
                    )

        retry_logs = [r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert retry_logs
        assert any("status=503" in msg for msg in retry_logs)
        assert any("HTTP retry" in msg for msg in retry_logs)
        assert all("abc123" not in msg for msg in retry_logs)
        """Non-retryable statuses (404, 500) pass through without retrying."""
        route = respx.get("https://api.example.com/missing").mock(
            return_value=Response(404, json={"error": "not found"})
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/missing")
            )

        assert response.status_code == 404
        assert route.call_count == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_logs_strip_control_characters_non_json_body(self, caplog):
        """Non-JSON bodies with CR/LF and control chars can't inject fake log lines."""
        malicious_body = (
            "plain text error\r\n"
            "2024-01-01 12:00:00 WARNING fake log line injected by attacker\r\n"
            "\x1b[31mFAKE ANSI ESCAPE\x1b[0m"
        )
        respx.get("https://api.example.com/broken").mock(
            return_value=Response(
                503,
                text=malicious_body,
                headers={"Content-Type": "text/plain"},
            )
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                with pytest.raises(RetryableHTTPError):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/broken")
                    )

        retry_logs = [r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert retry_logs
        # No raw CR/LF should survive into any log record.
        assert all("\r" not in msg for msg in retry_logs)
        assert all("\n" not in msg for msg in retry_logs)
        # Each retry produces exactly one log record — no injected extra lines.
        for msg in retry_logs:
            assert msg.count("HTTP retry") == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_logs_strip_control_characters_json_body(self, caplog):
        """Control characters embedded inside JSON string values are also neutralized."""
        respx.get("https://api.example.com/broken").mock(
            return_value=Response(
                503,
                json={"error": "bad\r\nrequest\x00here", "token": "abc123"},
            )
        )

        async with httpx.AsyncClient() as client:
            with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
                with pytest.raises(RetryableHTTPError):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/broken")
                    )

        retry_logs = [r.getMessage() for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert retry_logs
        assert all("\r" not in msg for msg in retry_logs)
        assert all("\n" not in msg for msg in retry_logs)
        assert all("abc123" not in msg for msg in retry_logs)

    @pytest.mark.asyncio
    @respx.mock
    async def test_500_not_retried(self):
        """500 is not in the retryable set — returned to caller as-is."""
        route = respx.get("https://api.example.com/oops").mock(
            return_value=Response(500, json={"error": "boom"})
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/oops")
            )

        assert response.status_code == 500
        assert route.call_count == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_timeout_retries_then_succeeds(self):
        """httpx.TimeoutException is retryable."""
        route = respx.get("https://api.example.com/slow").mock(
            side_effect=[
                httpx.ReadTimeout("timeout"),
                Response(200, json={"ok": True}),
            ]
        )

        async with httpx.AsyncClient() as client:
            response = await request_with_retry(
                lambda: client.get("https://api.example.com/slow")
            )

        assert response.status_code == 200
        assert route.call_count == 2

    @pytest.mark.asyncio
    @respx.mock
    async def test_persistent_timeout_raises(self):
        """Persistent timeouts propagate after exhausting retries."""
        route = respx.get("https://api.example.com/hang").mock(
            side_effect=httpx.ConnectTimeout("timeout"),
        )

        async with httpx.AsyncClient() as client:
            with pytest.raises(httpx.TimeoutException):
                await request_with_retry(
                    lambda: client.get("https://api.example.com/hang")
                )

        assert route.call_count == MAX_ATTEMPTS


class TestCallWithRetry:
    @pytest.mark.asyncio
    async def test_succeeds_on_first_attempt(self):
        calls = 0

        async def op():
            nonlocal calls
            calls += 1
            return "ok"

        result = await call_with_retry(op)
        assert result == "ok"
        assert calls == 1

    @pytest.mark.asyncio
    async def test_retries_on_openai_rate_limit(self, caplog):
        """openai.RateLimitError (429) is retryable via call_with_retry."""
        import openai

        attempts = 0

        async def op():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                # Construct a synthetic RateLimitError matching openai's signature.
                raise openai.RateLimitError(
                    "rate limited",
                    response=httpx.Response(
                        429,
                        request=httpx.Request("POST", "https://api.groq.com/v1/chat"),
                    ),
                    body=None,
                )
            return "done"

        with caplog.at_level(logging.WARNING, logger="talos_agent.http"):
            result = await call_with_retry(op)

        assert result == "done"
        assert attempts == 3
        retry_logs = [r for r in caplog.records if "HTTP retry" in r.getMessage()]
        assert len(retry_logs) == 2

    @pytest.mark.asyncio
    async def test_non_retryable_openai_error_propagates_immediately(self):
        """openai 400-class errors should not retry."""
        import openai

        attempts = 0

        async def op():
            nonlocal attempts
            attempts += 1
            raise openai.BadRequestError(
                "bad",
                response=httpx.Response(
                    400,
                    request=httpx.Request("POST", "https://api.groq.com/v1/chat"),
                ),
                body=None,
            )

        with pytest.raises(openai.BadRequestError):
            await call_with_retry(op)
        assert attempts == 1
