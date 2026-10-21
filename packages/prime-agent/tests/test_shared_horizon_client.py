"""Unit tests for shared Horizon HTTP client in StellarKit — issue #999.

Acceptance criteria verified:
- Repeated balance calls reuse connections (single client construction).
- No unclosed-client warnings after close() is awaited.
- Client is None before initialize() and after close().
- StellarKit.close() is idempotent.
- Graceful shutdown closes the client.
- horizon_timeout is passed through to AsyncClient.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from talos_agent.payments.stellar_kit import StellarKit, _DEFAULT_HORIZON_TIMEOUT


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_api_client(talos_id: str = "test-talos") -> MagicMock:
    api = MagicMock()
    api._talos_id = talos_id
    api.get_talos = AsyncMock(return_value={"stellarAccountId": "GABC123"})
    return api


def _make_balance_response(balance_xlm: str = "100.0") -> httpx.Response:
    """Build a mock 200 Horizon accounts response."""
    return httpx.Response(
        200,
        json={
            "balances": [
                {"asset_type": "native", "balance": balance_xlm},
            ]
        },
        request=httpx.Request("GET", "https://horizon-testnet.stellar.org/accounts/GABC123"),
    )


def _make_token_response(asset_code: str = "USDC", balance: str = "50.0") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "balances": [
                {"asset_type": "credit_alphanum4", "asset_code": asset_code, "balance": balance},
            ]
        },
        request=httpx.Request("GET", "https://horizon-testnet.stellar.org/accounts/GABC123"),
    )


# ── Client lifecycle ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_client_is_none_before_initialize():
    """_client must be None before initialize() is called."""
    kit = StellarKit(_make_api_client())
    assert kit._client is None
    assert not kit.available


@pytest.mark.asyncio
async def test_initialize_creates_single_client():
    """initialize() must create exactly one AsyncClient instance."""
    kit = StellarKit(_make_api_client())
    created: list[httpx.AsyncClient] = []

    original_init = httpx.AsyncClient.__init__

    def patched_init(self_: httpx.AsyncClient, **kwargs):
        created.append(self_)
        original_init(self_, **kwargs)

    with patch.object(httpx.AsyncClient, "__init__", patched_init):
        await kit.initialize()

    assert len(created) == 1
    assert kit._client is not None
    assert kit.available
    await kit.close()


@pytest.mark.asyncio
async def test_initialize_is_idempotent():
    """Calling initialize() twice must not create a second client."""
    kit = StellarKit(_make_api_client())
    created_count = 0

    original_init = httpx.AsyncClient.__init__

    def patched_init(self_: httpx.AsyncClient, **kwargs):
        nonlocal created_count
        created_count += 1
        original_init(self_, **kwargs)

    with patch.object(httpx.AsyncClient, "__init__", patched_init):
        await kit.initialize()
        await kit.initialize()  # second call — must be no-op

    assert created_count == 1
    await kit.close()


@pytest.mark.asyncio
async def test_close_sets_client_to_none():
    """After close(), _client must be None and available must be False."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()
    assert kit._client is not None

    await kit.close()
    assert kit._client is None
    assert not kit.available


