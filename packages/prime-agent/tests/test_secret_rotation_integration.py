"""Real module-boundary checks for live API credential rotation."""

from __future__ import annotations

import pytest
import respx
from httpx import Response

from talos_agent.api_client import TalosAPIClient
from talos_agent.secret_store import SecretStore


@pytest.mark.asyncio
async def test_api_client_observes_atomic_rotation_without_recreation(mock_db, mock_settings):
    store = SecretStore(
        mock_db,
        keyring={"primary": b"k" * 32},
        active_key_id="primary",
        scope="integration",
    )
    first = store.stage("talos_api_key", "rotated-one", request_id="one")
    store.activate("talos_api_key", first.version, expected_active_version=None)
    mock_settings.secret_rotation_enabled = True
    mock_settings.bind_secret_store(store)
    client = TalosAPIClient(mock_settings)

    seen: list[str] = []

    def handler(request):
        seen.append(request.headers["Authorization"])
        return Response(200, json={"id": "test-talos-id"})

    with respx.mock:
        respx.get("http://test.local/api/talos/me").mock(side_effect=handler)
        await client.get_talos_me()
        second = store.stage("talos_api_key", "rotated-two", request_id="two")
        store.activate(
            "talos_api_key",
            second.version,
            expected_active_version=first.version,
        )
        await client.get_talos_me()

    await client.close()
    assert seen == ["Bearer rotated-one", "Bearer rotated-two"]
