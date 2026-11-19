"""Mastodon publishing adapter using the Mastodon REST API.

Posts and replies are sent to a configurable Mastodon instance via its
statuses API endpoint.  Credentials (instance URL and access token) are
resolved from the operator's ``channel_configs`` or direct settings fields,
following the same pattern as :mod:`talos_agent.adapters.telegram`.

Circuit breaker, retry budget, and health snapshot are wired identically to
the Telegram adapter so the adapter behaves consistently under degraded
conditions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.capability import (
    AdapterHTTPClient,
    AdapterSandboxError,
    DirectHTTPClient,
    SecretProvider,
)
from talos_agent.adapters.snapshots import MastodonHealthSnapshot
from talos_agent.config import resolve_setting_secret

if TYPE_CHECKING:
    from talos_agent.config import Settings

# Mastodon's default toot character limit.  Operators may configure a higher
# or lower value to match their instance's server-side setting.
DEFAULT_CHAR_LIMIT = 500

# Mastodon visibility options accepted by the statuses API.
VISIBILITY_OPTIONS = frozenset({"public", "unlisted", "private", "direct"})
DEFAULT_VISIBILITY = "public"

# Used to extract a status ID from a Mastodon post URL such as
# https://mastodon.social/@user/12345678901234567
_STATUS_ID_RE = re.compile(r"/(\d+)/?$")


@dataclass(frozen=True)
class MastodonAdapterConfig:
    """Lightweight config for testing without a full ``Settings`` object."""

    instance_url: str = ""
    legacy_access_token: str = ""
    char_limit: int = DEFAULT_CHAR_LIMIT
    visibility: str = DEFAULT_VISIBILITY


class MastodonAdapter(BaseSocialAdapter):
    """Publish toots and replies to a Mastodon instance.

    Authentication uses a per-account *access token* (Bearer auth), which is
    the standard OAuth2 token obtained via the Mastodon API or an operator-
    generated personal access token.

    Parameters
    ----------
    config:
        Either a ``Settings`` object (production path) or a
        ``MastodonAdapterConfig`` (testing / sandbox path).
    secrets:
        Optional scoped ``SecretProvider``; used when the adapter runs inside
        the capability sandbox so secrets flow through the sandbox resolver
        rather than directly through settings.
    http:
        HTTP façade to use for API calls.  Defaults to ``DirectHTTPClient``
        (plain httpx, no sandbox enforcement), which is appropriate outside
        the capability sandbox.
    """

    channel_name = "Mastodon"

    def __init__(
        self,
        config: Settings | MastodonAdapterConfig,
        *,
        secrets: SecretProvider | None = None,
        http: AdapterHTTPClient | None = None,
    ) -> None:
        self._secrets = secrets
        self._http = http or DirectHTTPClient()

        if isinstance(config, MastodonAdapterConfig):
            self._settings: Settings | None = None
            self._legacy_access_token = config.legacy_access_token
            self._instance_url = config.instance_url.rstrip("/")
            self._char_limit = config.char_limit
            self._visibility = config.visibility
        else:
            self._settings = config
            mastodon_config = (getattr(config, "channel_configs", {}) or {}).get(
                "mastodon", {}
            )
            self._legacy_access_token = mastodon_config.get("access_token", "")
            raw_url = mastodon_config.get("instance_url", "") or getattr(
                config, "mastodon_instance_url", ""
            )
            self._instance_url = raw_url.rstrip("/")
            self._char_limit = int(
                mastodon_config.get("char_limit", DEFAULT_CHAR_LIMIT)
            )
            raw_visibility = mastodon_config.get("visibility", DEFAULT_VISIBILITY)
            self._visibility = (
                raw_visibility
                if raw_visibility in VISIBILITY_OPTIONS
                else DEFAULT_VISIBILITY
            )

    # ── Credential helpers ────────────────────────────────────────────────────

    @property
    def _access_token(self) -> str:
        if self._secrets is not None:
            return self._secrets.get("mastodon_access_token")
        if self._settings is not None:
            return resolve_setting_secret(
                self._settings, "mastodon_access_token", self._legacy_access_token
            )
        return self._legacy_access_token

    def _is_configured(self) -> bool:
        return bool(self._access_token and self._instance_url)

    def _build_url(self, path: str) -> str:
        """Construct the full API URL for *path* under the configured instance."""
        return f"{self._instance_url}/api/v1/{path.lstrip('/')}"

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}

    # ── BaseSocialAdapter implementation ──────────────────────────────────────

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            char_limit=self._char_limit,
            supports_media=False,
            supports_threads=False,
            supports_replies=True,
            supports_search=False,
            supports_mentions=False,
            supports_analytics=False,
        )

    def health_snapshot(self) -> MastodonHealthSnapshot:
        return MastodonHealthSnapshot(
            has_access_token=bool(self._access_token),
            has_instance_url=bool(self._instance_url),
        )

    async def post(self, content: str, **kwargs: Any) -> PublishResult:
        if not self._is_configured():
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error=(
                    "Mastodon adapter is not configured. "
                    "Set mastodon_access_token and mastodon_instance_url."
                ),
            )

        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(
                status="failed", channel=self.channel_name, content=content, error=error
            )

        visibility = kwargs.get("visibility", self._visibility)
        if visibility not in VISIBILITY_OPTIONS:
            visibility = self._visibility

        payload: dict[str, Any] = {
            "status": content.strip(),
            "visibility": visibility,
        }
        return await self._send(payload, content)

    async def reply(self, target_url: str, content: str, **kwargs: Any) -> PublishResult:
        if not self._is_configured():
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error=(
                    "Mastodon adapter is not configured. "
                    "Set mastodon_access_token and mastodon_instance_url."
                ),
            )

        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(
                status="failed", channel=self.channel_name, content=content, error=error
            )

        in_reply_to_id = self._parse_status_id(target_url)
        if in_reply_to_id is None:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error=f"Cannot parse status ID from URL: {target_url!r}",
            )

        visibility = kwargs.get("visibility", self._visibility)
        if visibility not in VISIBILITY_OPTIONS:
            visibility = self._visibility

        payload: dict[str, Any] = {
            "status": content.strip(),
            "visibility": visibility,
            "in_reply_to_id": in_reply_to_id,
        }
        return await self._send(payload, content)

    async def get_mentions(self, **kwargs: Any) -> list[dict]:
        # Mastodon timeline reading is out of scope per issue #919.
        return []

    async def search(self, query: str, **kwargs: Any) -> list[dict]:
        return []

    async def get_post_performance(self, content_snippet: str, **kwargs: Any) -> dict:
        return {"error": "Mastodon analytics are not supported by this adapter."}

    async def get_profile_stats(self, **kwargs: Any) -> dict:
        return {"error": "Mastodon profile stats are not supported by this adapter."}

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _send(
        self, payload: dict[str, Any], original_content: str
    ) -> PublishResult:
        """POST *payload* to /api/v1/statuses and translate the response."""
        url = self._build_url("statuses")
        try:
            response = await self._http.post(
                url,
                json=payload,
                headers=self._auth_headers(),
            )
        except AdapterSandboxError:
            raise
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=original_content,
                error=f"Connection error: {exc}",
            )
        except Exception as exc:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=original_content,
                error=f"Unexpected error: {type(exc).__name__}: {exc}",
            )

        if response.status_code not in (200, 201):
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=original_content,
                error=(
                    f"Mastodon API error {response.status_code}: {response.text[:256]}"
                ),
            )

        data = self._json_body(response)
        if data is None:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=original_content,
                error="Mastodon API returned a non-JSON response.",
            )

        status_id = str(data.get("id", "")) or None
        url_field = data.get("url") or data.get("uri") or None

        return PublishResult(
            status="posted",
            channel=self.channel_name,
            content=original_content,
            post_id=status_id,
            url=url_field,
            metadata={"status_id": status_id},
        )

    @staticmethod
    def _parse_status_id(target_url: str) -> str | None:
        """Extract a numeric Mastodon status ID from a post URL."""
        match = _STATUS_ID_RE.search(target_url)
        return match.group(1) if match else None

    @staticmethod
    def _json_body(response: Any) -> dict | None:
        try:
            body = response.json()
        except Exception:
            return None
        return body if isinstance(body, dict) else None