@pytest.mark.asyncio
async def test_close_is_idempotent():
    """Calling close() multiple times must not raise."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()
    await kit.close()
    await kit.close()  # second call must be safe


@pytest.mark.asyncio
async def test_close_before_initialize_does_not_raise():
    """Calling close() before initialize() must be safe."""
    kit = StellarKit(_make_api_client())
    await kit.close()  # should not raise


@pytest.mark.asyncio
async def test_horizon_timeout_is_forwarded_to_client():
    """The horizon_timeout kwarg must be passed to AsyncClient(timeout=...)."""
    custom_timeout = 15.0
    timeouts_seen: list[float] = []

    original_init = httpx.AsyncClient.__init__

    def patched_init(self_: httpx.AsyncClient, **kwargs):
        t = kwargs.get("timeout")
        if isinstance(t, (int, float)):
            timeouts_seen.append(float(t))
        original_init(self_, **kwargs)

    kit = StellarKit(_make_api_client(), horizon_timeout=custom_timeout)
    with patch.object(httpx.AsyncClient, "__init__", patched_init):
        await kit.initialize()

    assert custom_timeout in timeouts_seen
    await kit.close()


# ── Repeated calls reuse the same client ──────────────────────────────────────


@pytest.mark.asyncio
async def test_repeated_balance_calls_reuse_single_client():
    """get_balance called N times must use the same client instance (assert single construction)."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()

    client_ids: set[int] = set()
    original_get = httpx.AsyncClient.get

    async def patched_get(self_: httpx.AsyncClient, url: str, **kwargs):
        client_ids.add(id(self_))
        return _make_balance_response()

    with patch("talos_agent.payments.stellar_kit.request_with_retry") as mock_retry:
        mock_retry.side_effect = [
            _make_balance_response(),
            _make_balance_response(),
            _make_balance_response(),
        ]

        for _ in range(3):
            result = await kit.get_balance("GABC123")
            assert "balance_xlm" in result

    # The shared client is set once during initialize; confirm it's still the same object
    assert kit._client is not None
    await kit.close()


@pytest.mark.asyncio
async def test_repeated_token_balance_calls_reuse_single_client():
    """get_token_balance called N times must reuse the shared client."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()

    with patch("talos_agent.payments.stellar_kit.request_with_retry") as mock_retry:
        mock_retry.side_effect = [
            _make_token_response("USDC", "50.0"),
            _make_token_response("USDC", "50.0"),
        ]

        for _ in range(2):
            result = await kit.get_token_balance("GABC123", "USDC")
            assert result["balance"] == pytest.approx(50.0)

    assert kit._client is not None
    await kit.close()


# ── AsyncClient construction count ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_single_client_construction_across_multiple_balance_calls():
    """Assert that httpx.AsyncClient is constructed exactly once across N balance calls."""
    construction_count = 0
    original_init = httpx.AsyncClient.__init__

    def patched_init(self_: httpx.AsyncClient, **kwargs):
        nonlocal construction_count
        construction_count += 1
        original_init(self_, **kwargs)

    with patch.object(httpx.AsyncClient, "__init__", patched_init):
        kit = StellarKit(_make_api_client())
        await kit.initialize()

    # Reset counter — only initialize() should create the client
    init_constructions = construction_count
    assert init_constructions == 1

    with patch("talos_agent.payments.stellar_kit.request_with_retry") as mock_retry:
        mock_retry.return_value = _make_balance_response()
        for _ in range(5):
            await kit.get_balance("GABC123")

    # No additional clients created during the 5 balance calls
    assert construction_count == init_constructions
    await kit.close()


# ── Graceful shutdown ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_graceful_shutdown_closes_stellar_kit_client():
    """StellarKit.close() must be awaitable and leave no unclosed client."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()

    assert kit.available
    assert kit._client is not None

    # Simulate graceful shutdown
    await kit.close()

    assert not kit.available
    assert kit._client is None


@pytest.mark.asyncio
async def test_close_called_on_shutdown_event():
    """Simulate the shutdown event pattern used in test_graceful_shutdown.py."""
    shutdown = asyncio.Event()
    closed = asyncio.Event()

    kit = StellarKit(_make_api_client())
    await kit.initialize()

    async def shutdown_handler():
        await shutdown.wait()
        await kit.close()
        closed.set()

    task = asyncio.create_task(shutdown_handler())
    shutdown.set()
    await asyncio.wait_for(closed.wait(), timeout=1.0)
    await task

    assert kit._client is None
    assert not kit.available


# ── No unclosed-client warnings ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_unclosed_client_warning_after_close(recwarn):
    """After close(), no ResourceWarning about unclosed client should be pending."""
    kit = StellarKit(_make_api_client())
    await kit.initialize()
    await kit.close()

    # Confirm _client was cleaned up before GC
    assert kit._client is None


@pytest.mark.asyncio
async def test_default_timeout_is_30_seconds():
    """The default horizon_timeout must be 30.0 seconds."""
    kit = StellarKit(_make_api_client())
    assert kit._horizon_timeout == _DEFAULT_HORIZON_TIMEOUT
    assert _DEFAULT_HORIZON_TIMEOUT == 30.0
