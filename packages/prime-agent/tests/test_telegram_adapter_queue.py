"""Tests for the rate-limit queue path of the Telegram adapter and its worker."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from talos_agent.adapters.capability import (
    _BUDGET,
    AdapterResourceLimits,
    CapabilityDeniedError,
    _InvocationBudget,
    default_manifests,
)
from talos_agent.adapters.registry import AdapterRegistry
from talos_agent.adapters.telegram import TelegramAdapter, TelegramAdapterConfig
from talos_agent.adapters.telegram_queue import (
    TelegramQueueConfig,
    TelegramQueueWorker,
    TelegramSendQueue,
)
from talos_agent.clock import FakeClock
from talos_agent.db import LocalDB

TOKEN = "123456:SECRET-token-value"
CHAT = "@testchannel"


class FakeSecrets:
    def get(self, name: str) -> str:
        return TOKEN


class FakeHTTP:
    """Dependency-free stand-in for the adapter HTTP client."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.calls: list[dict] = []
        self._responses = list(responses)

    async def get(self, url: str, **kwargs):  # pragma: no cover - never used
        raise AssertionError("unexpected GET")

    async def post(self, url: str, **kwargs):
        self.calls.append({"url": url, **kwargs})
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def ok(message_id: int = 1) -> httpx.Response:
    return httpx.Response(200, json={"ok": True, "result": {"message_id": message_id}})


def rate_limited(retry_after=7) -> httpx.Response:
    return httpx.Response(
        429,
        json={"ok": False, "error_code": 429, "description": f"Too Many Requests: {TOKEN}",
              "parameters": {"retry_after": retry_after}},
    )


class Env:
    def __init__(self, tmp_path: Path, *responses, **cfg) -> None:
        self.clock = FakeClock(datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc))
        self.db = LocalDB(path=tmp_path / "tg.db")
        cfg.setdefault("min_interval_seconds", 1.0)
        self.queue = TelegramSendQueue(self.db, TelegramQueueConfig(**cfg), clock=self.clock)
        self.http = FakeHTTP(*responses)
        self.adapter = TelegramAdapter(
            TelegramAdapterConfig(chat_id=CHAT),
            secrets=FakeSecrets(),
            http=self.http,
            queue=self.queue,
        )
        self.registry = AdapterRegistry()
        self.registry.register(self.adapter)
        self.worker = TelegramQueueWorker(self.queue, lambda: self.registry, idle_interval=0.05)

    def db_dump(self) -> str:
        rows = self.db._conn.execute("SELECT * FROM telegram_send_queue").fetchall()
        rate = self.db._conn.execute("SELECT * FROM telegram_rate_state").fetchall()
        return json.dumps([list(map(str, r)) for r in rows + rate])


def _assert_no_secret(env: Env, *results) -> None:
    blob = env.db_dump() + "".join(repr(r) for r in results)
    assert TOKEN not in blob and "SECRET" not in blob


# ── immediate path ────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_message_is_sent_inline_and_recorded(tmp_path):
    env = Env(tmp_path, ok(42))
    result = await env.adapter.post("Hello")
    assert result.status == "posted" and result.post_id == "42"
    assert result.url == "https://t.me/testchannel/42"
    call = env.http.calls[0]
    assert call["json"]["chat_id"] == CHAT and call["json"]["text"] == "Hello"
    assert TOKEN in call["url"]  # the token is only ever in the request URL
    row = env.queue.get(result.metadata["queue_id"])
    assert row.state == "sent" and row.message_id == 42
    _assert_no_secret(env, result)


@pytest.mark.asyncio
async def test_second_message_inside_interval_is_queued_without_http(tmp_path):
    env = Env(tmp_path, ok(1))
    await env.adapter.post("one")
    result = await env.adapter.post("two")
    assert result.status == "pending"
    assert result.metadata["queue_state"] == "pending"
    assert 0 < result.metadata["retry_in_seconds"] <= 1.0
    assert len(env.http.calls) == 1


@pytest.mark.asyncio
async def test_reply_carries_reply_to_message_id(tmp_path):
    env = Env(tmp_path, ok(9))
    result = await env.adapter.reply("https://t.me/testchannel/789", "answer")
    assert result.status == "posted"
    assert env.http.calls[0]["json"]["reply_to_message_id"] == 789


@pytest.mark.asyncio
async def test_reply_with_unparseable_target_sends_plain_message(tmp_path):
    env = Env(tmp_path, ok(9))
    result = await env.adapter.reply("not-a-url", "answer")
    assert result.status == "posted"
    assert "reply_to_message_id" not in env.http.calls[0]["json"]


