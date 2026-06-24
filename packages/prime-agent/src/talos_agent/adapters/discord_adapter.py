"""Discord GTM publishing adapter — posts agent updates via an Incoming Webhook.

Posting never requires OAuth; a webhook URL is the only mandatory credential.
An optional Bot token unlocks message-read and reaction-metric endpoints.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

import httpx

from talos_agent.adapters.base import BaseSocialAdapter, PostResult

# Discord embed colour palette keyed on playbook tone / category keywords.
# Values are 24-bit RGB integers as expected by the Discord API.
_TONE_COLORS: dict[str, int] = {
    "professional": 0x0099FF,  # Blue
    "b2b": 0x0099FF,
    "corporate": 0x0099FF,
    "growth": 0xFF6600,  # Orange
    "energetic": 0xFF6600,
    "startup": 0xFF6600,
    "creative": 0x9B59B6,  # Purple
    "design": 0x9B59B6,
    "educational": 0x2ECC71,  # Green
    "research": 0x2ECC71,
    "analytics": 0x2ECC71,
    "financial": 0xF1C40F,  # Gold
    "finance": 0xF1C40F,
    "investment": 0xF1C40F,
    "bold": 0xE74C3C,  # Red
    "urgent": 0xE74C3C,
    "friendly": 0x1ABC9C,  # Teal
    "community": 0x1ABC9C,
}
_DEFAULT_COLOR = 0x5865F2  # Discord Blurple


class DiscordAdapter(BaseSocialAdapter):
    """Publishes GTM content to Discord using an Incoming Webhook.

    Rich embeds are constructed from the raw content and an optional playbook
    dict that carries tone, hashtags, and CTA tactics.

    Parameters
    ----------
    webhook_url:
        Discord Incoming Webhook URL (Settings > Integrations inside a channel).
    agent_name:
        Display name shown on webhook messages — defaults to the Talos agent name.
    agent_avatar_url:
        Optional image URL to override the webhook's default avatar.
    bot_token:
        Discord Bot token for reading messages and fetching reaction metrics.
        Leave blank if only posting is needed.
    """

    _DISCORD_API = "https://discord.com/api/v10"
    _MAX_EMBED_DESCRIPTION = 4096

    def __init__(
        self,
        webhook_url: str,
        agent_name: str = "Talos Agent",
        agent_avatar_url: str | None = None,
        bot_token: str = "",
    ) -> None:
        if not webhook_url:
            raise ValueError("discord_webhook_url must not be empty")
        self._webhook_url = webhook_url
        self._agent_name = agent_name
        self._agent_avatar_url = agent_avatar_url
        self._bot_token = bot_token
        self._http = httpx.AsyncClient(timeout=30.0)

    # ── BaseSocialAdapter API ───────────────────────────────────────────────

    @property
    def channel_name(self) -> str:
        return "Discord"

    async def post(self, content: str, **kwargs: Any) -> PostResult:
        """Post a GTM embed to Discord.

        Keyword args
        ------------
        title : str
            Optional embed title.
        playbook : dict
            Active playbook dict — used for tone colour, hashtags, and CTA.
        tone : str
            Explicit tone keyword (overrides playbook tone for colour selection).
        """
        playbook: dict[str, Any] | None = kwargs.get("playbook")
        title: str | None = kwargs.get("title") or None
        tone: str = kwargs.get("tone", "")

        payload = self.format_for_channel(content, playbook=playbook, title=title, tone=tone)
        return await self._send_webhook(payload)

    async def reply(self, reference_id: str, content: str, **kwargs: Any) -> PostResult:
        """Send a follow-up embed that quotes a prior message reference.

        Discord Incoming Webhooks cannot create a native threaded reply, so we
        prepend an attribution line.  Pass the original message URL as
        *reference_id* to produce a clickable quote.
        """
        prefix = (
            f"> ↩ [original message]({reference_id})\n\n"
            if reference_id.startswith("http")
            else f"> ↩ message `{reference_id}`\n\n"
        )
        return await self.post(prefix + content, **kwargs)

    async def get_metrics(self, reference_id: str) -> dict[str, Any]:
        """Return reaction counts for a Discord message.

        *reference_id* must be either ``channel_id/message_id`` or a full
        ``https://discord.com/channels/…`` message URL.
        Requires ``bot_token`` — returns ``{"available": False}`` otherwise.
        """
        if not self._bot_token:
            return {
                "available": False,
                "error": "Discord bot token not configured — set DISCORD_BOT_TOKEN",
            }

        channel_id, msg_id = _parse_reference(reference_id)
        if not channel_id or not msg_id:
            return {
                "available": False,
                "error": (
                    "Provide reference_id as 'channel_id/message_id' "
                    "or a full discord.com message URL"
                ),
            }

        try:
            resp = await self._http.get(
                f"{self._DISCORD_API}/channels/{channel_id}/messages/{msg_id}",
                headers={"Authorization": f"Bot {self._bot_token}"},
            )
        except httpx.HTTPError as exc:
            return {"available": False, "error": str(exc)}

        if resp.status_code != 200:
            return {"available": False, "error": f"HTTP {resp.status_code}: {resp.text}"}

        data = resp.json()
        reactions: list[dict[str, Any]] = data.get("reactions", [])
        return {
            "available": True,
            "message_id": msg_id,
            "channel_id": channel_id,
            "total_reactions": sum(r.get("count", 0) for r in reactions),
            "reactions": [
                {"emoji": r["emoji"].get("name", "?"), "count": r.get("count", 0)}
                for r in reactions
            ],
        }

    def format_for_channel(
        self,
        content: str,
        playbook: dict[str, Any] | None = None,
        title: str | None = None,
        tone: str = "",
        **_: Any,
    ) -> dict[str, Any]:
        """Build the full Discord webhook JSON payload with a rich embed."""
        embed = self._build_embed(content, playbook=playbook, title=title, tone=tone)
        payload: dict[str, Any] = {"username": self._agent_name, "embeds": [embed]}
        if self._agent_avatar_url:
            payload["avatar_url"] = self._agent_avatar_url
        return payload

    # ── Private helpers ─────────────────────────────────────────────────────

    async def _send_webhook(self, payload: dict[str, Any]) -> PostResult:
        try:
            resp = await self._http.post(
                self._webhook_url,
                json=payload,
                params={"wait": "true"},  # ask Discord to return the message object
            )
        except httpx.HTTPError as exc:
            return PostResult(success=False, channel=self.channel_name, error=str(exc))

        if resp.status_code not in (200, 204):
            return PostResult(
                success=False,
                channel=self.channel_name,
                error=f"HTTP {resp.status_code}: {resp.text[:200]}",
            )

        data: dict[str, Any] = resp.json() if resp.content else {}
        msg_id: str | None = data.get("id")
        channel_id: str | None = data.get("channel_id")
        guild_id: str | None = data.get("guild_id")

        url = (
            f"https://discord.com/channels/{guild_id}/{channel_id}/{msg_id}"
            if guild_id and channel_id and msg_id
            else None
        )
        return PostResult(
            success=True,
            channel=self.channel_name,
            message_id=msg_id,
            url=url,
        )

    def _build_embed(
        self,
        content: str,
        playbook: dict[str, Any] | None = None,
        title: str | None = None,
        tone: str = "",
    ) -> dict[str, Any]:
        color = _resolve_color(tone=tone, playbook=playbook)
        hashtags = _extract_hashtags(content)
        description = _strip_hashtags(content) if hashtags else content
        description = description[: self._MAX_EMBED_DESCRIPTION]

        embed: dict[str, Any] = {
            "description": description,
            "color": color,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "footer": {"text": f"{self._agent_name} · Powered by Talos Protocol"},
        }
        if title:
            embed["title"] = title[:256]

        fields: list[dict[str, Any]] = []

        if hashtags:
            fields.append(
                {"name": "Tags", "value": " ".join(hashtags[:20]), "inline": False}
            )

        cta = _extract_cta(playbook)
        if cta:
            fields.append({"name": "→", "value": cta[:1024], "inline": False})

        if fields:
            embed["fields"] = fields

        return embed


# ── Module-level utilities ──────────────────────────────────────────────────


def _resolve_color(tone: str = "", playbook: dict[str, Any] | None = None) -> int:
    """Pick an embed colour from an explicit tone hint or playbook metadata."""
    search_text = tone.lower()
    if playbook:
        search_text += " ".join(
            [
                str(playbook.get("toneVoice", "")),
                str(playbook.get("tone", "")),
                str(playbook.get("category", "")),
            ]
        ).lower()

    for keyword, color in _TONE_COLORS.items():
        if keyword in search_text:
            return color
    return _DEFAULT_COLOR


def _extract_hashtags(text: str) -> list[str]:
    return re.findall(r"#\w+", text)


def _strip_hashtags(text: str) -> str:
    return re.sub(r"\s*#\w+", "", text).strip()


def _extract_cta(playbook: dict[str, Any] | None) -> str | None:
    if not playbook:
        return None
    pb_content = (
        playbook.get("content", {}) if isinstance(playbook.get("content"), dict) else {}
    )
    tactics = pb_content.get("tactics") or playbook.get("tactics")
    if isinstance(tactics, list) and tactics:
        return str(tactics[0])
    if isinstance(tactics, str) and tactics:
        return tactics
    return None


def _parse_reference(reference_id: str) -> tuple[str | None, str | None]:
    """Extract (channel_id, message_id) from a slash-delimited ref or full URL."""
    # https://discord.com/channels/GUILD/CHANNEL/MESSAGE
    url_match = re.search(r"channels/\d+/(\d+)/(\d+)", reference_id)
    if url_match:
        return url_match.group(1), url_match.group(2)
    # channel_id/message_id
    parts = reference_id.split("/")
    if len(parts) == 2 and all(p.isdigit() for p in parts):
        return parts[0], parts[1]
    return None, None
