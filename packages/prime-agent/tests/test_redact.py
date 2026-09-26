"""Tests for the centralized redact module.

Acceptance criteria (per spec):
* A test fixture containing each sensitive field produces no secret substring
  in captured logs.
* Redaction is applied before serialization and before retry/error logging.
* The contributor documents the safe-to-log field policy (see LOGGING_POLICY.md).

The test fixtures cover every sensitive category mentioned in the spec:

* Stellar secret keys (``S[A-Z2-7]{55}``)
* Bearer / API tokens
* Encrypted key material (``ENC::`` envelopes)
* x402 / payment-header values (signed payment proofs)
* Generic API keys and passwords
"""

from __future__ import annotations

import json
import logging
from io import StringIO
from unittest.mock import MagicMock

import pytest

from talos_agent.redact import (
    REDACT_FIELD_NAMES,
    is_sensitive_key,
    redact_event_dict,
    redact_json_value,
    redact_text,
    redact_value,
)

# ---------------------------------------------------------------------------
# Shared sensitive fixtures — each value MUST NOT appear in any redacted output
# ---------------------------------------------------------------------------

#: A realistic Stellar secret key (S + 55 uppercase Base32 chars = 56 total)
STELLAR_SECRET = "SCZANGBA5RLGSRSGIEASPY53FKNCZMXNXNIQHPKWI27BKYPPJCAAAAAA"

#: A Bearer token as it would appear in an Authorization header value
BEARER_TOKEN = "sk-live-4f9c2a7e1b8d3c6e"

#: An x402 / payment-header JWT-like blob
X402_PAYMENT = "eyJ4NDAyVmVyc2lvbiI6MSwic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiYmFzZS1zZXBvbGlhIn0"

#: A simulated encrypted-at-rest envelope
ENC_ENVELOPE = "ENC::dGFsb3Mtc2VjcmV0LWtleS1tYXRlcmlhbC1lbmNyeXB0ZWQ="

#: A generic API key
API_KEY = "ak-9d8c7b6a5f4e3d2c1b0a"

#: A password value
PASSWORD = "SuperSecret!@#$42"

#: All values that must never appear in redacted output
ALL_SECRETS = (STELLAR_SECRET, BEARER_TOKEN, X402_PAYMENT, ENC_ENVELOPE, API_KEY, PASSWORD)


def assert_no_secret(text: str, *, context: str = "") -> None:
    """Assert that none of the sensitive fixture values appear in *text*."""
    for secret in ALL_SECRETS:
        assert secret not in text, (
            f"secret leaked in {context!r}: {text!r}"
        )


# ===========================================================================
# is_sensitive_key
# ===========================================================================


class TestIsSensitiveKey:
    """Unit tests for the key-name classifier."""

    @pytest.mark.parametrize("key", [
        "secret",
        "api_key",
        "apiKey",
        "apikey",
        "authorization",
        "token",
        "password",
        "private_key",
        "privateKey",
        "x-payment",
        "x_payment",
        "payment_header",
        "paymentHeader",
        "stellar_secret",
        "wallet_secret",
        "seed",
        "mnemonic",
        "payment_proof",
        "signing_key",
        "enc_value",
        # Mixed-case variants
        "Authorization",
        "STELLAR_SECRET",
        "Payment_Header",
    ])
    def test_sensitive_keys_detected(self, key: str) -> None:
        assert is_sensitive_key(key), f"expected {key!r} to be sensitive"

    @pytest.mark.parametrize("key", [
        "trace_id",
        "span_id",
        "job_id",
        "talos_id",
        "level",
        "timestamp",
        "event",
        "provider",
        "status_code",
        "amount",
        "asset_code",
        "payee",           # public Stellar address — NOT a secret
        "error_category",
        "retry_count",
        "transaction_hash",
        "account_id",
        "balance",
        "service_type",
    ])
    def test_safe_keys_not_classified_as_sensitive(self, key: str) -> None:
        assert not is_sensitive_key(key), f"expected {key!r} to be safe"


# ===========================================================================
# redact_value (free-text string)
# ===========================================================================


