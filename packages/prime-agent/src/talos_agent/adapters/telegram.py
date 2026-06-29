"""Telegram publishing adapter using the Telegram Bot API."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

import httpx

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult

if TYPE_CHECKING:
    from talos_agent.config import Settings


_API_ROOT = "https://api.telegram.org"


class TelegramAdapter(BaseSocialAdapter):
    channel_name = "Telegram"

    def __init__(self, settings: "Settings") -> None:
        self._settings = settings
        telegram_config = getattr(settings, "channel_configs", {}) or {}
        config_token = telegram_config.get("telegram", {}).get("bot_token")
        config_chat_id = telegram_config.get("telegram", {}).get("chat_id")
        self._bot_token = config_token or getattr(settings, "telegram_bot_token", "")
        self._chat_id = config_chat_id or getattr(settings, "telegram_chat_id", "")

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            char_limit=4096,
            supports_media=False,
            supports_threads=False,
            supports_replies=True,
            supports_search=False,
            supports_mentions=False,
            supports_analytics=False,
        )

    def _is_configured(self) -> bool:
        return bool(self._bot_token and self._chat_id)

    def _build_url(self, method: str) -> str:
        return f"{_API_ROOT}/bot{self._bot_token}/{method}"

    def _format_content(self, content: str) -> str:
        text = content.strip()
        text = re.sub(r"\r\n|\r", "\n", text)
        return text

    async def _send(self, payload: dict) -> PublishResult:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(self._build_url("sendMessage"), json=payload)

        if response.status_code != 200:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=payload.get("text", ""),
                error=f"Telegram API error {response.status_code}: {response.text}",
            )

        data = response.json()
        if not data.get("ok"):
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=payload.get("text", ""),
                error=f"Telegram API error: {data.get('description')}",
            )

        result = data.get("result", {})
        message_id = result.get("message_id")
        url = None
        if isinstance(self._chat_id, str) and self._chat_id.startswith("@") and message_id is not None:
            username = self._chat_id.lstrip("@")
            url = f"https://t.me/{username}/{message_id}"

        return PublishResult(
            status="posted",
            channel=self.channel_name,
            content=payload.get("text", ""),
            post_id=str(message_id) if message_id is not None else None,
            url=url,
            metadata={"message_id": message_id},
        )

    async def post(self, content: str, **kwargs) -> PublishResult:
        if not self._is_configured():
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error="Telegram adapter is not configured. Set telegram_bot_token and telegram_chat_id.",
            )

        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(status="failed", channel=self.channel_name, content=content, error=error)

        payload = {
            "chat_id": self._chat_id,
            "text": self._format_content(content),
            "disable_web_page_preview": True,
            "disable_notification": False,
        }
        return await self._send(payload)

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        if not self._is_configured():
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error="Telegram adapter is not configured. Set telegram_bot_token and telegram_chat_id.",
            )

        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(status="failed", channel=self.channel_name, content=content, error=error)

        message_id = self._parse_message_id(target_url)
        payload = {
            "chat_id": self._chat_id,
            "text": self._format_content(content),
            "reply_to_message_id": message_id,
            "disable_web_page_preview": True,
            "disable_notification": False,
        }
        return await self._send(payload)

    async def get_mentions(self, **kwargs) -> list[dict]:
        return []

    async def search(self, query: str, **kwargs) -> list[dict]:
        return []

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        return {"error": "Telegram analytics are not supported by this adapter."}

    async def get_profile_stats(self, **kwargs) -> dict:
        return {"error": "Telegram profile stats are not supported by this adapter."}

    def _parse_message_id(self, target_url: str) -> int | None:
        match = re.search(r"/(\d+)(?:\D.*)?$", target_url)
        if match:
            return int(match.group(1))
        return None
