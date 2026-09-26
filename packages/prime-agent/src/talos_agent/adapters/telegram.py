"""Telegram publishing adapter using the Telegram Bot API."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.capability import (
    _BUDGET,
    AdapterHTTPClient,
    AdapterSandboxError,
    DirectHTTPClient,
    SecretProvider,
)
from talos_agent.adapters.snapshots import TelegramHealthSnapshot
from talos_agent.adapters.telegram_queue import (
    MAX_RETRY_AFTER_SECONDS,
    STATE_FAILED,
    STATE_INDETERMINATE,
    STATE_PENDING,
    STATE_SENDING,
    STATE_SENT,
    QueuedMessage,
    TelegramQueueError,
    TelegramQueueFullError,
    TelegramSendQueue,
)
from talos_agent.config import resolve_setting_secret

if TYPE_CHECKING:
    from talos_agent.config import Settings


_API_ROOT = "https://api.telegram.org"


@dataclass(frozen=True)
class TelegramAdapterConfig:
    chat_id: str = ""
    legacy_bot_token: str = ""


class TelegramAdapter(BaseSocialAdapter):
    channel_name = "Telegram"

    def __init__(
        self,
        config: Settings | TelegramAdapterConfig,
        *,
        secrets: SecretProvider | None = None,
        http: AdapterHTTPClient | None = None,
        queue: TelegramSendQueue | None = None,
    ) -> None:
        self._queue = queue
        self._settings: Settings | None
        if isinstance(config, TelegramAdapterConfig):
            self._settings = None
            self._legacy_bot_token = config.legacy_bot_token
            self._chat_id = config.chat_id
        else:
            self._settings = config
            telegram_config = getattr(config, "channel_configs", {}) or {}
            config_token = telegram_config.get("telegram", {}).get("bot_token", "")
            config_chat_id = telegram_config.get("telegram", {}).get("chat_id")
            self._legacy_bot_token = config_token or getattr(
                config, "telegram_bot_token", ""
            )
            self._chat_id = config_chat_id or getattr(config, "telegram_chat_id", "")
        self._secrets = secrets
        self._http = http or DirectHTTPClient()

    @property
    def _bot_token(self) -> str:
        if self._secrets is not None:
            return self._secrets.get("telegram_bot_token")
        assert self._settings is not None
        return resolve_setting_secret(
            self._settings, "telegram_bot_token", self._legacy_bot_token
        )

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

    def health_snapshot(self) -> TelegramHealthSnapshot:
        return TelegramHealthSnapshot(
            has_token=bool(self._bot_token),
            has_chat=bool(self._chat_id),
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
        response = await self._http.post(self._build_url("sendMessage"), json=payload)

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
        queue_item_id = kwargs.get("queue_item_id")
        if self._queue is not None and queue_item_id is not None:
            return await self._deliver_claimed(queue_item_id)
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

        if self._queue is not None:
            return await self._submit("post", content, None, self._operation_id(kwargs))

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
        if self._queue is not None:
            return await self._submit("reply", content, message_id, self._operation_id(kwargs))

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

    # ── Rate-limit queue path (only active when a queue is configured) ──

    @staticmethod
    def _operation_id(kwargs: dict[str, Any]) -> object:
        """Idempotency key for a submission.

        The sandbox strips ``operation_id`` before calling the adapter and may
        call ``post`` again when a result is ``failed``.  Falling back to the
        sandbox's in-flight operation ID makes those internal retries return
        the stored outcome instead of enqueueing (and sending) a second time.
        """
        explicit = kwargs.get("operation_id")
        if explicit is not None:
            return explicit
        budget = _BUDGET.get()
        return budget.operation_id if budget is not None else None

    def _queued_result(self, status: str, item: QueuedMessage | int, text: str, **extra: Any) -> PublishResult:
        item_id = item.id if isinstance(item, QueuedMessage) else item
        metadata: dict[str, Any] = {"queue_id": item_id, **extra}
        post_id = None
        url = None
        if status == "posted":
            message_id = extra.get("message_id")
            if message_id is not None:
                post_id = str(message_id)
                if isinstance(self._chat_id, str) and self._chat_id.startswith("@"):
                    url = f"https://t.me/{self._chat_id.lstrip('@')}/{message_id}"
        error = None
        if status == "failed":
            error = f"Telegram send failed ({extra.get('error_code', 'unknown')})"
        return PublishResult(
            status=status,
            channel=self.channel_name,
            content=text,
            post_id=post_id,
            url=url,
            error=error,
            metadata=metadata,
        )

    def _result_for_row(self, row: QueuedMessage) -> PublishResult:
        """Map a stored queue row to the result a caller would have seen."""
        if row.state == STATE_SENT:
            return self._queued_result("posted", row, row.text, message_id=row.message_id)
        if row.state in (STATE_FAILED, STATE_INDETERMINATE):
            return self._queued_result(
                "failed", row, row.text, error_code=row.last_error_code or row.state, queue_state=row.state
            )
        return self._queued_result("pending", row, row.text, queue_state=row.state)

    async def _submit(
        self,
        kind: str,
        content: str,
        reply_to_message_id: int | None,
        operation_id: object,
    ) -> PublishResult:
        assert self._queue is not None
        text = self._format_content(content)
        if not text:
            return PublishResult(
                status="failed", channel=self.channel_name, content=content, error="Content must not be empty."
            )
        dedupe_key = operation_id if isinstance(operation_id, str) and operation_id else None
        try:
            enqueued = self._queue.enqueue(
                chat_id=str(self._chat_id),
                kind=kind,
                text=text,
                reply_to_message_id=reply_to_message_id,
                dedupe_key=dedupe_key,
            )
        except TelegramQueueFullError:
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=text,
                error="Telegram send queue is full; retry later.",
                metadata={"queue_full": True},
            )
        except (TelegramQueueError, ValueError):
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=text,
                error="Telegram send queue rejected the message.",
            )
        if not enqueued.created:
            row = self._queue.get(enqueued.item_id)
            if row is not None:
                return self._result_for_row(row)
            return self._queued_result("pending", enqueued.item_id, text)
        try:
            claim = self._queue.claim_next(only_id=enqueued.item_id)
        except TelegramQueueError:
            return self._queued_result("pending", enqueued.item_id, text, queue_state=STATE_PENDING)
        if claim.item is None:
            extra: dict[str, Any] = {"queue_state": STATE_PENDING}
            if claim.wait_seconds is not None:
                extra["retry_in_seconds"] = round(claim.wait_seconds, 3)
            return self._queued_result("pending", enqueued.item_id, text, **extra)
        return await self._deliver(claim.item)

    async def _deliver_claimed(self, queue_item_id: object) -> PublishResult:
        """Send a message the worker has already claimed (lease held)."""
        assert self._queue is not None
        if isinstance(queue_item_id, bool) or not isinstance(queue_item_id, int):
            return PublishResult(
                status="failed", channel=self.channel_name, content="", error="Invalid queue item."
            )
        row = self._queue.get(queue_item_id)
        if row is None:
            return PublishResult(
                status="failed", channel=self.channel_name, content="", error="Queue item not found."
            )
        if row.state != STATE_SENDING:
            # Already resolved (e.g. a sandbox retry after a terminal result).
            return self._result_for_row(row)
        return await self._deliver(row)

    async def _deliver(self, item: QueuedMessage) -> PublishResult:
        """Send one claimed row and record the outcome. Never re-sends on doubt."""
        assert self._queue is not None
        queue = self._queue
        if not self._is_configured():
            state = queue.mark_retry(item.id, queue.backoff_delay(item.attempt_count), "not_configured")
            return self._queued_result(
                "failed" if state == STATE_FAILED else "pending",
                item,
                item.text,
                error_code="not_configured",
                queue_state=state,
            )
        payload: dict[str, Any] = {
            "chat_id": item.chat_id,
            "text": item.text,
            "disable_web_page_preview": True,
            "disable_notification": False,
        }
        if item.reply_to_message_id is not None:
            payload["reply_to_message_id"] = item.reply_to_message_id
        try:
            response = await self._http.post(self._build_url("sendMessage"), json=payload)
        except AdapterSandboxError:
            # Denied or over budget before any request left the process: safe to retry.
            queue.mark_retry(item.id, queue.backoff_delay(item.attempt_count), "sandbox_denied")
            raise
        except (httpx.ConnectError, httpx.ConnectTimeout):
            # The request never reached Telegram: safe to retry with backoff.
            state = queue.mark_retry(item.id, queue.backoff_delay(item.attempt_count), "connect_error")
            return self._queued_result(
                "failed" if state == STATE_FAILED else "pending", item, item.text,
                error_code="connect_error", queue_state=state,
            )
        except Exception:
            # Outcome unknown (the message may have been delivered); never auto-resend.
            queue.mark_indeterminate(item.id, "transport_error")
            return self._queued_result(
                "failed", item, item.text, error_code="transport_error", queue_state=STATE_INDETERMINATE
            )

        status = response.status_code
        body = self._json_body(response)
        if status == 200:
            if body is None:
                queue.mark_indeterminate(item.id, "malformed_response")
                return self._queued_result(
                    "failed", item, item.text, error_code="malformed_response", queue_state=STATE_INDETERMINATE
                )
            if body.get("ok") is True:
                result = body.get("result")
                raw_id = result.get("message_id") if isinstance(result, dict) else None
                message_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else None
                queue.mark_sent(item.id, message_id)
                return self._queued_result("posted", item, item.text, message_id=message_id)
            queue.mark_failed(item.id, "rejected")
            return self._queued_result("failed", item, item.text, error_code="rejected", queue_state=STATE_FAILED)
        if status == 429:
            delay = self._retry_after(body, response) or queue.backoff_delay(item.attempt_count)
            queue.block_chat(item.chat_id, delay)
            queue.mark_retry(item.id, delay, "rate_limited", consume_attempt=False)
            return self._queued_result(
                "pending", item, item.text, queue_state=STATE_PENDING, retry_in_seconds=round(delay, 3)
            )
        if status >= 500:
            state = queue.mark_retry(item.id, queue.backoff_delay(item.attempt_count), "server_error")
            return self._queued_result(
                "failed" if state == STATE_FAILED else "pending", item, item.text,
                error_code="server_error", queue_state=state,
            )
        code = f"http_{status}"
        queue.mark_failed(item.id, code)
        return self._queued_result("failed", item, item.text, error_code=code, queue_state=STATE_FAILED)

    @staticmethod
    def _json_body(response: Any) -> dict | None:
        try:
            body = response.json()
        except Exception:
            return None
        return body if isinstance(body, dict) else None

    @staticmethod
    def _retry_after(body: dict | None, response: Any) -> float | None:
        """Extract a usable retry delay from a 429; ``None`` means fall back to backoff."""
        candidates: list[object] = []
        if body is not None:
            params = body.get("parameters")
            if isinstance(params, dict):
                candidates.append(params.get("retry_after"))
        try:
            candidates.append(response.headers.get("Retry-After"))
        except Exception:
            pass
        for value in candidates:
            if isinstance(value, bool):
                continue
            try:
                seconds = float(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if seconds == seconds and seconds > 0:  # excludes NaN, zero and negatives
                return min(seconds, MAX_RETRY_AFTER_SECONDS)
        return None