class TestRedactValue:
    def test_bearer_token_is_redacted(self) -> None:
        text = f"Authorization: Bearer {BEARER_TOKEN}"
        result = redact_value(text)
        assert BEARER_TOKEN not in result
        assert "[REDACTED]" in result

    def test_token_scheme_is_redacted(self) -> None:
        text = f"Token {BEARER_TOKEN}"
        result = redact_value(text)
        assert BEARER_TOKEN not in result

    def test_stellar_secret_key_is_redacted(self) -> None:
        result = redact_value(f"key={STELLAR_SECRET}")
        assert STELLAR_SECRET not in result
        assert "[REDACTED]" in result

    def test_stellar_public_key_is_preserved(self) -> None:
        # Public keys start with G — must NOT be redacted
        pub = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL"
        result = redact_value(f"account={pub}")
        assert pub in result

    def test_enc_envelope_is_redacted(self) -> None:
        result = redact_value(f"stored: {ENC_ENVELOPE}")
        assert ENC_ENVELOPE not in result
        assert "[REDACTED]" in result

    def test_payment_header_kv_is_redacted(self) -> None:
        text = f"x-payment={X402_PAYMENT}"
        result = redact_value(text)
        assert X402_PAYMENT not in result

    def test_api_key_kv_is_redacted(self) -> None:
        text = f"api_key={API_KEY}"
        result = redact_value(text)
        assert API_KEY not in result

    def test_password_kv_is_redacted(self) -> None:
        text = f"password={PASSWORD}"
        result = redact_value(text)
        assert PASSWORD not in result

    def test_safe_text_is_preserved(self) -> None:
        safe = "status=200 provider=groq retry=2 duration_ms=342"
        assert redact_value(safe) == safe

    def test_control_chars_are_stripped(self) -> None:
        result = redact_value("hello\r\nworld\x00")
        assert "\r" not in result
        assert "\n" not in result
        assert "\x00" not in result

    def test_long_text_is_truncated(self) -> None:
        from talos_agent.redact import LOG_TEXT_MAX_CHARS
        text = "x" * (LOG_TEXT_MAX_CHARS + 500)
        result = redact_value(text)
        assert len(result) <= LOG_TEXT_MAX_CHARS


# ===========================================================================
# redact_json_value (recursive dict / list)
# ===========================================================================


class TestRedactJsonValue:
    def test_secret_key_in_dict_is_redacted(self) -> None:
        data = {"api_key": API_KEY, "status": "ok"}
        result = redact_json_value(data)
        assert result["api_key"] == "[REDACTED]"
        assert result["status"] == "ok"

    def test_payment_header_in_nested_dict_is_redacted(self) -> None:
        data = {
            "request": {
                "headers": {"x-payment": X402_PAYMENT},
                "body": {"model": "llama-3"},
            }
        }
        result = redact_json_value(data)
        assert result["request"]["headers"]["x-payment"] == "[REDACTED]"
        assert result["request"]["body"]["model"] == "llama-3"

    def test_stellar_secret_in_string_value_is_redacted(self) -> None:
        data = {"message": f"key={STELLAR_SECRET}"}
        result = redact_json_value(data)
        assert STELLAR_SECRET not in result["message"]

    def test_list_values_are_redacted_recursively(self) -> None:
        data = [{"token": BEARER_TOKEN}, {"safe_field": "hello"}]
        result = redact_json_value(data)
        assert result[0]["token"] == "[REDACTED]"
        assert result[1]["safe_field"] == "hello"

    def test_non_sensitive_fields_are_preserved(self) -> None:
        data = {
            "trace_id": "abc123",
            "status_code": 200,
            "provider": "groq",
            "amount": 1050000,
            "payee": "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
        }
        result = redact_json_value(data)
        assert result == data  # Nothing should change

    def test_authorization_header_value_is_redacted(self) -> None:
        data = {"authorization": f"Bearer {BEARER_TOKEN}"}
        result = redact_json_value(data)
        assert result["authorization"] == "[REDACTED]"


# ===========================================================================
# redact_text (JSON-aware, covers both structured and free text)
# ===========================================================================


