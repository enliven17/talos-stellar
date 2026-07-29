"""Unit tests for idempotency utilities and TalosAPIClient write behaviour.

Coverage
--------
- Key generation: format, uniqueness, stdlib CSPRNG
- Key validation: empty, too long, multi-byte UTF-8, exact boundary
- is_uuid_v4: valid/invalid formats
- is_payload_conflict: body-string detection
- IdempotencyConflictError: constructor, properties
- TalosAPIClient._post / ._patch: header injection, opt-out, conflict raising
- Retry paths: transient 503 retried with stable key, 409 conflict NOT retried
- Cancellation / timeout paths via respx
"""

from __future__ import annotations

import re
import uuid
from unittest.mock import MagicMock, patch

import httpx
import pytest
import respx
from httpx import Response

from talos_agent.idempotency import (
    IDEMPOTENCY_KEY_MAX_BYTES,
    IdempotencyConflictError,
    generate_idempotency_key,
    is_payload_conflict,
    is_uuid_v4,
    validate_idempotency_key,
)

# ─── Key generation ───────────────────────────────────────────────────────────

UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class TestGenerateIdempotencyKey:
    def test_returns_non_empty_string(self):
        key = generate_idempotency_key()
        assert isinstance(key, str)
        assert key != ""

    def test_returns_valid_uuid_v4(self):
        key = generate_idempotency_key()
        assert UUID_V4_RE.match(key), f"Not a UUID v4: {key!r}"

    def test_unique_on_each_call(self):
        keys = {generate_idempotency_key() for _ in range(100)}
        assert len(keys) == 100

    def test_uses_stdlib_uuid4(self):
        """Confirm the implementation delegates to uuid.uuid4."""
        sentinel = "00000000-0000-4000-a000-000000000001"
        with patch("talos_agent.idempotency.uuid") as mock_uuid:
            mock_uuid.uuid4.return_value = uuid.UUID(sentinel)
            key = generate_idempotency_key()
        assert key == sentinel
        mock_uuid.uuid4.assert_called_once()


# ─── Key validation ───────────────────────────────────────────────────────────


class TestValidateIdempotencyKey:
    def test_valid_uuid_passes(self):
        key = generate_idempotency_key()
        assert validate_idempotency_key(key) == key

    def test_exact_boundary_ascii(self):
        key = "a" * IDEMPOTENCY_KEY_MAX_BYTES
        assert validate_idempotency_key(key) == key

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_idempotency_key("")

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match="non-empty"):
            validate_idempotency_key("   ")

    def test_one_byte_over_limit_raises(self):
        key = "a" * (IDEMPOTENCY_KEY_MAX_BYTES + 1)
        with pytest.raises(ValueError, match="bytes"):
            validate_idempotency_key(key)

    def test_multibyte_utf8_over_limit(self):
        # '€' is 3 bytes; 43 × 3 = 129 bytes → should raise
        key = "€" * 43
        with pytest.raises(ValueError, match="bytes"):
            validate_idempotency_key(key)

    def test_multibyte_utf8_at_boundary(self):
        # '©' is 2 bytes; 64 × 2 = 128 bytes → should pass
        key = "©" * 64
        assert validate_idempotency_key(key) == key


# ─── is_uuid_v4 ───────────────────────────────────────────────────────────────


class TestIsUuidV4:
    def test_true_for_generated_key(self):
        assert is_uuid_v4(generate_idempotency_key())

    def test_true_for_known_uuid4(self):
        assert is_uuid_v4("550e8400-e29b-41d4-a716-446655440000")

    def test_false_for_v1_uuid(self):
        assert not is_uuid_v4("550e8400-e29b-11d4-a716-446655440000")

    def test_false_for_plain_string(self):
        assert not is_uuid_v4("my-custom-key")

    def test_false_for_empty_string(self):
        assert not is_uuid_v4("")


# ─── is_payload_conflict ──────────────────────────────────────────────────────