@pytest.mark.asyncio
async def test_validation_and_configuration_errors_are_unchanged(tmp_path):
    env = Env(tmp_path)
    too_long = await env.adapter.post("x" * 4097)
    assert too_long.status == "failed" and "4096" in too_long.error
    empty = await env.adapter.post("   ")
    assert empty.status == "failed"
    assert env.http.calls == []


@pytest.mark.asyncio
async def test_operation_id_makes_submission_idempotent(tmp_path):
    env = Env(tmp_path, ok(5))
    first = await env.adapter.post("once", operation_id="op-1")
    again = await env.adapter.post("once", operation_id="op-1")
    assert first.status == "posted" and again.status == "posted"
    assert again.post_id == "5"
    assert len(env.http.calls) == 1


@pytest.mark.asyncio
async def test_operation_id_reused_for_other_content_is_rejected(tmp_path):
    env = Env(tmp_path, ok(5))
    await env.adapter.post("one", operation_id="op-1")
    result = await env.adapter.post("two", operation_id="op-1")
    assert result.status == "failed" and "rejected" in result.error


@pytest.mark.asyncio
async def test_full_queue_returns_explicit_error(tmp_path):
    env = Env(tmp_path, ok(1), max_queue_size=1)
    await env.adapter.post("sent")  # leaves the queue empty (sent rows do not count)
    await env.adapter.post("waits")  # pending inside the min interval
    result = await env.adapter.post("overflow")
    assert result.status == "failed"
    assert result.metadata == {"queue_full": True}
    assert "full" in result.error


# ── 429 handling ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_429_honours_retry_after_then_worker_delivers(tmp_path):
    env = Env(tmp_path, rate_limited(7), ok(3), min_interval_seconds=0)
    result = await env.adapter.post("later")
    assert result.status == "pending"
    assert result.metadata["retry_in_seconds"] == 7.0
    _assert_no_secret(env, result)

    env.clock.advance(6.9)
    report = await env.worker.drain_once()
    assert report.delivered == 0 and report.wait_seconds == pytest.approx(0.1, abs=1e-6)
    assert len(env.http.calls) == 1

    env.clock.advance(0.1)
    report = await env.worker.drain_once()
    assert report.delivered == 1
    assert env.queue.get(result.metadata["queue_id"]).state == "sent"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [None, 0, -3, "soon", True, "nan"])
async def test_429_with_missing_or_malformed_retry_after_falls_back_to_backoff(tmp_path, bad):
    response = rate_limited(bad)
    env = Env(tmp_path, response, min_interval_seconds=0, backoff_initial=2, backoff_max=8)
    result = await env.adapter.post("x")
    assert result.status == "pending"
    assert result.metadata["retry_in_seconds"] == 2.0


@pytest.mark.asyncio
async def test_429_retry_after_is_capped(tmp_path):
    env = Env(tmp_path, rate_limited(10**9), min_interval_seconds=0)
    result = await env.adapter.post("x")
    assert result.metadata["retry_in_seconds"] == 86400.0


@pytest.mark.asyncio
async def test_429_with_non_json_body_uses_retry_after_header(tmp_path):
    response = httpx.Response(429, content=b"<html>slow down</html>", headers={"Retry-After": "11"})
    env = Env(tmp_path, response, min_interval_seconds=0)
    result = await env.adapter.post("x")
    assert result.status == "pending" and result.metadata["retry_in_seconds"] == 11.0


@pytest.mark.asyncio
async def test_repeated_429_never_exhausts_attempts(tmp_path):
    env = Env(tmp_path, *[rate_limited(1) for _ in range(6)], ok(2), min_interval_seconds=0, max_attempts=2)
    result = await env.adapter.post("patient")
    for _ in range(5):
        env.clock.advance(1)
        await env.worker.drain_once()
    env.clock.advance(1)
    await env.worker.drain_once()
    assert env.queue.get(result.metadata["queue_id"]).state == "sent"


# ── dependency failures ───────────────────────────────────


@pytest.mark.asyncio
async def test_server_errors_retry_with_backoff_then_fail_privately(tmp_path):
    env = Env(tmp_path, *[httpx.Response(502, text=f"bad gateway {TOKEN}") for _ in range(2)],
              min_interval_seconds=0, max_attempts=2, backoff_initial=2, backoff_max=8)
    first = await env.adapter.post("x")
    assert first.status == "pending"
    env.clock.advance(1.9)
    assert (await env.worker.drain_once()).delivered == 0  # still backing off
    env.clock.advance(0.1)
    await env.worker.drain_once()
    row = env.queue.get(first.metadata["queue_id"])
    assert row.state == "failed" and row.last_error_code == "max_attempts"
    _assert_no_secret(env, first)