class TestRedactText:
    def test_json_body_with_sensitive_field_is_redacted(self) -> None:
        body = json.dumps({"error": "payment required", "api_key": API_KEY})
        result = redact_text(body)
        assert API_KEY not in result
        assert "payment required" in result

    def test_json_body_with_nested_payment_header_is_redacted(self) -> None:
        body = json.dumps({
            "error": "forbidden",
            "echo": {"headers": {"x-payment": X402_PAYMENT}},
        })
        result = redact_text(body)
        assert X402_PAYMENT not in result
        assert "forbidden" in result

    def test_plain_text_bearer_is_redacted(self) -> None:
        text = f"upstream returned Authorization: Bearer {BEARER_TOKEN}"
        result = redact_text(text)
        assert BEARER_TOKEN not in result

    def test_stellar_secret_in_plain_text_is_redacted(self) -> None:
        text = f"Stellar signing key: {STELLAR_SECRET}"
        result = redact_text(text)
        assert STELLAR_SECRET not in result

    def test_enc_envelope_in_plain_text_is_redacted(self) -> None:
        text = f"Loaded stored secret: {ENC_ENVELOPE}"
        result = redact_text(text)
        assert ENC_ENVELOPE not in result

    def test_safe_content_is_preserved(self) -> None:
        safe = "HTTP 503 from https://api.example.com, retry 2/3"
        assert redact_text(safe) == safe

    def test_secret_straddling_truncation_is_not_partially_leaked(self) -> None:
        """Redaction must run BEFORE truncation — not after."""
        from talos_agent.redact import LOG_TEXT_MAX_CHARS
        # Pad to near the limit, then append the secret
        text = "x" * (LOG_TEXT_MAX_CHARS - 30) + f" Bearer {BEARER_TOKEN}" + "y" * 100
        result = redact_text(text)
        assert BEARER_TOKEN not in result
        assert len(result) <= LOG_TEXT_MAX_CHARS


# ===========================================================================
# redact_event_dict (structlog processor)
# ===========================================================================


class TestRedactEventDict:
    """Verify the structlog processor redacts before serialization."""

    def _call(self, event_dict: dict) -> dict:
        return redact_event_dict(MagicMock(), "info", event_dict)

    def test_sensitive_field_key_is_redacted(self) -> None:
        result = self._call({"api_key": API_KEY, "event": "called"})
        assert result["api_key"] == "[REDACTED]"

    def test_payment_header_field_is_redacted(self) -> None:
        result = self._call({"payment_header": X402_PAYMENT, "event": "x402"})
        assert result["payment_header"] == "[REDACTED]"

    def test_stellar_secret_in_string_field_is_redacted(self) -> None:
        result = self._call({"message": f"key={STELLAR_SECRET}", "event": "wallet"})
        assert STELLAR_SECRET not in result["message"]

    def test_bearer_in_event_message_is_redacted(self) -> None:
        result = self._call({"event": f"upstream 401 Authorization: Bearer {BEARER_TOKEN}"})
        assert BEARER_TOKEN not in result["event"]

    def test_nested_dict_field_is_redacted(self) -> None:
        payload = {"headers": {"x-payment": X402_PAYMENT}, "body": {"model": "llama-3"}}
        result = self._call({"payload": payload, "event": "http"})
        assert result["payload"]["headers"]["x-payment"] == "[REDACTED]"
        assert result["payload"]["body"]["model"] == "llama-3"

    def test_safe_fields_are_preserved(self) -> None:
        trace = "0011223344556677889900aabbccddeeff001122334455667788990011223344"
        span = "0011223344556677"
        result = self._call({
            "trace_id": trace,
            "span_id": span,
            "job_id": "job-abc-123",
            "talos_id": "vega",
            "level": "info",
            "event": "heartbeat",
            "status_code": 200,
            "provider": "groq",
            "amount": 1050000,
            "retry_count": 2,
        })
        assert result["trace_id"] == trace
        assert result["span_id"] == span
        assert result["job_id"] == "job-abc-123"
        assert result["talos_id"] == "vega"
        assert result["status_code"] == 200
        assert result["provider"] == "groq"
        assert result["amount"] == 1050000

    def test_numeric_and_bool_fields_are_unchanged(self) -> None:
        result = self._call({"retries": 3, "success": True, "latency_ms": 42.5, "event": "ok"})
        assert result["retries"] == 3
        assert result["success"] is True
        assert result["latency_ms"] == 42.5

    def test_all_sensitive_fixture_values_absent_from_result(self) -> None:
        """Comprehensive fixture test: every sensitive type in one event dict."""
        event = {
            "event": f"error processing Bearer {BEARER_TOKEN}",
            "stellar_secret": STELLAR_SECRET,
            "payment_header": X402_PAYMENT,
            "api_key": API_KEY,
            "password": PASSWORD,
            "enc_value": ENC_ENVELOPE,
            "trace_id": "deadbeef",
            "provider": "groq",
        }
        result = self._call(event)
        serialized = json.dumps(result)
        assert_no_secret(serialized, context="event_dict serialized")
        # Safe fields still there
        assert result["trace_id"] == "deadbeef"
        assert result["provider"] == "groq"


# ===========================================================================
# Structlog pipeline integration
# ===========================================================================


