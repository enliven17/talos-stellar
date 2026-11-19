"""Tests for the Mastodon social publishing adapter.

All HTTP is mocked via ``httpx.MockTransport``; no real instance or token is
contacted.  These tests cover posting, replies, credential-gating, the
character limit, the health snapshot, and capability-sandbox denial of
undeclared operations.
"""

from __future__ import annotations

import json

import httpx
import pytest

from talos_agent.adapters.base import ChannelCapabilities, PublishResult
from talos_agent.adapters.capability import (
    AdapterCapabilityManifest,
    AdapterResourceLimits,
    AdapterSandbox,
    CapabilityDeniedError,
    NetworkRule,
)
from talos_agent.adapters.mastodon import (
    DEFAULT_CHAR_LIMIT,
    DEFAULT_VISIBILITY,
    MastodonAdapter,
    MastodonAdapterConfig,
)
from talos_agent.adapters.snapshots import MastodonHealthSnapshot
from talos_agent.config import Settings


# ── Transport helper ──────────────────────────────────────────────────────


class _DirectClient:
    """Minimal AdapterHTTPClient backed by an httpx.MockTransport."""

    def __init__(self, transport: httpx.MockTransport) -> None:
        self._transport = transport

    async def get(self, url: str, **kwargs) -> httpx.Response:
        async with httpx.AsyncClient(transport=self._transport) as client:
            return await client.get(url, **kwargs)

    async def post(self, url: str, **kwargs) -> httpx.Response:
        async with httpx.AsyncClient(transport=self._transport) as client:
            return await client.post(url, **kwargs)


def _ok_transport(status_id: str = "109999999999999999") -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": status_id,
                "url": f"https://mastodon.social/@user/{status_id}",
            },
        )

    return httpx.MockTransport(handler)


# ── Posting ───────────────────────────────────────────────────────────────


class TestMastodonPost:
    @pytest.mark.asyncio
    async def test_post_sends_status_with_bearer_token(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["headers"] = dict(request.headers)
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"id": "109999999999999999", "url": "https://mastodon.social/@user/109999999999999999"},
            )

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="test-token",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Hello from Talos")

        assert result.status == "posted"
        assert result.post_id == "109999999999999999"
        assert result.url == "https://mastodon.social/@user/109999999999999999"
        assert captured["url"] == "https://mastodon.social/api/v1/statuses"
        assert captured["headers"]["authorization"] == "Bearer test-token"
        assert captured["body"]["status"] == "Hello from Talos"
        assert captured["body"]["visibility"] == DEFAULT_VISIBILITY

    @pytest.mark.asyncio
    async def test_post_respects_configured_visibility(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "1", "url": "https://example.social/@u/1"})

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://example.social",
                legacy_access_token="tok",
                visibility="unlisted",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Quiet post")

        assert result.status == "posted"
        assert captured["body"]["visibility"] == "unlisted"

    @pytest.mark.asyncio
    async def test_post_visibility_kwarg_overrides_config(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "1", "url": "https://example.social/@u/1"})

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://example.social",
                legacy_access_token="tok",
                visibility="public",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Direct message", visibility="direct")

        assert result.status == "posted"
        assert captured["body"]["visibility"] == "direct"

    @pytest.mark.asyncio
    async def test_post_invalid_visibility_falls_back_to_default(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "1", "url": "https://example.social/@u/1"})

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://example.social",
                legacy_access_token="tok",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("post", visibility="bogus")

        assert result.status == "posted"
        assert captured["body"]["visibility"] == DEFAULT_VISIBILITY


# ── Replies ───────────────────────────────────────────────────────────────


class TestMastodonReply:
    @pytest.mark.asyncio
    async def test_reply_sets_in_reply_to_id_from_url(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"id": "111111111111111112", "url": "https://mastodon.social/@user/111111111111111112"},
            )

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.reply(
            "https://mastodon.social/@user/111111111111111111", "Reply text"
        )

        assert result.status == "posted"
        assert result.post_id == "111111111111111112"
        assert captured["body"]["in_reply_to_id"] == "111111111111111111"
        assert captured["body"]["status"] == "Reply text"

    @pytest.mark.asyncio
    async def test_reply_returns_error_for_unparseable_url(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            ),
            http=_DirectClient(_ok_transport()),
        )

        result = await adapter.reply("https://mastodon.social/@user/notanumber", "hi")

        assert result.status == "failed"
        assert "status ID" in (result.error or "")


# ── Credential gating ─────────────────────────────────────────────────────


class TestMastodonConfiguration:
    @pytest.mark.asyncio
    async def test_missing_token_disables_adapter(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(instance_url="https://mastodon.social"),
            http=_DirectClient(_ok_transport()),
        )
        result = await adapter.post("Hello")

        assert result.status == "failed"
        assert "not configured" in (result.error or "")

    @pytest.mark.asyncio
    async def test_missing_instance_url_disables_adapter(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(legacy_access_token="tok"),
            http=_DirectClient(_ok_transport()),
        )
        result = await adapter.post("Hello")

        assert result.status == "failed"
        assert "not configured" in (result.error or "")

    def test_health_snapshot_reports_credentials(self):
        configured = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        unconfigured = MastodonAdapter(MastodonAdapterConfig())

        assert configured.health_snapshot() == MastodonHealthSnapshot(
            has_access_token=True, has_instance_url=True
        )
        assert unconfigured.health_snapshot() == MastodonHealthSnapshot(
            has_access_token=False, has_instance_url=False
        )

    def test_health_snapshot_to_dict(self):
        snap = MastodonHealthSnapshot(has_access_token=True, has_instance_url=False)
        d = snap.to_dict()
        assert d == {"has_access_token": True, "has_instance_url": False}


