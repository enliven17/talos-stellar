"""Tests for the Telegram social publishing adapter."""

from __future__ import annotations

import json

import respx
import pytest

from talos_agent.adapters.telegram import TelegramAdapter
from talos_agent.config import Settings


@pytest.mark.asyncio
async def test_telegram_post_sends_message():
    settings = Settings()
    settings.channel_configs = {
        "telegram": {
            "bot_token": "fake-token",
            "chat_id": "@testchannel",
        }
    }
    adapter = TelegramAdapter(settings)

    with respx.mock as mock:
        endpoint = mock.post(
            "https://api.telegram.org/botfake-token/sendMessage"
        ).respond(
            status_code=200,
            json={"ok": True, "result": {"message_id": 123}},
        )

        result = await adapter.post("Hello Telegram")

    assert result.status == "posted"
    assert result.post_id == "123"
    assert endpoint.called
    assert result.content == "Hello Telegram"


@pytest.mark.asyncio
async def test_telegram_reply_sets_reply_to_message_id():
    settings = Settings()
    settings.channel_configs = {
        "telegram": {
            "bot_token": "fake-token",
            "chat_id": "@testchannel",
        }
    }
    adapter = TelegramAdapter(settings)

    with respx.mock as mock:
        endpoint = mock.post(
            "https://api.telegram.org/botfake-token/sendMessage"
        ).respond(
            status_code=200,
            json={"ok": True, "result": {"message_id": 456}},
        )

        result = await adapter.reply("https://t.me/testchannel/789", "Reply text")

    assert result.status == "posted"
    assert result.post_id == "456"
    assert endpoint.called
    request_payload = json.loads(endpoint.calls[0].request.content)
    assert request_payload["reply_to_message_id"] == 789
    assert request_payload["text"] == "Reply text"
