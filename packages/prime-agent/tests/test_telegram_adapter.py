"""Tests for the Telegram social publishing adapter."""

from __future__ import annotations

import json

import httpx
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
    assert "parse_mode" not in json.loads(endpoint.calls[0].request.content)


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


@pytest.mark.asyncio
async def test_telegram_html_mode_escapes_message_text():
    settings = Settings(telegram_parse_mode="HTML")
    settings.channel_configs = {
        "telegram": {"bot_token": "fake-token", "chat_id": "@testchannel"}
    }
    adapter = TelegramAdapter(settings)

    with respx.mock as mock:
        endpoint = mock.post(
            "https://api.telegram.org/botfake-token/sendMessage"
        ).respond(status_code=200, json={"ok": True, "result": {"message_id": 1}})
        result = await adapter.post(
            '<b>Tom & Jerry</b> <a href="javascript:alert(1)">click</a>'
        )

    assert result.status == "posted"
    payload = json.loads(endpoint.calls[0].request.content)
    assert payload["parse_mode"] == "HTML"
    assert payload["text"] == "<b>Tom &amp; Jerry</b> click"


@pytest.mark.asyncio
async def test_telegram_markdown_v2_mode_escapes_reserved_characters():
    settings = Settings(telegram_parse_mode="MarkdownV2")
    settings.channel_configs = {
        "telegram": {"bot_token": "fake-token", "chat_id": "@testchannel"}
    }
    adapter = TelegramAdapter(settings)

    with respx.mock as mock:
        endpoint = mock.post(
            "https://api.telegram.org/botfake-token/sendMessage"
        ).respond(status_code=200, json={"ok": True, "result": {"message_id": 2}})
        result = await adapter.post(
            "*bold* hello_world! (100%) [site](https://example.com)"
        )

    assert result.status == "posted"
    payload = json.loads(endpoint.calls[0].request.content)
    assert payload["parse_mode"] == "MarkdownV2"
    assert payload["text"] == r"*bold* hello\_world\! \(100%\) [site](https://example.com)"


@pytest.mark.asyncio
async def test_telegram_retries_plain_text_when_parse_mode_is_rejected():
    settings = Settings(telegram_parse_mode="HTML")
    settings.channel_configs = {
        "telegram": {"bot_token": "fake-token", "chat_id": "@testchannel"}
    }
    adapter = TelegramAdapter(settings)

    with respx.mock as mock:
        endpoint = mock.post("https://api.telegram.org/botfake-token/sendMessage")
        endpoint.side_effect = [
            httpx.Response(
                400, json={"ok": False, "description": "Bad Request: can't parse entities"}
            ),
            httpx.Response(
                200, json={"ok": True, "result": {"message_id": 3}}
            ),
        ]
        result = await adapter.post("<b>unclosed")

    assert result.status == "posted"
    first, second = [json.loads(call.request.content) for call in endpoint.calls]
    assert first["parse_mode"] == "HTML"
    assert "parse_mode" not in second
    assert second["text"] == "<b>unclosed"


def test_telegram_character_limit_counts_escaped_text():
    settings = Settings(telegram_parse_mode="HTML")
    adapter = TelegramAdapter(settings)

    valid, error = adapter._validate_formatted_content("&" * 2049)

    assert not valid
    assert "after Telegram escaping" in error