@pytest.mark.asyncio
async def test_permanent_4xx_fails_without_retry_and_hides_body(tmp_path):
    body = httpx.Response(400, json={"ok": False, "description": f"Bad Request {TOKEN}"})
    env = Env(tmp_path, body, min_interval_seconds=0)
    result = await env.adapter.post("x")
    assert result.status == "failed" and result.error == "Telegram send failed (http_400)"
    assert env.queue.get(result.metadata["queue_id"]).state == "failed"
    _assert_no_secret(env, result)


@pytest.mark.asyncio
async def test_200_with_ok_false_is_rejected(tmp_path):
    env = Env(tmp_path, httpx.Response(200, json={"ok": False, "description": "nope"}), min_interval_seconds=0)
    result = await env.adapter.post("x")
    assert result.status == "failed" and result.metadata["error_code"] == "rejected"


@pytest.mark.asyncio
async def test_connect_error_is_retried_safely(tmp_path):
    env = Env(tmp_path, httpx.ConnectError(f"cannot connect {TOKEN}"), ok(4),
              min_interval_seconds=0, backoff_initial=1)
    first = await env.adapter.post("x")
    assert first.status == "pending" and first.metadata["queue_state"] == "pending"
    env.clock.advance(1)
    assert (await env.worker.drain_once()).delivered == 1
    assert env.queue.get(first.metadata["queue_id"]).state == "sent"
    _assert_no_secret(env, first)


@pytest.mark.asyncio
async def test_ambiguous_transport_failure_is_never_resent(tmp_path):
    env = Env(tmp_path, httpx.ReadTimeout("timed out"), ok(8), min_interval_seconds=0)
    result = await env.adapter.post("maybe delivered")
    assert result.status == "failed" and result.metadata["queue_state"] == "indeterminate"
    env.clock.advance(3600)
    await env.worker.drain_once()
    assert len(env.http.calls) == 1  # no automatic second send
    assert env.queue.get(result.metadata["queue_id"]).state == "indeterminate"


@pytest.mark.asyncio
async def test_unreadable_200_body_is_indeterminate(tmp_path):
    env = Env(tmp_path, httpx.Response(200, content=b"<html>"), min_interval_seconds=0)
    result = await env.adapter.post("x")
    assert result.status == "failed" and result.metadata["queue_state"] == "indeterminate"


# ── worker ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_drains_backlog_in_order_at_paced_rate(tmp_path):
    env = Env(tmp_path, ok(1), ok(2), ok(3), ok(4))
    first = await env.adapter.post("m1")
    for text in ("m2", "m3", "m4"):
        assert (await env.adapter.post(text)).status == "pending"
    assert first.status == "posted"

    sent: list[str] = []
    for _ in range(3):
        env.clock.advance(1)
        report = await env.worker.drain_once()
        assert report.delivered == 1  # pacing releases exactly one message per second
        sent.append(env.http.calls[-1]["json"]["text"])
    assert sent == ["m2", "m3", "m4"]


@pytest.mark.asyncio
async def test_worker_does_not_claim_when_adapter_is_unavailable(tmp_path):
    env = Env(tmp_path, ok(1), ok(2), min_interval_seconds=1)
    await env.adapter.post("m1")
    queued = await env.adapter.post("m2")
    env.registry = AdapterRegistry()  # no telegram adapter registered
    env.clock.advance(5)
    report = await env.worker.drain_once()
    assert report.delivered == 0
    assert env.queue.get(queued.metadata["queue_id"]).state == "pending"


@pytest.mark.asyncio
async def test_worker_releases_row_after_pre_io_sandbox_denial(tmp_path):
    class DenyingAdapter(TelegramAdapter):
        async def post(self, content, **kwargs):
            raise CapabilityDeniedError("denied")

    env = Env(tmp_path, ok(1), min_interval_seconds=1)
    await env.adapter.post("m1")
    queued = await env.adapter.post("m2")
    denying = DenyingAdapter(TelegramAdapterConfig(chat_id=CHAT), secrets=FakeSecrets(), http=env.http, queue=env.queue)
    env.registry = AdapterRegistry()
    env.registry.register(denying)
    env.clock.advance(1)
    await env.worker.drain_once()
    row = env.queue.get(queued.metadata["queue_id"])
    assert row.state == "pending" and row.last_error_code == "delivery_denied"
    assert row.attempt_count == 1


