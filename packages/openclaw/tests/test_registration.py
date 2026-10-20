"""Tests for TalosClient key rotation and talos_register header updates."""

import ast
from pathlib import Path
import httpx
import pytest

from talos_skill import tools
from talos_skill.client import TalosClient


def test_no_external_access_to_http_in_tools():
    """Verify acceptance criterion: No external access to _http remains in tools.py."""
    tools_file = Path(__file__).resolve().parent.parent / "talos_skill" / "tools.py"
    content = tools_file.read_text(encoding="utf-8")
    tree = ast.parse(content)

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr == "_http":
            pytest.fail(f"Found private attribute access `._http` at line {node.lineno} in tools.py")


def test_talos_client_set_api_key():
    """Verify TalosClient.set_api_key updates both attribute and default headers."""
    client = TalosClient(base_url="https://api.test", api_key=None)
    assert client.api_key == ""
    assert "Authorization" not in client._http.headers

    client.set_api_key("first-token")
    assert client.api_key == "first-token"
    assert client._http.headers["Authorization"] == "Bearer first-token"

    client.set_api_key("rotated-token")
    assert client.api_key == "rotated-token"
    assert client._http.headers["Authorization"] == "Bearer rotated-token"

    # Clearing the key
    client.set_api_key("")
    assert client.api_key == ""
    assert "Authorization" not in client._http.headers


@pytest.mark.asyncio
async def test_registration_and_subsequent_request_with_mock_transport():
    """Verify subsequent calls carry the new bearer token after talos_register."""
    captured_requests: list[httpx.Request] = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        if request.url.path == "/api/talos" and request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "id": "talos-777",
                    "name": "SuperBot",
                    "apiKeyOnce": "generated-secret-key-xyz",
                    "agentWalletAddress": "GBOTWALLETTALOS777",
                },
            )
        if request.url.path == "/api/talos/talos-777" and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": "talos-777",
                    "name": "SuperBot",
                    "status": "active",
                    "agentOnline": True,
                    "revenues": [],
                    "commerceServices": [],
                    "activities": [],
                    "approvals": [],
                    "gtmBudget": 1000,
                },
            )
        return httpx.Response(404, json={"detail": "not found"})

    transport = httpx.MockTransport(mock_handler)
    client = TalosClient(
        base_url="https://api.test",
        api_key=None,
        transport=transport,
    )

    # Inject client into tools module
    tools._client = client

    # Ensure no Authorization header before registration
    assert "Authorization" not in client._http.headers

    # 1. Register a new Talos
    reg_result = await tools.talos_register(
        name="SuperBot",
        category="Development",
        description="Autonomous developer bot",
    )
    assert reg_result["talos_id"] == "talos-777"
    assert reg_result["api_key"] == "generated-secret-key-xyz"
    assert client.api_key == "generated-secret-key-xyz"
    assert client._http.headers["Authorization"] == "Bearer generated-secret-key-xyz"

    # First request was the registration call
    assert len(captured_requests) == 1
    assert captured_requests[0].url.path == "/api/talos"
    assert "authorization" not in captured_requests[0].headers

    # 2. Subsequent call: talos_status
    status_result = await tools.talos_status()
    assert status_result["name"] == "SuperBot"

    # Second request was the status lookup
    assert len(captured_requests) == 2
    subsequent_req = captured_requests[1]
    assert subsequent_req.url.path == "/api/talos/talos-777"
    assert subsequent_req.headers.get("authorization") == "Bearer generated-secret-key-xyz"


@pytest.mark.asyncio
async def test_subsequent_request_header_after_set_api_key():
    """Verify httpx.MockTransport asserts Authorization header on subsequent call after set_api_key."""
    captured_requests: list[httpx.Request] = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(request)
        return httpx.Response(200, json={"services": []})

    transport = httpx.MockTransport(mock_handler)
    client = TalosClient(
        base_url="https://api.test",
        api_key="initial-key",
        transport=transport,
    )

    await client.discover_services()
    assert len(captured_requests) == 1
    assert captured_requests[0].headers.get("authorization") == "Bearer initial-key"

    # Rotate key via supported API
    client.set_api_key("rotated-new-key")

    await client.discover_services()
    assert len(captured_requests) == 2
    assert captured_requests[1].headers.get("authorization") == "Bearer rotated-new-key"