class TestStructlogPipelineIntegration:
    """Verify redact_event_dict fires before JSONRenderer in the real pipeline."""

    def test_structlog_configure_wires_redact_processor(self) -> None:
        """configure_logging must include redact_event_dict before JSONRenderer."""
        import structlog
        from talos_agent.observability import configure_logging
        from talos_agent.redact import redact_event_dict

        configure_logging()
        # Access the bound configuration
        config = structlog.get_config()
        processors = config["processors"]
        names = [getattr(p, "__name__", repr(p)) for p in processors]
        # Find positions
        try:
            redact_idx = next(
                i for i, p in enumerate(processors) if p is redact_event_dict
            )
        except StopIteration:
            pytest.fail("redact_event_dict not found in structlog processors")

        try:
            json_idx = next(
                i for i, p in enumerate(processors)
                if "JSONRenderer" in type(p).__name__ or "JSONRenderer" in repr(p)
            )
        except StopIteration:
            pytest.fail("JSONRenderer not found in structlog processors")

        assert redact_idx < json_idx, (
            f"redact_event_dict (index {redact_idx}) must run before "
            f"JSONRenderer (index {json_idx})"
        )

    def test_captured_log_contains_no_secrets(self, capfd) -> None:
        """End-to-end: emit a log with secrets and verify captured JSON is clean."""
        import structlog
        from talos_agent.observability import configure_logging

        configure_logging()
        # Override factory to write to a StringIO so we can capture it
        buf = StringIO()
        structlog.configure(
            logger_factory=structlog.PrintLoggerFactory(buf),
        )
        log = structlog.get_logger()
        log.warning(
            "payment attempt",
            api_key=API_KEY,
            payment_header=X402_PAYMENT,
            stellar_key=STELLAR_SECRET,
            bearer=f"Bearer {BEARER_TOKEN}",
            trace_id="test-trace-id",
            provider="groq",
        )

        output = buf.getvalue()
        assert_no_secret(output, context="structlog output")
        # Safe fields preserved
        assert "test-trace-id" in output
        assert "groq" in output


# ===========================================================================
# Discord adapter error messages
# ===========================================================================


class TestDiscordAdapterRedaction:
    """Verify Discord error paths sanitize resp.text before creating PublishResult."""

    @pytest.mark.asyncio
    async def test_webhook_error_body_does_not_leak_secrets(self) -> None:
        from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig

        class _FakeHTTP:
            async def post(self, url, **kwargs):
                from httpx import Response
                # Simulate a response body that contains a secret token
                body = json.dumps({"error": "unauthorized", "token": BEARER_TOKEN})
                return Response(401, text=body)

        config = DiscordAdapterConfig(
            legacy_webhook_url="https://discord.com/api/webhooks/123/test",
            # Provide a dummy token so _bot_token doesn't hit the assert
            legacy_bot_token="dummy-token",
        )
        adapter = DiscordAdapter(config, http=_FakeHTTP())
        result = await adapter.post("test message")
        assert result.status == "failed"
        assert_no_secret(result.error or "", context="discord webhook error")

    @pytest.mark.asyncio
    async def test_api_post_error_body_does_not_leak_secrets(self) -> None:
        from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig

        class _FakeHTTP:
            async def post(self, url, **kwargs):
                from httpx import Response
                body = json.dumps({"error": "bad request", "api_key": API_KEY})
                return Response(400, text=body)

        config = DiscordAdapterConfig(
            legacy_bot_token="Bot-token-here",
            channel_id="999888777",
        )
        adapter = DiscordAdapter(config, http=_FakeHTTP())
        result = await adapter.post("test message")
        assert result.status == "failed"
        assert_no_secret(result.error or "", context="discord api post error")


# ===========================================================================
# x402 Signer error paths
# ===========================================================================


class TestX402SignerRedaction:
    """Verify sign_payment error paths do not expose secret material."""

    @pytest.mark.asyncio
    async def test_signing_failure_exception_is_redacted(self) -> None:
        from unittest.mock import AsyncMock
        from talos_agent.payments.x402_signer import X402Signer

        mock_api = AsyncMock()
        mock_api.get_agent_wallet.return_value = {
            "walletId": "wallet-1",
            "publicKey": "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
        }
        mock_api.sign_payment.side_effect = RuntimeError(
            f"signing failed with secret key {STELLAR_SECRET}"
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
            amount=1050000,
        )

        assert "error" in result
        assert_no_secret(result["error"], context="x402_signer error")

    @pytest.mark.asyncio
    async def test_signing_error_response_detail_is_redacted(self) -> None:
        from unittest.mock import AsyncMock
        from talos_agent.payments.x402_signer import X402Signer

        mock_api = AsyncMock()
        mock_api.get_agent_wallet.return_value = {
            "walletId": "wallet-1",
            "publicKey": "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
        }
        mock_api.sign_payment.return_value = {
            "error": "forbidden",
            "details": f"api_key={API_KEY} rejected",
        }

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
            amount=1050000,
        )

        assert "error" in result
        assert_no_secret(result["error"], context="x402_signer error detail")


