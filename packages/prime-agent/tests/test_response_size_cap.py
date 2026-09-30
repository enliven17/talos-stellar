"""Tests for API client response size cap (Issue #561).

Coverage matrix
---------------
Positive   — response within limit passes through unchanged
Negative   — response over limit raises ResponseTooLargeError
Boundary   — response at exact limit is accepted
            — response at (limit + 1) is rejected
Header     — declared Content-Length too large → rejected before body read
            — declared Content-Length within limit but body too large → rejected
            — malformed Content-Length header is ignored (falls back to body)
            — missing Content-Length header falls back to body measurement
Privacy    — error message never leaks body content
            — error carries url_path, actual_bytes, limit_bytes only
            — secrets / seeds / payment proofs absent from error repr
Config     — default limit is 1 MiB
            — limit is read from settings.api_client_response_max_bytes
            — limit can be reduced via settings for stricter environments
Regression — existing callers (get_talos, report_activity, …) unaffected
            — _request(), _get(), _post(), _put(), _patch() all enforce cap
            — ResponseTooLargeError is importable from talos_agent.http
"""

from __future__ import annotations

from pathlib import Path
from typing import ClassVar

import httpx
import pytest
import respx
from httpx import Response

from talos_agent.api_client import TalosAPIClient, _check_response_size
from talos_agent.config import Settings
from talos_agent.http import ResponseTooLargeError

# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_settings(*, max_bytes: int = 1_048_576, tmp_path: Path | None = None) -> Settings:
    """Build test Settings with a configurable response cap."""
    return Settings(
        talos_api_url="http://test.local",
        talos_api_key="cpk_test_key",
        talos_id="test-talos-id",
        openai_api_key="sk-test",
        agent_cycle_interval=1,
        api_client_response_max_bytes=max_bytes,
    )


def _small_body(limit: int) -> bytes:
    """Return a body that is strictly inside the limit."""
    size = max(1, limit - 1)
    return b"x" * size


def _exact_body(limit: int) -> bytes:
    """Return a body that is exactly at the limit."""
    return b"x" * limit


def _large_body(limit: int) -> bytes:
    """Return a body that exceeds the limit by one byte."""
    return b"x" * (limit + 1)


def _make_response(
    body: bytes,
    *,
    status: int = 200,
    content_length: int | str | None = "auto",
    url: str = "http://test.local/api/talos/t1",
) -> httpx.Response:
    """Build a synthetic httpx.Response with optional Content-Length header."""
    headers: dict[str, str] = {}
    if content_length == "auto":
        headers["content-length"] = str(len(body))
    elif content_length is not None:
        headers["content-length"] = str(content_length)

    request = httpx.Request("GET", url)
    return httpx.Response(status, content=body, headers=headers, request=request)


# ── Unit tests: _check_response_size helper ──────────────────────────────────


class TestCheckResponseSizeUnit:
    """Direct tests for the module-level helper — no HTTP layer involved."""

    def test_positive_under_limit_passes(self) -> None:
        """Body smaller than the limit must not raise."""
        limit = 1024
        resp = _make_response(_small_body(limit))
        _check_response_size(resp, limit)  # no exception

    def test_boundary_exact_limit_passes(self) -> None:
        """Body at exactly the limit is accepted (≤ check, not <)."""
        limit = 512
        resp = _make_response(_exact_body(limit))
        _check_response_size(resp, limit)  # no exception

    def test_negative_one_byte_over_raises(self) -> None:
        """Body at limit + 1 must raise ResponseTooLargeError."""
        limit = 512
        resp = _make_response(_large_body(limit))
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, limit)
        err = exc_info.value
        assert err.actual_bytes == limit + 1
        assert err.limit_bytes == limit

    def test_content_length_header_too_large_raises(self) -> None:
        """Declared Content-Length over limit is rejected before reading body."""
        limit = 128
        # body is small but header claims it's too large
        resp = _make_response(
            b'{"ok": true}',
            content_length=limit + 1,
        )
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, limit)
        err = exc_info.value
        assert err.actual_bytes == limit + 1
        assert err.limit_bytes == limit

    def test_content_length_within_limit_but_body_too_large(self) -> None:
        """Server lied about Content-Length — actual body is too large."""
        limit = 50
        # Build response where headers and content are decoupled
        body = b"y" * (limit + 10)
        headers = {"content-length": str(limit - 1)}  # lies: claims body is small
        request = httpx.Request("GET", "http://test.local/api/test")
        resp = httpx.Response(200, content=body, headers=headers, request=request)

        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, limit)
        assert exc_info.value.actual_bytes == len(body)

    def test_missing_content_length_falls_back_to_body(self) -> None:
        """No Content-Length header — body byte count is used."""
        limit = 64
        resp = _make_response(_large_body(limit), content_length=None)
        with pytest.raises(ResponseTooLargeError):
            _check_response_size(resp, limit)

    def test_malformed_content_length_ignored(self) -> None:
        """Non-integer Content-Length is silently ignored; body check still fires."""
        limit = 32
        large = _large_body(limit)
        resp = _make_response(large, content_length="not-a-number")
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, limit)
        # The actual body size is measured
        assert exc_info.value.actual_bytes == len(large)

    def test_malformed_content_length_small_body_passes(self) -> None:
        """Non-integer Content-Length + small body → no error."""
        limit = 128
        resp = _make_response(_small_body(limit), content_length="bogus")
        _check_response_size(resp, limit)  # no exception