@pytest.mark.asyncio
async def test_worker_leaves_ambiguous_failures_to_lease_expiry(tmp_path):
    class BrokenAdapter(TelegramAdapter):
        async def post(self, content, **kwargs):
            raise RuntimeError(f"boom {TOKEN}")

    env = Env(tmp_path, ok(1), min_interval_seconds=1, lease_seconds=30)
    await env.adapter.post("m1")
    queued = await env.adapter.post("m2")
    env.registry = AdapterRegistry()
    env.registry.register(BrokenAdapter(TelegramAdapterConfig(chat_id=CHAT), secrets=FakeSecrets(), http=env.http, queue=env.queue))
    env.clock.advance(1)
    await env.worker.drain_once()
    assert env.queue.get(queued.metadata["queue_id"]).state == "sending"
    env.clock.advance(30)
    env.queue.claim_next()
    assert env.queue.get(queued.metadata["queue_id"]).state == "indeterminate"


@pytest.mark.asyncio
async def test_forged_queue_item_ids_cannot_trigger_sends(tmp_path):
    env = Env(tmp_path, ok(1), min_interval_seconds=0)
    for bad in (True, "1", 99999, -1):
        result = await env.adapter.post("ignored", queue_item_id=bad)
        assert result.status == "failed"
    assert env.http.calls == []
    assert env.queue.stats()["counts"]["pending"] == 0


@pytest.mark.asyncio
async def test_worker_run_stops_promptly_on_shutdown(tmp_path):
    env = Env(tmp_path)
    shutdown = asyncio.Event()
    task = asyncio.create_task(env.worker.run(shutdown))
    await asyncio.sleep(0.02)
    shutdown.set()
    await asyncio.wait_for(task, timeout=1)


@pytest.mark.asyncio
async def test_worker_run_survives_a_failing_batch(tmp_path):
    env = Env(tmp_path)
    calls = 0

    async def flaky() -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("db exploded")

    env.worker.drain_once = flaky  # type: ignore[method-assign]
    shutdown = asyncio.Event()
    task = asyncio.create_task(env.worker.run(shutdown))
    await asyncio.sleep(0.2)
    shutdown.set()
    await asyncio.wait_for(task, timeout=1)
    assert calls >= 2


# ── sandbox interplay ─────────────────────────────────────


def _inside_sandbox_invocation(operation_id: str):
    manifest = default_manifests(AdapterResourceLimits())["telegram"]
    return _BUDGET.set(_InvocationBudget(manifest, "post", operation_id))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"ok": False}),
        httpx.ReadTimeout("timed out"),
        httpx.Response(200, content=b"<html>"),
    ],
)
async def test_sandbox_internal_retries_never_send_twice(tmp_path, response):
    """The sandbox re-invokes ``post`` on a failed result; that must not re-send."""
    env = Env(tmp_path, response, min_interval_seconds=0)
    token = _inside_sandbox_invocation("11111111-2222-3333-4444-555555555555")
    try:
        first = await env.adapter.post("once")
        retry = await env.adapter.post("once")  # what execute_with_retry would do
    finally:
        _BUDGET.reset(token)
    assert first.status == "failed" and retry.status == "failed"
    assert first.metadata["queue_id"] == retry.metadata["queue_id"]
    assert len(env.http.calls) == 1
    assert env.queue.stats()["counts"]["pending"] == 0


@pytest.mark.asyncio
async def test_distinct_sandbox_invocations_are_distinct_messages(tmp_path):
    env = Env(tmp_path, ok(1), ok(2), min_interval_seconds=0)
    for op, expected in (("aaaa-1", 1), ("aaaa-2", 2)):
        token = _inside_sandbox_invocation(op)
        try:
            result = await env.adapter.post(f"message {op}")
        finally:
            _BUDGET.reset(token)
        assert result.post_id == str(expected)
        env.clock.advance(1)


# ── regression: queue disabled keeps legacy behaviour ─────


@pytest.mark.asyncio
async def test_without_a_queue_429_is_still_a_plain_failure(tmp_path):
    http = FakeHTTP(rate_limited(7))
    adapter = TelegramAdapter(TelegramAdapterConfig(chat_id=CHAT), secrets=FakeSecrets(), http=http)
    result = await adapter.post("legacy")
    assert result.status == "failed" and "429" in result.error
    assert "queue_id" not in result.metadata


@pytest.mark.asyncio
async def test_without_a_queue_queue_item_id_kwarg_is_ignored(tmp_path):
    http = FakeHTTP(ok(1))
    adapter = TelegramAdapter(TelegramAdapterConfig(chat_id=CHAT), secrets=FakeSecrets(), http=http)
    result = await adapter.post("legacy", queue_item_id=1)
    assert result.status == "posted" and len(http.calls) == 1