# ===========================================================================
# Stellar kit error paths
# ===========================================================================


class TestStellarKitRedaction:
    """Verify StellarKit exception messages are sanitized."""

    @pytest.mark.asyncio
    async def test_balance_exception_is_redacted(self) -> None:
        from unittest.mock import AsyncMock
        from talos_agent.payments.stellar_kit import StellarKit

        mock_api = AsyncMock()
        mock_api.get_talos.side_effect = RuntimeError(
            f"auth failed with key={STELLAR_SECRET}"
        )

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_balance("GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL")

        assert "error" in result
        assert_no_secret(result["error"], context="stellar_kit balance error")

    @pytest.mark.asyncio
    async def test_transfer_exception_is_redacted(self) -> None:
        from unittest.mock import AsyncMock
        from talos_agent.payments.stellar_kit import StellarKit

        mock_api = AsyncMock()
        mock_api.request_transfer.side_effect = RuntimeError(
            f"transfer rejected, secret={STELLAR_SECRET}"
        )

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.transfer_xlm(
            "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL", 10.0
        )

        assert "error" in result
        assert_no_secret(result["error"], context="stellar_kit transfer error")


# ===========================================================================
# HTTP retry log path
# ===========================================================================


class TestHTTPRetryLogRedaction:
    """Verify _log_before_sleep doesn't emit secrets in retry log messages."""

    @pytest.mark.asyncio
    async def test_retry_log_redacts_bearer_in_response_body(self, caplog) -> None:
        import httpx
        import respx
        from talos_agent import http as http_module
        from talos_agent.http import request_with_retry, RetryableHTTPError
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_none

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(http_module.MAX_ATTEMPTS),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        original = http_module._retry_policy
        http_module._retry_policy = fast_policy

        body = json.dumps({"error": "forbidden", "authorization": f"Bearer {BEARER_TOKEN}"})
        with respx.mock:
            respx.get("https://api.example.com/test").mock(
                return_value=httpx.Response(503, text=body)
            )
            async with httpx.AsyncClient() as client:
                with (
                    caplog.at_level(logging.WARNING, logger="talos_agent.http"),
                    pytest.raises(RetryableHTTPError),
                ):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/test")
                    )

        http_module._retry_policy = original

        for record in caplog.records:
            msg = record.getMessage()
            if "HTTP retry" in msg:
                assert_no_secret(msg, context="http retry log")

    @pytest.mark.asyncio
    async def test_retry_log_redacts_stellar_secret_in_response_body(self, caplog) -> None:
        import httpx
        import respx
        from talos_agent import http as http_module
        from talos_agent.http import request_with_retry, RetryableHTTPError
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_none

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(http_module.MAX_ATTEMPTS),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        original = http_module._retry_policy
        http_module._retry_policy = fast_policy

        body = json.dumps({"echo": {"secret_key": STELLAR_SECRET}})
        with respx.mock:
            respx.get("https://api.example.com/test2").mock(
                return_value=httpx.Response(503, text=body)
            )
            async with httpx.AsyncClient() as client:
                with (
                    caplog.at_level(logging.WARNING, logger="talos_agent.http"),
                    pytest.raises(RetryableHTTPError),
                ):
                    await request_with_retry(
                        lambda: client.get("https://api.example.com/test2")
                    )

        http_module._retry_policy = original

        for record in caplog.records:
            msg = record.getMessage()
            if "HTTP retry" in msg:
                assert_no_secret(msg, context="http retry log stellar secret")


# ===========================================================================
# REDACT_FIELD_NAMES completeness
# ===========================================================================


class TestRedactFieldNamesCompleteness:
    """Verify the canonical field-name set covers all required categories."""

    @pytest.mark.parametrize("field", [
        "api_key", "apiKey", "apikey",
        "authorization", "auth", "token", "secret",
        "password", "private_key", "privateKey",
        "x-payment", "x_payment", "payment_header", "paymentHeader",
        "stellar_secret", "wallet_secret",
        "seed", "mnemonic",
        "signing_key", "enc_value",
    ])
    def test_required_fields_in_redact_field_names(self, field: str) -> None:
        # Either exact membership or is_sensitive_key should catch it
        assert is_sensitive_key(field), f"{field!r} must be recognized as sensitive"