# ── Privacy tests for ResponseTooLargeError ───────────────────────────────────


class TestResponseTooLargeErrorPrivacy:
    """The error must never contain response body content or sensitive data."""

    SECRETS: ClassVar[list[str]] = [
        "SECRET_API_KEY_12345",
        "SXXXXX_private_seed_phrase",
        "payment_proof_abc123",
        "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    ]

    def test_error_fields_are_path_and_sizes_only(self) -> None:
        """Error only exposes url_path, actual_bytes, limit_bytes."""
        resp = _make_response(b"x" * 200, url="http://test.local/api/talos/abc/revenue")
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, 100)
        err = exc_info.value
        assert hasattr(err, "url_path")
        assert hasattr(err, "actual_bytes")
        assert hasattr(err, "limit_bytes")
        assert err.actual_bytes == 200
        assert err.limit_bytes == 100

    def test_url_path_strips_scheme_and_host(self) -> None:
        """url_path must not include scheme/host/credentials."""
        body = b"z" * 200
        resp = _make_response(body, url="https://user:pass@host.example.com/api/jobs/42")
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, 100)
        err = exc_info.value
        # Only the path should appear
        assert "user" not in err.url_path
        assert "pass" not in err.url_path
        assert "host.example.com" not in err.url_path
        assert "/api/jobs/42" in err.url_path

    @pytest.mark.parametrize("secret", SECRETS)
    def test_body_content_not_in_error_message(self, secret: str) -> None:
        """Sensitive body text must not leak into the error string."""
        body = f'{{"token": "{secret}"}}'.encode()
        resp = _make_response(body, content_length=len(body) + 1)
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, 10)
        error_text = str(exc_info.value)
        assert secret not in error_text

    def test_error_repr_contains_no_body(self) -> None:
        """repr() of the error must not include any body content."""
        secret_body = b"secret_wallet_key=SXXX123"
        resp = _make_response(secret_body, content_length=len(secret_body) + 1)
        with pytest.raises(ResponseTooLargeError) as exc_info:
            _check_response_size(resp, 10)
        assert b"secret_wallet_key" not in repr(exc_info.value).encode()

    def test_constructor_directly_privacy_safe(self) -> None:
        """Directly constructing the error never leaks sensitive content."""
        err = ResponseTooLargeError(
            url="https://api.internal/api/talos/vega/sign",
            actual_bytes=2_000_000,
            limit_bytes=1_048_576,
        )
        text = str(err)
        assert "2000000" in text
        assert "1048576" in text
        assert "/api/talos/vega/sign" in err.url_path
        # No scheme or host in url_path
        assert "https" not in err.url_path
        assert "api.internal" not in err.url_path


# ── Config / Settings tests ───────────────────────────────────────────────────


