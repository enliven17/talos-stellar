"""Tests for A2A composition timeout bounds (#566).

Verifies that:
- Settings carries the correct default A2A timeout fields.
- TalosAPIClient._a2a_timeout builds the right httpx.Timeout from those settings.
- All six A2A methods (get_service, submit_commerce, get_pending_jobs, claim_job,
  submit_job_result, heartbeat_job) forward the timeout to the underlying HTTP helper.
- Non-A2A methods (get_talos, report_activity) do NOT receive the A2A timeout.
- httpx.TimeoutException raised inside get_service propagates to the caller.
- Boundary value: a2a_read_timeout=0.001 is accepted without error.
- Timeout override: if settings.a2a_read_timeout=60 the resulting Timeout reflects 60.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch, call
import pytest
import httpx

from talos_agent.config import Settings
from talos_agent.api_client import TalosAPIClient


# ── Helpers ────────────────────────────────────────────────────────────────────


def _make_settings(**overrides) -> MagicMock:
    """Return a MagicMock that looks like Settings with sensible A2A defaults."""
    s = MagicMock(spec=Settings)
    s.talos_api_url = "https://talos-stellar.vercel.app"
    s.talos_api_key = "tak_test"
    s.talos_id = "talos-test"
    s.a2a_connect_timeout = overrides.get("a2a_connect_timeout", 10.0)
    s.a2a_read_timeout = overrides.get("a2a_read_timeout", 30.0)
    s.a2a_write_timeout = overrides.get("a2a_write_timeout", 10.0)
    s.a2a_pool_timeout = overrides.get("a2a_pool_timeout", 5.0)
    return s


def _make_client(**settings_overrides) -> TalosAPIClient:
    """Build a TalosAPIClient with a mocked httpx.AsyncClient."""
    settings = _make_settings(**settings_overrides)
    with patch("talos_agent.api_client.httpx.AsyncClient") as MockAsyncClient:
        mock_http = MagicMock()
        MockAsyncClient.return_value = mock_http
        client = TalosAPIClient(settings)
    # Replace the internal _client with a fresh MagicMock for per-test tracking
    client._client = MagicMock()
    return client


# ── Config defaults ────────────────────────────────────────────────────────────


class TestSettingsDefaults:
    """Settings class must expose correct default A2A timeout values."""

    def test_default_connect_timeout(self):
        s = Settings(talos_api_key="x", _env_file=None)
        assert s.a2a_connect_timeout == 10.0

    def test_default_read_timeout(self):
        s = Settings(talos_api_key="x", _env_file=None)
        assert s.a2a_read_timeout == 30.0

    def test_default_write_timeout(self):
        s = Settings(talos_api_key="x", _env_file=None)
        assert s.a2a_write_timeout == 10.0

    def test_default_pool_timeout(self):
        s = Settings(talos_api_key="x", _env_file=None)
        assert s.a2a_pool_timeout == 5.0

    def test_defaults_are_sensible_positive_floats(self):
        s = Settings(talos_api_key="x", _env_file=None)
        for attr in ("a2a_connect_timeout", "a2a_read_timeout", "a2a_write_timeout", "a2a_pool_timeout"):
            assert getattr(s, attr) > 0, f"{attr} should be positive"


# ── _a2a_timeout property ─────────────────────────────────────────────────────


class TestA2aTimeoutProperty:
    """TalosAPIClient._a2a_timeout must build httpx.Timeout from settings."""

    def test_returns_httpx_timeout_instance(self):
        client = _make_client()
        t = client._a2a_timeout
        assert isinstance(t, httpx.Timeout)

    def test_connect_comes_from_settings(self):
        client = _make_client(a2a_connect_timeout=7.5)
        assert client._a2a_timeout.connect == 7.5

    def test_read_comes_from_settings(self):
        client = _make_client(a2a_read_timeout=45.0)
        assert client._a2a_timeout.read == 45.0

    def test_write_comes_from_settings(self):
        client = _make_client(a2a_write_timeout=8.0)
        assert client._a2a_timeout.write == 8.0

    def test_pool_comes_from_settings(self):
        client = _make_client(a2a_pool_timeout=3.0)
        assert client._a2a_timeout.pool == 3.0

    def test_all_fields_match_defaults(self):
        client = _make_client()
        t = client._a2a_timeout
        assert t.connect == 10.0
        assert t.read == 30.0
        assert t.write == 10.0
        assert t.pool == 5.0

    def test_timeout_override_read_60(self):
        """If a2a_read_timeout is set to 60, the Timeout.read must be 60."""
        client = _make_client(a2a_read_timeout=60.0)
        assert client._a2a_timeout.read == 60.0

    def test_boundary_very_small_read_timeout(self):
        """a2a_read_timeout=0.001 must be accepted and reflected exactly."""
        client = _make_client(a2a_read_timeout=0.001)
        assert client._a2a_timeout.read == pytest.approx(0.001)

    def test_property_is_idempotent(self):
        """Calling _a2a_timeout twice should return equal Timeout objects."""
        client = _make_client()
        t1 = client._a2a_timeout
        t2 = client._a2a_timeout
        assert t1.connect == t2.connect
        assert t1.read == t2.read
        assert t1.write == t2.write
        assert t1.pool == t2.pool


# ── A2A methods pass timeout ───────────────────────────────────────────────────


class TestGetServicePassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()
        expected_timeout = client._a2a_timeout

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 402

        with patch.object(client, "_get", new_callable=AsyncMock, return_value=mock_response) as mock_get:
            await client.get_service("other-talos")

        mock_get.assert_called_once()
        _, kwargs = mock_get.call_args
        assert "timeout" in kwargs
        passed = kwargs["timeout"]
        assert isinstance(passed, httpx.Timeout)
        assert passed.read == expected_timeout.read
        assert passed.connect == expected_timeout.connect

    @pytest.mark.asyncio
    async def test_passes_timeout_with_service_type(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 402

        with patch.object(client, "_get", new_callable=AsyncMock, return_value=mock_response) as mock_get:
            await client.get_service("other-talos", service_type="analytics")

        _, kwargs = mock_get.call_args
        assert "timeout" in kwargs


class TestSubmitCommercePassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()
        expected_timeout = client._a2a_timeout

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"jobId": "j1", "status": "submitted"}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.submit_commerce("other-talos", payment_header="x402-hdr")

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert "timeout" in kwargs
        passed = kwargs["timeout"]
        assert isinstance(passed, httpx.Timeout)
        assert passed.read == expected_timeout.read


class TestGetPendingJobsPassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = []

        with patch.object(client, "_get", new_callable=AsyncMock, return_value=mock_response) as mock_get:
            await client.get_pending_jobs()

        mock_get.assert_called_once()
        _, kwargs = mock_get.call_args
        assert "timeout" in kwargs
        assert isinstance(kwargs["timeout"], httpx.Timeout)


class TestClaimJobPassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"fencingToken": 42}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.claim_job("job-123")

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert "timeout" in kwargs
        assert isinstance(kwargs["timeout"], httpx.Timeout)


class TestSubmitJobResultPassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"status": "done"}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.submit_job_result("job-123", result={"output": "ok"})

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert "timeout" in kwargs
        assert isinstance(kwargs["timeout"], httpx.Timeout)


class TestHeartbeatJobPassesTimeout:
    @pytest.mark.asyncio
    async def test_passes_timeout_kwarg(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"expiry": "2026-09-26T17:00:00Z"}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.heartbeat_job("job-123", fencing_token=7)

        mock_post.assert_called_once()
        _, kwargs = mock_post.call_args
        assert "timeout" in kwargs
        assert isinstance(kwargs["timeout"], httpx.Timeout)


# ── Non-A2A methods must NOT receive the A2A timeout ─────────────────────────


class TestNonA2AMethodsNoTimeout:
    """get_talos and report_activity are internal API calls, not A2A — they must
    not be passed the A2A timeout object."""

    @pytest.mark.asyncio
    async def test_get_talos_no_a2a_timeout(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": "talos-test"}

        with patch.object(client, "_get", new_callable=AsyncMock, return_value=mock_response) as mock_get:
            await client.get_talos("talos-test")

        _, kwargs = mock_get.call_args
        # Should not receive a timeout kwarg (or if it does, it must not be an httpx.Timeout)
        assert "timeout" not in kwargs

    @pytest.mark.asyncio
    async def test_report_activity_no_a2a_timeout(self):
        client = _make_client()

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 201
        mock_response.json.return_value = {"id": "act-1"}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.report_activity(
                "talos-test", type_="tweet", content="hello", channel="twitter"
            )

        _, kwargs = mock_post.call_args
        assert "timeout" not in kwargs


# ── TimeoutException propagation ──────────────────────────────────────────────


class TestTimeoutExceptionPropagates:
    """httpx.TimeoutException raised by get_service must propagate to the caller."""

    @pytest.mark.asyncio
    async def test_get_service_propagates_timeout_exception(self):
        client = _make_client()

        with patch.object(
            client,
            "_get",
            new_callable=AsyncMock,
            side_effect=httpx.TimeoutException("timed out"),
        ):
            with pytest.raises(httpx.TimeoutException):
                await client.get_service("slow-talos")

    @pytest.mark.asyncio
    async def test_submit_commerce_propagates_timeout_exception(self):
        client = _make_client()

        with patch.object(
            client,
            "_post",
            new_callable=AsyncMock,
            side_effect=httpx.TimeoutException("timed out"),
        ):
            with pytest.raises(httpx.TimeoutException):
                await client.submit_commerce("slow-talos", payment_header="hdr")

    @pytest.mark.asyncio
    async def test_get_pending_jobs_propagates_timeout_exception(self):
        client = _make_client()

        with patch.object(
            client,
            "_get",
            new_callable=AsyncMock,
            side_effect=httpx.TimeoutException("timed out"),
        ):
            with pytest.raises(httpx.TimeoutException):
                await client.get_pending_jobs()


# ── Timeout values reflect settings override ──────────────────────────────────


class TestTimeoutReflectsSettingsOverride:
    """When settings carry non-default values, the forwarded Timeout must match."""

    @pytest.mark.asyncio
    async def test_read_timeout_60_reflected_in_get_service(self):
        client = _make_client(a2a_read_timeout=60.0)

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 402

        with patch.object(client, "_get", new_callable=AsyncMock, return_value=mock_response) as mock_get:
            await client.get_service("other-talos")

        _, kwargs = mock_get.call_args
        assert kwargs["timeout"].read == 60.0

    @pytest.mark.asyncio
    async def test_connect_timeout_3_reflected_in_claim_job(self):
        client = _make_client(a2a_connect_timeout=3.0)

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {"fencingToken": 1}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.claim_job("job-abc")

        _, kwargs = mock_post.call_args
        assert kwargs["timeout"].connect == 3.0

    @pytest.mark.asyncio
    async def test_pool_timeout_1_reflected_in_heartbeat_job(self):
        client = _make_client(a2a_pool_timeout=1.0)

        mock_response = MagicMock(spec=httpx.Response)
        mock_response.status_code = 200
        mock_response.json.return_value = {}

        with patch.object(client, "_post", new_callable=AsyncMock, return_value=mock_response) as mock_post:
            await client.heartbeat_job("job-abc", fencing_token=5)

        _, kwargs = mock_post.call_args
        assert kwargs["timeout"].pool == 1.0
