"""Discord channel adapter — webhook + REST API publishing."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import httpx
from rich.console import Console

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult

if TYPE_CHECKING:
    from talos_agent.config import Settings

console = Console()

_DISCORD_API = "https://discord.com/api/v10"
_CHAR_LIMIT = 2000
_EMBED_DESC_LIMIT = 4096

# Embed accent colours
_COLOR_DEFAULT = 0x5865F2  # Discord blurple
_COLOR_GTM = 0x57F287      # Discord green — positive revenue / milestone
_COLOR_WARN = 0xFEE75C     # Yellow — warnings / alerts


class DiscordAdapter(BaseSocialAdapter):
    """Publishes Talos agent updates to Discord via webhook or bot REST API.

    Posting priority:
      1. Webhook URL (write-only, no bot token required)
      2. Bot token + channel ID (full read/write operations)

    GTM messages are formatted as Discord embeds with title, description,
    auto-detected accent colour, and optional metric fields.
    """

    channel_name = "Discord"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._webhook_url: str = settings.discord_webhook_url
        self._bot_token: str = settings.discord_bot_token
        self._channel_id: str = settings.discord_channel_id
        self._guild_id: str = settings.discord_guild_id
        self._cached_bot_id: str | None = None

    # ── Capabilities ─────────────────────────────────────────

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            char_limit=_CHAR_LIMIT,
            supports_media=True,
            supports_threads=True,
            supports_replies=True,
            supports_search=False,
            supports_mentions=bool(self._bot_token and self._channel_id),
            supports_analytics=bool(self._bot_token and self._channel_id),
        )

    # ── GTM message formatting ────────────────────────────────

    def _build_gtm_embed(self, content: str) -> dict:
        """Map agent playbook content to a Discord embed for GTM cycle posts."""
        lines = content.strip().splitlines()
        title = lines[0][:256] if lines else "Talos Agent Update"
        body = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""

        lower = content.lower()
        if any(kw in lower for kw in ("revenue", "earned", "sold", "profit", "milestone", "launched")):
            color = _COLOR_GTM
        elif any(kw in lower for kw in ("warn", "fail", "error", "issue", "alert", "blocked")):
            color = _COLOR_WARN
        else:
            color = _COLOR_DEFAULT

        embed: dict = {
            "title": title,
            "color": color,
            "footer": {"text": "Talos Agent · GTM Cycle"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if body:
            embed["description"] = body[:_EMBED_DESC_LIMIT]

        # Extract key:value metric pairs as inline fields (max 6)
        fields = []
        for m in re.finditer(r"([\w][\w \t]{0,39}?):\s*([\d,.]+[ \t]*%?)\b", content):
            label, value = m.group(1).strip(), m.group(2).strip()
            if len(fields) < 6:
                fields.append({"name": label, "value": value, "inline": True})
        if fields:
            embed["fields"] = fields

        return embed

    # ── Bot auth header ───────────────────────────────────────

    @property
    def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bot {self._bot_token}",
            "Content-Type": "application/json",
        }

    # ── Publishing ───────────────────────────────────────────

    async def post(self, content: str, **kwargs) -> PublishResult:
        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(status="failed", channel=self.channel_name, content=content, error=error)

        embed = self._build_gtm_embed(content)
        # Include short plain-text fallback for non-embed clients
        plain = content[:200] if len(content) <= 200 else ""
        payload: dict = {"embeds": [embed], "content": plain}

        if self._webhook_url:
            return await self._webhook_post(payload, content)

        if self._bot_token and self._channel_id:
            return await self._api_post(
                f"{_DISCORD_API}/channels/{self._channel_id}/messages",
                payload,
                content,
            )

        return PublishResult(
            status="failed",
            channel=self.channel_name,
            content=content,
            error=(
                "Discord not configured: set DISCORD_WEBHOOK_URL "
                "or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID"
            ),
        )

    async def _webhook_post(self, payload: dict, content: str) -> PublishResult:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{self._webhook_url}?wait=true", json=payload)
        if resp.status_code in (200, 204):
            data: dict = resp.json() if resp.content else {}
            msg_id = str(data.get("id", ""))
            channel = data.get("channel_id", "")
            guild = data.get("guild_id", "@me")
            return PublishResult(
                status="posted",
                channel=self.channel_name,
                content=content,
                post_id=msg_id,
                url=f"https://discord.com/channels/{guild}/{channel}/{msg_id}",
                metadata={"method": "webhook"},
            )
        return PublishResult(
            status="failed",
            channel=self.channel_name,
            content=content,
            error=f"Webhook POST failed: HTTP {resp.status_code} — {resp.text[:200]}",
        )

    async def _api_post(self, url: str, payload: dict, content: str) -> PublishResult:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, headers=self._auth_headers, json=payload)
        if resp.status_code == 200:
            data = resp.json()
            msg_id = data.get("id", "")
            guild = data.get("guild_id", self._guild_id or "@me")
            return PublishResult(
                status="posted",
                channel=self.channel_name,
                content=content,
                post_id=msg_id,
                url=f"https://discord.com/channels/{guild}/{self._channel_id}/{msg_id}",
                metadata={"method": "bot_api"},
            )
        return PublishResult(
            status="failed",
            channel=self.channel_name,
            content=content,
            error=f"API POST failed: HTTP {resp.status_code} — {resp.text[:200]}",
        )

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        """Reply to a Discord message using its discord.com/channels/... URL."""
        if not (self._bot_token and self._channel_id):
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error="Replies require DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID",
            )

        # Parse channel and message IDs from URL
        m = re.search(r"/channels/\d+/(\d+)/(\d+)$", target_url)
        channel_id = m.group(1) if m else self._channel_id
        message_id = m.group(2) if m else None

        payload: dict = {"content": content[:_CHAR_LIMIT]}
        if message_id:
            payload["message_reference"] = {"message_id": message_id}

        url = f"{_DISCORD_API}/channels/{channel_id}/messages"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, headers=self._auth_headers, json=payload)
        if resp.status_code == 200:
            data = resp.json()
            return PublishResult(
                status="posted",
                channel=self.channel_name,
                content=content,
                post_id=data.get("id"),
                metadata={"target_url": target_url, "reply_to": message_id},
            )
        return PublishResult(
            status="failed",
            channel=self.channel_name,
            content=content,
            error=f"Reply failed: HTTP {resp.status_code} — {resp.text[:200]}",
        )

    # ── Discovery ────────────────────────────────────────────

    async def get_mentions(self, **kwargs) -> list[dict]:
        """Fetch recent messages that mention the bot in the configured channel."""
        if not (self._bot_token and self._channel_id):
            console.print("[yellow]Discord get_mentions: requires BOT_TOKEN + CHANNEL_ID.[/yellow]")
            return []

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{_DISCORD_API}/channels/{self._channel_id}/messages",
                headers=self._auth_headers,
                params={"limit": 50},
            )
        if resp.status_code != 200:
            return []

        bot_id = await self._get_bot_id()
        mention_tag = f"<@{bot_id}>" if bot_id else None
        guild = self._guild_id or "@me"

        return [
            {
                "id": msg["id"],
                "author": msg["author"]["username"],
                "content": msg["content"],
                "timestamp": msg["timestamp"],
                "url": f"https://discord.com/channels/{guild}/{self._channel_id}/{msg['id']}",
            }
            for msg in resp.json()
            if mention_tag and mention_tag in msg.get("content", "")
        ]

    async def search(self, query: str, **kwargs) -> list[dict]:
        """Search recent channel messages for a keyword (client-side filter, last 100 msgs)."""
        if not (self._bot_token and self._channel_id):
            return []

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{_DISCORD_API}/channels/{self._channel_id}/messages",
                headers=self._auth_headers,
                params={"limit": 100},
            )
        if resp.status_code != 200:
            return []

        q = query.lower()
        return [
            {
                "id": msg["id"],
                "author": msg["author"]["username"],
                "content": msg["content"],
                "timestamp": msg["timestamp"],
            }
            for msg in resp.json()
            if q in msg.get("content", "").lower()
        ]

    # ── Analytics ────────────────────────────────────────────

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        """Find a message by content snippet and return its reaction counts."""
        if not (self._bot_token and self._channel_id):
            return {"error": "Requires DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID"}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{_DISCORD_API}/channels/{self._channel_id}/messages",
                headers=self._auth_headers,
                params={"limit": 100},
            )
        if resp.status_code != 200:
            return {"found": False, "error": f"HTTP {resp.status_code}"}

        snippet = content_snippet.lower()
        for msg in resp.json():
            if snippet in msg.get("content", "").lower():
                reactions = {
                    r["emoji"].get("name", "?"): r["count"]
                    for r in msg.get("reactions", [])
                }
                return {
                    "found": True,
                    "message_id": msg["id"],
                    "reactions": reactions,
                    "total_reactions": sum(reactions.values()),
                    "timestamp": msg["timestamp"],
                }
        return {"found": False}

    async def get_profile_stats(self, **kwargs) -> dict:
        """Return bot identity and guild member counts."""
        if not self._bot_token:
            return {"error": "Requires DISCORD_BOT_TOKEN"}

        async with httpx.AsyncClient(timeout=30) as client:
            bot_resp = await client.get(f"{_DISCORD_API}/users/@me", headers=self._auth_headers)
        if bot_resp.status_code != 200:
            return {"error": f"HTTP {bot_resp.status_code}"}

        bot = bot_resp.json()
        stats: dict = {"bot_username": bot.get("username"), "bot_id": bot.get("id")}

        if self._guild_id:
            async with httpx.AsyncClient(timeout=30) as client:
                guild_resp = await client.get(
                    f"{_DISCORD_API}/guilds/{self._guild_id}?with_counts=true",
                    headers=self._auth_headers,
                )
            if guild_resp.status_code == 200:
                guild = guild_resp.json()
                stats["guild_name"] = guild.get("name")
                stats["member_count"] = guild.get("approximate_member_count")
                stats["online_count"] = guild.get("approximate_presence_count")

        return stats

    # ── Internal helpers ──────────────────────────────────────

    async def _get_bot_id(self) -> str | None:
        if self._cached_bot_id:
            return self._cached_bot_id
        if not self._bot_token:
            return None
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_DISCORD_API}/users/@me", headers=self._auth_headers)
        if resp.status_code == 200:
            self._cached_bot_id = resp.json()["id"]
            return self._cached_bot_id
        return None
