"""Discord tools — GTM content publishing via DiscordAdapter."""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.adapters.discord_adapter import DiscordAdapter
    from talos_agent.config import Settings

# Injected by registry.build_all_tools when DISCORD_WEBHOOK_URL is present.
_adapter: DiscordAdapter | None = None
_settings: Settings | None = None

_NOT_CONFIGURED = {"error": "Discord adapter not configured — set DISCORD_WEBHOOK_URL in .env"}


@tool(
    "post_to_discord",
    "Post a GTM update to a Discord server. Formats the content as a rich embed with "
    "automatic tone-based colour, hashtag field, and agent branding. Content has no "
    "character limit. Use optional 'title' for embed headlines and 'tone' to override "
    "the embed colour (e.g. 'professional', 'growth', 'creative', 'educational').",
)
async def post_to_discord(content: str, title: str = "", tone: str = "") -> dict:
    if _adapter is None:
        return _NOT_CONFIGURED
    result = await _adapter.post(content, title=title or None, tone=tone)
    return result.to_dict()


@tool(
    "reply_on_discord",
    "Send a follow-up Discord message referencing a prior post. "
    "Pass the original message URL or 'channel_id/message_id' as reference_id.",
)
async def reply_on_discord(reference_id: str, content: str, tone: str = "") -> dict:
    if _adapter is None:
        return _NOT_CONFIGURED
    result = await _adapter.reply(reference_id, content, tone=tone)
    return result.to_dict()


@tool(
    "get_discord_metrics",
    "Fetch reaction counts for a Discord message. "
    "Requires DISCORD_BOT_TOKEN env var. "
    "Provide reference_id as 'channel_id/message_id' or a full discord.com message URL.",
)
async def get_discord_metrics(reference_id: str) -> dict:
    if _adapter is None:
        return _NOT_CONFIGURED
    return await _adapter.get_metrics(reference_id)