class TestResponseSizeCapConfig:
    def test_default_limit_is_1_mib(self) -> None:
        """Default api_client_response_max_bytes must be 1 MiB."""
        s = Settings(talos_api_url="http://test.local", talos_api_key="k", talos_id="x")
        assert s.api_client_response_max_bytes == 1_048_576

    def test_custom_limit_is_respected(self) -> None:
        """Setting api_client_response_max_bytes is forwarded to the client."""
        s = _make_settings(max_bytes=4096)
        client = TalosAPIClient(s)
        assert client._response_max_bytes == 4096

    def test_minimum_limit_is_enforced(self) -> None:
        """Limit below 1 KiB must be rejected at settings creation time."""
        with pytest.raises(ValueError):  # pydantic ValidationError inherits ValueError
            Settings(
                talos_api_url="http://x",
                talos_api_key="k",
                talos_id="t",
                api_client_response_max_bytes=512,  # below 1 KiB minimum
            )

    def test_maximum_limit_is_enforced(self) -> None:
        """Limit above 100 MiB must be rejected at settings creation time."""
        with pytest.raises(ValueError):  # pydantic ValidationError inherits ValueError
            Settings(
                talos_api_url="http://x",
                talos_api_key="k",
                talos_id="t",
                api_client_response_max_bytes=200_000_000,  # above 100 MiB
            )


# ── Integration tests: full HTTP method paths ─────────────────────────────────