class TestIsPayloadConflict:
    def test_detects_server_message(self):
        body = '{"error":"Idempotency-Key reused with a different payload. Use a new key."}'
        assert is_payload_conflict(body)

    def test_case_insensitive(self):
        assert is_payload_conflict("DIFFERENT PAYLOAD detected")

    def test_false_for_inflight(self):
        body = '{"error":"Request with this Idempotency-Key is already being processed"}'
        assert not is_payload_conflict(body)

    def test_false_for_generic_error(self):
        assert not is_payload_conflict("Internal server error")

    def test_false_for_empty_string(self):
        assert not is_payload_conflict("")


# ─── IdempotencyConflictError ─────────────────────────────────────────────────


class TestIdempotencyConflictError:
    def test_properties(self):
        err = IdempotencyConflictError(
            key="test-key",
            path="/api/talos/abc/jobs",
            body='{"error":"different payload"}',
        )
        assert err.key == "test-key"
        assert err.path == "/api/talos/abc/jobs"
        assert "test-key" in str(err)
        assert "/api/talos/abc/jobs" in str(err)

    def test_is_exception(self):
        err = IdempotencyConflictError(key="k", path="/p", body="b")
        assert isinstance(err, Exception)

    def test_not_subclass_of_value_error(self):
        err = IdempotencyConflictError(key="k", path="/p", body="b")
        assert not isinstance(err, ValueError)


# ─── TalosAPIClient._post / ._patch injection ─────────────────────────────────


@pytest.fixture()
def mock_settings():
    s = MagicMock()
    s.talos_api_url = "https://talos.test"
    s.talos_id = "agent-1"
    s.talos_api_key = "secret"
    return s


@pytest.fixture()
def api_client(mock_settings):
    from talos_agent.api_client import TalosAPIClient

    return TalosAPIClient(mock_settings)


class TestAPIClientKeyInjection:
    @pytest.mark.asyncio
    @respx.mock
    async def test_post_injects_idempotency_key_by_default(self, api_client):
        route = respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            return_value=Response(201, json={"id": "act-1"})
        )
        await api_client.report_activity(
            "agent-1", type_="post", content="hello", channel="X"
        )
        assert route.called
        req = route.calls.last.request
        key = req.headers.get("idempotency-key")
        assert key is not None
        assert UUID_V4_RE.match(key), f"Expected UUID v4 but got: {key!r}"

    @pytest.mark.asyncio
    @respx.mock
    async def test_post_omits_key_when_opted_out(self, api_client):
        route = respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            return_value=Response(201, json={"id": "act-1"})
        )
        await api_client.report_activity(
            "agent-1",
            type_="post",
            content="hello",
            channel="X",
            idempotency_key=None,
        )
        req = route.calls.last.request
        assert req.headers.get("idempotency-key") is None

    @pytest.mark.asyncio
    @respx.mock
    async def test_post_uses_caller_supplied_key(self, api_client):
        route = respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            return_value=Response(201, json={"id": "act-1"})
        )
        custom_key = "my-stable-key-0001"
        await api_client.report_activity(
            "agent-1",
            type_="post",
            content="hello",
            channel="X",
            idempotency_key=custom_key,
        )
        req = route.calls.last.request
        assert req.headers.get("idempotency-key") == custom_key

    @pytest.mark.asyncio
    @respx.mock
    async def test_sign_payment_does_not_inject_key(self, api_client):
        route = respx.post("https://talos.test/api/talos/agent-1/sign").mock(
            return_value=Response(200, json={"paymentHeader": "x402-token"})
        )
        await api_client.sign_payment(payee="GDEST", amount=100)
        req = route.calls.last.request
        assert req.headers.get("idempotency-key") is None

    @pytest.mark.asyncio
    @respx.mock
    async def test_update_status_does_not_inject_key(self, api_client):
        route = respx.patch("https://talos.test/api/talos/agent-1/status").mock(
            return_value=Response(200, json={"ok": True})
        )
        await api_client.update_status("agent-1", online=True)
        req = route.calls.last.request
        assert req.headers.get("idempotency-key") is None


# ─── Conflict detection ───────────────────────────────────────────────────────


