"""Focused coverage for durable publication intent records (#1458)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import pytest

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.diagnostics import reconcile_pending_intents
from talos_agent.adapters.publication_intent import (
    PublicationIntent,
    PublicationIntentStatus,
    PublicationIntentStore,
    payload_hash,
)
from talos_agent.adapters.registry import AdapterRegistry


@dataclass
class _FakeResult:
    status: str
    error: str | None = None


class _FakeAdapter(BaseSocialAdapter):
    """Minimal adapter that returns whatever the test tells it to."""

    channel_name = "fake"

    def __init__(self, next_status: str = "success", raise_exc: Exception | None = None):
        self.next_status = next_status
        self.raise_exc = raise_exc
        self.calls: list[str] = []

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities()

    async def post(self, content: str, **kwargs):
        self.calls.append(content)
        if self.raise_exc is not None:
            raise self.raise_exc
        return _FakeResult(status=self.next_status)

    async def reply(self, target_url: str, content: str, **kwargs):
        return await self.post(content, **kwargs)


def _store(tmp_path: Path) -> PublicationIntentStore:
    return PublicationIntentStore(tmp_path / "intents")


def test_intent_is_written_pending_before_publish_and_confirmed_after(tmp_path: Path):
    store = _store(tmp_path)
    adapter = _FakeAdapter(next_status="success")
    registry = AdapterRegistry(intent_store=store)
    registry.register(adapter)

    result = asyncio.run(registry.publish("fake", "hello world"))
    assert result.status == "success"

    action_id = f"fake:{payload_hash('hello world')}"
    intent = store.read(action_id)
    assert intent is not None
    assert intent.status is PublicationIntentStatus.CONFIRMED
    assert intent.adapter == "fake"
    assert intent.resolved_at is not None


def test_crash_mid_publish_leaves_pending_record(tmp_path: Path):
    store = _store(tmp_path)
    adapter = _FakeAdapter(raise_exc=RuntimeError("transport died"))
    registry = AdapterRegistry(intent_store=store)
    registry.register(adapter)

    with pytest.raises(RuntimeError):
        asyncio.run(registry.publish("fake", "boom"))

    action_id = f"fake:{payload_hash('boom')}"
    intent = store.read(action_id)
    assert intent is not None
    assert intent.status is PublicationIntentStatus.PENDING
    assert intent.resolved_at is None


def test_rejected_outcome_is_persisted(tmp_path: Path):
    store = _store(tmp_path)
    adapter = _FakeAdapter(next_status="failed")
    registry = AdapterRegistry(intent_store=store)
    registry.register(adapter)

    asyncio.run(registry.publish("fake", "rejected"))
    intent = store.read(f"fake:{payload_hash('rejected')}")
    assert intent is not None
    assert intent.status is PublicationIntentStatus.REJECTED
    assert intent.last_error is not None


def test_reconcile_confirms_and_rejects_pending_intents(tmp_path: Path):
    store = _store(tmp_path)
    a = PublicationIntent(
        action_id="fake:a",
        adapter="fake",
        payload_hash="h-a",
        created_at="2026-01-01T00:00:00+00:00",
    )
    b = PublicationIntent(
        action_id="fake:b",
        adapter="fake",
        payload_hash="h-b",
        created_at="2026-01-01T00:00:00+00:00",
    )
    store.write(a)
    store.write(b)

    def lookup(action_id: str) -> str | None:
        if action_id == "fake:a":
            return "confirmed"
        if action_id == "fake:b":
            return "rejected"
        return None

    counts = reconcile_pending_intents(
        intent_store=store,
        transport_lookup=lookup,
        now_iso="2026-01-01T00:01:00+00:00",
    )
    assert counts == {"confirmed": 1, "rejected": 1, "unknown": 0, "still_pending": 0}
    assert store.read("fake:a").status is PublicationIntentStatus.CONFIRMED
    assert store.read("fake:b").status is PublicationIntentStatus.REJECTED


def test_reconcile_marks_unknown_past_window_and_holds(tmp_path: Path):
    store = _store(tmp_path)
    intent = PublicationIntent(
        action_id="fake:stuck",
        adapter="fake",
        payload_hash="h",
        created_at="2026-01-01T00:00:00+00:00",
    )
    store.write(intent)

    counts = reconcile_pending_intents(
        intent_store=store,
        transport_lookup=lambda _aid: None,
        now_iso="2026-01-01T01:00:00+00:00",  # 60 minutes after creation
        max_age_seconds=15 * 60,
    )
    assert counts["unknown"] == 1
    held = store.read("fake:stuck")
    assert held is not None
    assert held.status is PublicationIntentStatus.UNKNOWN
    # Held forever: a second reconcile call does not touch it.
    counts2 = reconcile_pending_intents(
        intent_store=store,
        transport_lookup=lambda _aid: None,
        now_iso="2026-01-02T00:00:00+00:00",
    )
    assert counts2 == {"confirmed": 0, "rejected": 0, "unknown": 0, "still_pending": 0}


def test_reconcile_leaves_recent_unanswered_intents_still_pending(tmp_path: Path):
    store = _store(tmp_path)
    intent = PublicationIntent(
        action_id="fake:fresh",
        adapter="fake",
        payload_hash="h",
        created_at="2026-01-01T00:00:00+00:00",
    )
    store.write(intent)

    counts = reconcile_pending_intents(
        intent_store=store,
        transport_lookup=lambda _aid: None,
        now_iso="2026-01-01T00:05:00+00:00",
        max_age_seconds=15 * 60,
    )
    assert counts["still_pending"] == 1
    assert store.read("fake:fresh").status is PublicationIntentStatus.PENDING


def test_existing_publish_path_is_unchanged_without_a_store(tmp_path: Path):
    adapter = _FakeAdapter(next_status="success")
    registry = AdapterRegistry()  # no store
    registry.register(adapter)
    result = asyncio.run(registry.publish("fake", "no store"))
    assert result.status == "success"
    assert adapter.calls == ["no store"]