# ── Character limit ────────────────────────────────────────────────────────


class TestMastodonCharLimit:
    def test_default_char_limit_is_500(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        caps = adapter.get_capabilities()
        assert caps.char_limit == DEFAULT_CHAR_LIMIT
        assert caps.char_limit == 500

    def test_configurable_char_limit(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
                char_limit=1000,
            )
        )
        caps = adapter.get_capabilities()
        assert caps.char_limit == 1000

    @pytest.mark.asyncio
    async def test_post_over_limit_returns_error_without_request(self):
        called = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            called["n"] += 1
            return httpx.Response(200, json={"id": "1", "url": "https://mastodon.social/@u/1"})

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
                char_limit=10,
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("x" * 50)

        assert result.status == "failed"
        assert "exceeds the 10 character limit" in (result.error or "")
        assert called["n"] == 0


# ── Error handling ────────────────────────────────────────────────────────


class TestMastodonErrors:
    @pytest.mark.asyncio
    async def test_api_401_returns_failed_result(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "invalid token"})

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="bad",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Hello")

        assert result.status == "failed"
        assert "401" in (result.error or "")

    @pytest.mark.asyncio
    async def test_non_json_response_returns_failed(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>not json</html>")

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Hello")

        assert result.status == "failed"
        assert "non-JSON" in (result.error or "")

    @pytest.mark.asyncio
    async def test_connection_error_returns_failed(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            ),
            http=_DirectClient(httpx.MockTransport(handler)),
        )

        result = await adapter.post("Hello")

        assert result.status == "failed"
        assert "Connection error" in (result.error or "")


# ── Stubs ─────────────────────────────────────────────────────────────────


class TestMastodonStubs:
    @pytest.mark.asyncio
    async def test_get_mentions_returns_empty(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        assert await adapter.get_mentions() == []

    @pytest.mark.asyncio
    async def test_search_returns_empty(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        assert await adapter.search("query") == []

    @pytest.mark.asyncio
    async def test_get_post_performance_unsupported(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        result = await adapter.get_post_performance("snippet")
        assert "not supported" in result["error"]

    @pytest.mark.asyncio
    async def test_get_profile_stats_unsupported(self):
        adapter = MastodonAdapter(
            MastodonAdapterConfig(
                instance_url="https://mastodon.social",
                legacy_access_token="tok",
            )
        )
        result = await adapter.get_profile_stats()
        assert "not supported" in result["error"]


# ── Settings path ─────────────────────────────────────────────────────────


class TestMastodonSettingsPath:
    @pytest.mark.asyncio
    async def test_post_via_settings_channel_configs(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"id": "55555", "url": "https://botsin.space/@user/55555"},
            )

        settings = Settings()
        settings.channel_configs = {
            "mastodon": {
                "access_token": "settings-token",
                "instance_url": "https://botsin.space",
                "visibility": "private",
            }
        }

        adapter = MastodonAdapter(settings, http=_DirectClient(httpx.MockTransport(handler)))

        result = await adapter.post("Via settings")

        assert result.status == "posted"
        assert captured["url"] == "https://botsin.space/api/v1/statuses"
        assert captured["body"]["visibility"] == "private"


# ── Capability sandbox ────────────────────────────────────────────────────


class TestMastodonCapabilityManifest:
    def test_default_manifests_includes_mastodon(self):
        from talos_agent.adapters.capability import default_manifests

        manifests = default_manifests(AdapterResourceLimits())
        assert "mastodon" in manifests
        manifest = manifests["mastodon"]
        assert "post" in manifest.operations
        assert "reply" in manifest.operations
        assert "mastodon_access_token" in manifest.secrets

    def test_sandbox_denies_search_not_in_manifest(self):
        """An operation absent from the manifest must raise CapabilityDeniedError."""
        import asyncio
        import sqlite3
        import tempfile

        from talos_agent.db import LocalDB

        with tempfile.TemporaryDirectory() as tmp:
            db_path = f"{tmp}/sandbox.db"
            db = LocalDB(db_path)

            manifest = AdapterCapabilityManifest(
                adapter_id="mastodon",
                # 'search' intentionally omitted
                operations=frozenset({"post", "reply"}),
                secrets=frozenset({"mastodon_access_token"}),
                network=(),
                limits=AdapterResourceLimits(),
            )
            sandbox = AdapterSandbox(
                manifests={"mastodon": manifest},
                db=db,
                secret_resolver=lambda name: "tok" if name == "mastodon_access_token" else "",
            )
            adapter = MastodonAdapter(
                MastodonAdapterConfig(
                    instance_url="https://mastodon.social",
                    legacy_access_token="tok",
                ),
                secrets=sandbox.secrets("mastodon"),
                http=sandbox.http("mastodon"),
            )
            wrapped = sandbox.wrap(adapter)

            with pytest.raises(CapabilityDeniedError):
                asyncio.get_event_loop().run_until_complete(wrapped.search("query"))