class TestConflictDetection:
    @pytest.mark.asyncio
    @respx.mock
    async def test_raises_idempotency_conflict_error_on_payload_conflict(self, api_client):
        respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            return_value=Response(
                409,
                json={
                    "error": "Idempotency-Key reused with a different payload. Use a new key."
                },
            )
        )
        with pytest.raises(IdempotencyConflictError) as exc_info:
            await api_client.report_activity(
                "agent-1", type_="post", content="hello", channel="X"
            )
        assert exc_info.value.path == "/api/talos/agent-1/activity"

    @pytest.mark.asyncio
    @respx.mock
    async def test_does_not_raise_conflict_for_inflight_409(self, api_client):
        respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            return_value=Response(
                409,
                json={
                    "error": "Request with this Idempotency-Key is already being processed"
                },
            )
        )
        # Should not raise IdempotencyConflictError; returns the raw 409 response
        response = await api_client.report_activity(
            "agent-1", type_="post", content="hello", channel="X"
        )
        # report_activity returns None on non-2xx; no conflict raised
        assert response is None


# ─── Retry with stable key ────────────────────────────────────────────────────


class TestRetryWithStableKey:
    @pytest.mark.asyncio
    @respx.mock
    async def test_same_key_sent_on_all_retry_attempts(self, api_client, monkeypatch):
        """On transient failures the key must be the same across attempts."""
        from talos_agent import http as http_module
        from tenacity import (
            AsyncRetrying,
            retry_if_exception,
            stop_after_attempt,
            wait_none,
        )

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(3),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        monkeypatch.setattr(http_module, "_retry_policy", fast_policy)

        route = respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            side_effect=[
                Response(503, json={"error": "down"}),
                Response(503, json={"error": "down"}),
                Response(201, json={"id": "act-1"}),
            ]
        )

        stable_key = generate_idempotency_key()
        await api_client.report_activity(
            "agent-1",
            type_="post",
            content="hello",
            channel="X",
            idempotency_key=stable_key,
        )

        assert route.call_count == 3
        keys_sent = {
            call.request.headers.get("idempotency-key") for call in route.calls
        }
        # All three attempts must carry the identical key
        assert keys_sent == {stable_key}

    @pytest.mark.asyncio
    @respx.mock
    async def test_auto_generated_key_stable_across_retries(self, api_client, monkeypatch):
        """Auto-generated key must be generated once and reused, not per-attempt."""
        from talos_agent import http as http_module
        from tenacity import (
            AsyncRetrying,
            retry_if_exception,
            stop_after_attempt,
            wait_none,
        )

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(3),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        monkeypatch.setattr(http_module, "_retry_policy", fast_policy)

        route = respx.post("https://talos.test/api/talos/agent-1/revenue").mock(
            side_effect=[
                Response(503, json={"error": "down"}),
                Response(201, json={"id": "rev-1"}),
            ]
        )

        await api_client.report_revenue(
            "agent-1", amount=5.0, source="commerce"
        )

        assert route.call_count == 2
        keys = [call.request.headers.get("idempotency-key") for call in route.calls]
        # Both calls must carry the same key
        assert keys[0] is not None
        assert keys[0] == keys[1], (
            f"Key changed between retries: {keys[0]!r} vs {keys[1]!r}"
        )


# ─── Timeout / cancellation ───────────────────────────────────────────────────


class TestTimeoutBehaviour:
    @pytest.mark.asyncio
    @respx.mock
    async def test_timeout_propagates_as_httpx_timeout(self, api_client, monkeypatch):
        from talos_agent import http as http_module
        from tenacity import (
            AsyncRetrying,
            retry_if_exception,
            stop_after_attempt,
            wait_none,
        )

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(1),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        monkeypatch.setattr(http_module, "_retry_policy", fast_policy)

        respx.post("https://talos.test/api/talos/agent-1/activity").mock(
            side_effect=httpx.ReadTimeout("timeout")
        )

        with pytest.raises(httpx.TimeoutException):
            await api_client.report_activity(
                "agent-1", type_="post", content="hello", channel="X"
            )
