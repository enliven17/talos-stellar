"""Focused tests for #1464: write operations require a stable idempotency identity."""

from __future__ import annotations

import sqlite3

import pytest

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.capability import (
    AdapterCapabilityManifest,
    AdapterResourceLimits,
    AdapterSandbox,
    DuplicateInvocationError,
    InvocationConflictError,
)


class _FakeAdapter(BaseSocialAdapter):
    channel_name = "fake"

    def __init__(self) -> None:
        self.post_calls = 0
        self.reply_calls = 0

    async def post(self, content: str, **kwargs) -> PublishResult:
        self.post_calls += 1
        return PublishResult(status="posted", channel="fake", content=content, post_id="p1")

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        self.reply_calls += 1
        return PublishResult(status="posted", channel="fake", content=content, post_id="r1")

    async def get_mentions(self, **kwargs) -> list[dict]:
        return []

    async def search(self, query: str, **kwargs) -> list[dict]:
        return []

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        return {}

    async def get_profile_stats(self, **kwargs) -> dict:
        return {}

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(char_limit=None)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE adapter_invocations (
            operation_id TEXT PRIMARY KEY,
            adapter_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            state TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    return conn


class _DB:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn


def _sandbox(conn: sqlite3.Connection) -> AdapterSandbox:
    manifest = AdapterCapabilityManifest(
        adapter_id="fake",
        operations=frozenset({"post", "reply", "get_mentions", "search"}),
        limits=AdapterResourceLimits(timeout_seconds=5.0),
    )
    return AdapterSandbox(
        manifests={"fake": manifest},
        db=_DB(conn),
        secret_resolver=lambda name: "x",
    )


@pytest.mark.asyncio
async def test_write_without_operation_id_is_rejected_before_dispatch():
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    with pytest.raises(InvocationConflictError, match="operation_id is required"):
        await adapter.post("hello")

    # Transport was never called — the guard ran before dispatch.
    assert inner.post_calls == 0
    # No invocation record was created either.
    assert conn.execute("SELECT COUNT(*) FROM adapter_invocations").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_reply_without_operation_id_is_rejected_before_dispatch():
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    with pytest.raises(InvocationConflictError, match="operation_id is required"):
        await adapter.reply("https://example.com/x", "hi")

    assert inner.reply_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_id", ["", "   ", "bad id with spaces", " leading-space"])
async def test_blank_or_malformed_operation_id_is_rejected(bad_id):
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    with pytest.raises(InvocationConflictError):
        await adapter.post("hello", operation_id=bad_id)

    assert inner.post_calls == 0


@pytest.mark.asyncio
async def test_write_with_valid_operation_id_dispatches_once():
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    result = await adapter.post("hello", operation_id="op-abc-123")
    assert result.status == "posted"
    assert result.metadata["operation_id"] == "op-abc-123"
    assert inner.post_calls == 1


@pytest.mark.asyncio
async def test_retry_with_same_operation_id_is_deduplicated():
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    await adapter.post("hello", operation_id="op-retry-1")
    # Same id, same input -> AdapterInvocationStore raises DuplicateInvocationError
    # (a subclass of AdapterSandboxError) before the transport is called again.
    with pytest.raises(DuplicateInvocationError):
        await adapter.post("hello", operation_id="op-retry-1")

    assert inner.post_calls == 1


@pytest.mark.asyncio
async def test_read_operation_does_not_require_operation_id():
    """Boundary: read/dry-run paths must remain available without publishing."""
    conn = _db()
    inner = _FakeAdapter()
    adapter = _sandbox(conn).wrap(inner)

    assert await adapter.get_mentions() == []
    assert await adapter.search("anything") == []
    # No invocation record created for reads.
    assert conn.execute("SELECT COUNT(*) FROM adapter_invocations").fetchone()[0] == 0