class TestAPIClientResponseSizeCap:
    """End-to-end tests through TalosAPIClient methods using respx mocks."""

    # ── _get ────────────────────────────────────────────────

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_within_limit_passes(self) -> None:
        """_get with a small response returns the response normally."""
        limit = 2048
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        body = b'{"id": "t1"}'
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(200, content=body)
        )
        result = await client.get_talos("t1")
        assert result is not None
        assert result["id"] == "t1"
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_over_limit_raises(self) -> None:
        """_get with an oversized response raises ResponseTooLargeError."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        large_body = b"x" * (limit + 1)
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(200, content=large_body)
        )
        with pytest.raises(ResponseTooLargeError) as exc_info:
            await client.get_talos("t1")
        assert exc_info.value.limit_bytes == limit
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_at_exact_boundary_passes(self) -> None:
        """Response body at exactly the limit is accepted."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        exact_body = b"x" * limit
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(200, content=exact_body)
        )
        # Will not raise — response is accepted (even if JSON parse fails later)
        try:
            await client._get("/api/talos/t1")
        except ResponseTooLargeError:
            pytest.fail("ResponseTooLargeError raised at exact boundary")
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_one_byte_over_boundary_raises(self) -> None:
        """Response body at limit + 1 must raise ResponseTooLargeError."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(200, content=b"x" * (limit + 1))
        )
        with pytest.raises(ResponseTooLargeError) as exc_info:
            await client._get("/api/talos/t1")
        assert exc_info.value.actual_bytes == limit + 1
        await client.close()

    # ── _post ───────────────────────────────────────────────

    @pytest.mark.asyncio
    @respx.mock
    async def test_post_over_limit_raises(self) -> None:
        """_post with an oversized response raises ResponseTooLargeError."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        large = b"z" * (limit + 1)
        respx.post("http://test.local/api/talos/test-talos-id/activity").mock(
            return_value=Response(201, content=large)
        )
        with pytest.raises(ResponseTooLargeError):
            await client.report_activity(
                "test-talos-id", type_="post", content="hi", channel="X"
            )
        await client.close()

    # ── _put ────────────────────────────────────────────────

    @pytest.mark.asyncio
    @respx.mock
    async def test_put_over_limit_raises(self) -> None:
        """_put with an oversized response raises ResponseTooLargeError."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        large = b"w" * (limit + 1)
        respx.put("http://test.local/api/talos/test-talos-id/service").mock(
            return_value=Response(200, content=large)
        )
        with pytest.raises(ResponseTooLargeError):
            await client.register_service(
                "test-talos-id",
                service_name="svc",
                description="desc",
                price=1.0,
            )
        await client.close()

    # ── _patch ──────────────────────────────────────────────

    @pytest.mark.asyncio
    @respx.mock
    async def test_patch_over_limit_raises(self) -> None:
        """_patch with an oversized response raises ResponseTooLargeError."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        large = b"p" * (limit + 1)
        respx.patch("http://test.local/api/talos/test-talos-id/status").mock(
            return_value=Response(200, content=large)
        )
        with pytest.raises(ResponseTooLargeError):
            await client.update_status("test-talos-id", online=True)
        await client.close()

    # ── Content-Length fast-reject ────────────────────────────

    @pytest.mark.asyncio
    @respx.mock
    async def test_content_length_header_triggers_fast_reject(self) -> None:
        """A Content-Length header over the limit is rejected before body read."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(
                200,
                content=b'{"id": "t1"}',
                headers={"content-length": str(limit + 1)},
            )
        )
        with pytest.raises(ResponseTooLargeError) as exc_info:
            await client.get_talos("t1")
        assert exc_info.value.actual_bytes == limit + 1
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_malformed_content_length_still_checks_body(self) -> None:
        """A non-integer Content-Length is ignored; body check still applied."""
        limit = 1024
        client = TalosAPIClient(_make_settings(max_bytes=limit))
        large = b"b" * (limit + 5)
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(
                200,
                content=large,
                headers={"content-length": "not-a-number"},
            )
        )
        with pytest.raises(ResponseTooLargeError) as exc_info:
            await client.get_talos("t1")
        assert exc_info.value.actual_bytes == len(large)
        await client.close()


# ── Regression: existing callers unaffected with default limit ────────────────


class TestExistingCallersUnaffected:
    """Typical responses are well under 1 MiB — verify no regressions."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_talos_still_works(self) -> None:
        """get_talos returns data normally under the default cap."""
        client = TalosAPIClient(_make_settings())
        respx.get("http://test.local/api/talos/t1").mock(
            return_value=Response(200, json={"id": "t1", "name": "Vega"})
        )
        result = await client.get_talos("t1")
        assert result == {"id": "t1", "name": "Vega"}
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_report_activity_still_works(self) -> None:
        """report_activity returns the record normally under the default cap."""
        client = TalosAPIClient(_make_settings())
        respx.post("http://test.local/api/talos/test-talos-id/activity").mock(
            return_value=Response(201, json={"id": "act-1", "type": "post"})
        )
        result = await client.report_activity(
            "test-talos-id", type_="post", content="hello", channel="X"
        )
        assert result is not None
        assert result["id"] == "act-1"
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_pending_jobs_still_works(self) -> None:
        """get_pending_jobs returns job list normally under the default cap."""
        client = TalosAPIClient(_make_settings())
        respx.get("http://test.local/api/jobs/pending").mock(
            return_value=Response(200, json=[{"id": "job-1"}, {"id": "job-2"}])
        )
        jobs = await client.get_pending_jobs()
        assert len(jobs) == 2
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_update_status_fire_and_forget(self) -> None:
        """update_status does not raise on a normal 200 response."""
        client = TalosAPIClient(_make_settings())
        respx.patch("http://test.local/api/talos/test-talos-id/status").mock(
            return_value=Response(200, json={"ok": True})
        )
        await client.update_status("test-talos-id", online=True)  # no exception
        await client.close()


# ── Import / public API surface ───────────────────────────────────────────────


class TestPublicInterface:
    def test_response_too_large_error_importable_from_http(self) -> None:
        """ResponseTooLargeError must be importable from talos_agent.http."""
        from talos_agent.http import ResponseTooLargeError as RTL

        assert issubclass(RTL, Exception)

    def test_check_response_size_importable_from_api_client(self) -> None:
        """_check_response_size is a module-level callable."""
        assert callable(_check_response_size)

    def test_response_too_large_error_is_exception_subclass(self) -> None:
        """ResponseTooLargeError extends Exception, not BaseException directly."""
        assert issubclass(ResponseTooLargeError, Exception)

    def test_response_too_large_attributes(self) -> None:
        """Error carries the expected attributes with correct types."""
        err = ResponseTooLargeError(
            url="http://test.local/api/jobs/pending",
            actual_bytes=5_000,
            limit_bytes=4_096,
        )
        assert isinstance(err.url_path, str)
        assert isinstance(err.actual_bytes, int)
        assert isinstance(err.limit_bytes, int)
        assert err.actual_bytes == 5_000
        assert err.limit_bytes == 4_096
