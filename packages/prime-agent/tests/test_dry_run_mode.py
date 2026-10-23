"""Integration-style tests for TALOS_DRY_RUN mode (Issue #976).

Verifies that:
- No outbound write requests occur in dry-run (mocked transports assert this).
- Read calls still work normally.
- Suppressed effects are recorded and listable after a cycle.
- Inconsistent flags (production key, durable job effects) cause startup rejection.
- Wrapper proxies forward non-write attributes to the real object transparently.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from talos_agent.dry_run import (
    DryRunConflictError,
    DryRunRecorder,
    SuppressedEffect,
    check_dry_run_conflicts,
    wrap_api_client,
    wrap_social_adapter,
    wrap_stellar_kit,
)
from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_settings(
    dry_run: bool = True,
    api_key: str = "cpk_test_key",
    durable_job_effects: bool = False,
    allow_prod_keys: bool = False,
) -> MagicMock:
    s = MagicMock()
    s.dry_run = dry_run
    s.talos_api_key = api_key
    s.talos_durable_job_effects_enabled = durable_job_effects
    s.dry_run_allow_production_keys = allow_prod_keys
    return s


def _make_api_client() -> AsyncMock:
    api = AsyncMock()
    api.request_transfer = AsyncMock(return_value={"status": "ok", "tx_hash": "abc"})
    api.create_approval = AsyncMock(return_value={"id": "appr-001"})
    api.submit_commerce = AsyncMock(return_value={"status": "ok"})
    api.register_service = AsyncMock(return_value={"status": "ok"})
    api.log_activity = AsyncMock(return_value={"id": "act-001"})
    api.report_revenue = AsyncMock(return_value={"status": "ok"})
    api.update_status = AsyncMock(return_value=None)
    api.submit_job_result = AsyncMock(return_value={"status": "ok"})
    api.create_agent_wallet = AsyncMock(return_value={"walletId": "wallet-001"})
    api.claim_job = AsyncMock(return_value={"fencingToken": 42})
    api.release_job = AsyncMock(return_value={"status": "ok"})
    api.heartbeat_job = AsyncMock(return_value={"status": "ok"})
    # Read methods
    api.get_talos = AsyncMock(return_value={"id": "test-talos"})
    api.get_approvals = AsyncMock(return_value=[])
    api.get_pending_jobs = AsyncMock(return_value=[])
    return api


class _FakeSocialAdapter(BaseSocialAdapter):
    channel_name = "test_channel"

    async def post(self, content: str, **kwargs) -> PublishResult:
        return PublishResult(status="posted", channel=self.channel_name, content=content, post_id="p1")

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        return PublishResult(status="posted", channel=self.channel_name, content=content, post_id="r1")

    async def get_mentions(self, **kwargs) -> list[dict]:
        return []

    async def search(self, query: str, **kwargs) -> list[dict]:
        return []

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        return {}

    async def get_profile_stats(self, **kwargs) -> dict:
        return {"followers": 0}

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(char_limit=280)


# ── DryRunRecorder tests ──────────────────────────────────────────────────────


class TestDryRunRecorder:

    def test_initially_empty(self):
        recorder = DryRunRecorder()
        assert recorder.effects == []

    def test_record_adds_effect(self):
        recorder = DryRunRecorder()
        recorder.record("api_client", "request_transfer", {"to_account": "G123", "amount": 10})
        assert len(recorder.effects) == 1
        eff = recorder.effects[0]
        assert isinstance(eff, SuppressedEffect)
        assert eff.layer == "api_client"
        assert eff.method == "request_transfer"

    def test_record_redacts_sensitive_keys(self):
        recorder = DryRunRecorder()
        recorder.record("api_client", "some_write", {"api_key": "sk-secret", "amount": 50})
        eff = recorder.effects[0]
        # api_key should be redacted
        assert eff.redacted_args.get("api_key") != "sk-secret"

    def test_to_status_dict(self):
        recorder = DryRunRecorder()
        recorder.record("api_client", "request_transfer", {"to": "G123", "amount": 5})
        status = recorder.to_status_dict()
        assert status["dry_run"] is True
        assert status["suppressed_effect_count"] == 1
        assert len(status["suppressed_effects"]) == 1

    def test_effects_returns_copy(self):
        """effects property must return a copy, not the internal list."""
        recorder = DryRunRecorder()
        effects = recorder.effects
        effects.append(MagicMock())  # mutate the copy
        assert len(recorder.effects) == 0  # original must be unchanged


# ── wrap_api_client tests ─────────────────────────────────────────────────────


class TestWrapAPIClient:

    @pytest.mark.asyncio
    async def test_write_method_is_intercepted(self):
        api = _make_api_client()
        recorder = DryRunRecorder()
        proxy = wrap_api_client(api, recorder)

        result = await proxy.request_transfer(to_account="G123", amount=100)

        # Real client must NOT be called
        api.request_transfer.assert_not_called()
        # Synthetic response returned
        assert result is not None
        assert result["status"] == "dry_run"
        # Effect recorded
        assert len(recorder.effects) == 1
        assert recorder.effects[0].method == "request_transfer"

    @pytest.mark.asyncio
    async def test_all_write_methods_suppressed(self):
        """Every listed write method is suppressed; real client is never called."""
        api = _make_api_client()
        recorder = DryRunRecorder()
        proxy = wrap_api_client(api, recorder)

        write_calls = [
            ("request_transfer", {"to_account": "G123", "amount": 1}),
            ("create_approval", {"talos_id": "t1", "type_": "tx", "title": "T"}),
            ("submit_commerce", {"talos_id": "t1", "payment_header": "x", "payload": {}}),
            ("register_service", {"talos_id": "t1", "service_name": "s", "description": "d", "price": 1.0}),
            ("log_activity", {"talos_id": "t1", "type_": "post", "content": "hi", "channel": "X"}),
            ("report_revenue", {"talos_id": "t1", "amount": 1.0, "source": "s"}),
            ("update_status", {"talos_id": "t1", "online": True}),
            ("submit_job_result", {"job_id": "j1", "result": {}}),
            ("create_agent_wallet", {}),
            ("claim_job", {"job_id": "j1", "ttl_seconds": 30}),
            ("release_job", {"job_id": "j1", "fencing_token": 1}),
            ("heartbeat_job", {"job_id": "j1", "fencing_token": 1}),
        ]

        for method, kwargs in write_calls:
            fn = getattr(proxy, method)
            await fn(**kwargs)

        # None of the real write methods should have been called
        for method, _ in write_calls:
            real_fn = getattr(api, method)
            real_fn.assert_not_called()

        assert len(recorder.effects) == len(write_calls)

    @pytest.mark.asyncio
    async def test_read_method_is_forwarded(self):
        """Read methods (get_*) must be forwarded to the real client."""
        api = _make_api_client()
        recorder = DryRunRecorder()
        proxy = wrap_api_client(api, recorder)

        result = await proxy.get_approvals("test-talos")

        api.get_approvals.assert_called_once_with("test-talos")
        assert result == []
        # No effects recorded for reads
        assert len(recorder.effects) == 0

    @pytest.mark.asyncio
    async def test_multiple_write_calls_each_recorded(self):
        api = _make_api_client()
        recorder = DryRunRecorder()
        proxy = wrap_api_client(api, recorder)

        await proxy.request_transfer(to_account="G1", amount=5)
        await proxy.request_transfer(to_account="G2", amount=10)

        assert len(recorder.effects) == 2
        assert recorder.effects[0].redacted_args["to_account"] == "G1"
        assert recorder.effects[1].redacted_args["to_account"] == "G2"


# ── wrap_social_adapter tests ─────────────────────────────────────────────────


class TestWrapSocialAdapter:

    @pytest.mark.asyncio
    async def test_post_is_suppressed(self):
        adapter = _FakeSocialAdapter()
        recorder = DryRunRecorder()
        proxy = wrap_social_adapter(adapter, recorder)

        result = await proxy.post("Hello world")

        assert result.status == "dry_run"
        assert result.post_id == "dry-run-post-id"
        assert len(recorder.effects) == 1
        assert "post" in recorder.effects[0].method

    @pytest.mark.asyncio
    async def test_reply_is_suppressed(self):
        adapter = _FakeSocialAdapter()
        recorder = DryRunRecorder()
        proxy = wrap_social_adapter(adapter, recorder)

        result = await proxy.reply("https://example.com/p/1", "A reply")

        assert result.status == "dry_run"
        assert len(recorder.effects) == 1
        assert "reply" in recorder.effects[0].method

    @pytest.mark.asyncio
    async def test_read_method_forwarded(self):
        """get_mentions must be forwarded to the real adapter."""
        adapter = _FakeSocialAdapter()
        recorder = DryRunRecorder()
        proxy = wrap_social_adapter(adapter, recorder)

        result = await proxy.get_mentions()

        assert result == []
        assert len(recorder.effects) == 0


# ── wrap_stellar_kit tests ────────────────────────────────────────────────────


class TestWrapStellarKit:

    @pytest.mark.asyncio
    async def test_transfer_xlm_suppressed(self):
        real_kit = AsyncMock()
        real_kit.transfer_xlm = AsyncMock(return_value={"status": "ok"})
        real_kit.get_balance = AsyncMock(return_value={"balance_xlm": "100"})

        recorder = DryRunRecorder()
        proxy = wrap_stellar_kit(real_kit, recorder)

        result = await proxy.transfer_xlm("GABC123", 50)

        real_kit.transfer_xlm.assert_not_called()
        assert result["status"] == "dry_run"
        assert len(recorder.effects) == 1
        assert recorder.effects[0].method == "transfer_xlm"

    @pytest.mark.asyncio
    async def test_read_method_forwarded(self):
        real_kit = AsyncMock()
        real_kit.get_balance = AsyncMock(return_value={"balance_xlm": "100"})

        recorder = DryRunRecorder()
        proxy = wrap_stellar_kit(real_kit, recorder)

        result = await proxy.get_balance()

        real_kit.get_balance.assert_called_once()
        assert result == {"balance_xlm": "100"}
        assert len(recorder.effects) == 0


# ── check_dry_run_conflicts tests ─────────────────────────────────────────────


class TestCheckDryRunConflicts:

    def test_no_dry_run_no_conflict(self):
        """When dry_run=False, no conflict check is performed."""
        settings = _make_settings(dry_run=False, api_key="tls_production_key")
        # Must not raise
        check_dry_run_conflicts(settings)

    def test_dry_run_with_production_key_raises(self):
        """Production key (tls_ prefix) + dry_run must raise DryRunConflictError."""
        settings = _make_settings(dry_run=True, api_key="tls_production_key")
        with pytest.raises(DryRunConflictError, match="production API key"):
            check_dry_run_conflicts(settings)

    def test_dry_run_with_non_production_key_ok(self):
        """Non-production keys (cpk_, tak_, sk-test etc.) must not conflict."""
        for key in ("cpk_test_key", "tak_aaa", "sk-test", ""):
            settings = _make_settings(dry_run=True, api_key=key)
            check_dry_run_conflicts(settings)  # must not raise

    def test_dry_run_with_durable_effects_raises(self):
        """Durable job effects + dry_run must raise DryRunConflictError."""
        settings = _make_settings(
            dry_run=True, api_key="cpk_test", durable_job_effects=True
        )
        with pytest.raises(DryRunConflictError, match="durable"):
            check_dry_run_conflicts(settings)

    def test_dry_run_allow_production_keys_overrides_guard(self):
        """TALOS_DRY_RUN_ALLOW_PRODUCTION_KEYS=1 bypasses the production-key guard."""
        settings = _make_settings(
            dry_run=True,
            api_key="tls_production_key",
            allow_prod_keys=True,
        )
        check_dry_run_conflicts(settings)  # must not raise

    def test_allow_prod_keys_does_not_override_durable_effects_guard(self):
        """The durable-effects guard is independent of the production-key override."""
        settings = _make_settings(
            dry_run=True,
            api_key="tls_production_key",
            durable_job_effects=True,
            allow_prod_keys=True,  # bypasses key guard but not durable guard
        )
        with pytest.raises(DryRunConflictError, match="durable"):
            check_dry_run_conflicts(settings)


# ── End-to-end cycle simulation ───────────────────────────────────────────────


class TestDryRunCycleSimulation:
    """Simulate a simplified agent cycle in dry-run to verify no real writes occur."""

    @pytest.mark.asyncio
    async def test_full_cycle_no_writes(self):
        """A simulated cycle in dry-run mode must produce zero real write calls."""
        real_api = _make_api_client()
        real_adapter = _FakeSocialAdapter()
        recorder = DryRunRecorder()

        proxy_api = wrap_api_client(real_api, recorder)
        proxy_adapter = wrap_social_adapter(real_adapter, recorder)

        # Simulate cycle: read balance (OK), then post to social, then transfer
        reads = await proxy_api.get_pending_jobs()
        assert reads == []  # read forwarded

        post_result = await proxy_adapter.post("Cycle update: all systems go")
        assert post_result.status == "dry_run"

        transfer_result = await proxy_api.request_transfer(
            to_account="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            amount=5,
        )
        assert transfer_result["status"] == "dry_run"

        # Real write methods must have zero calls
        real_api.request_transfer.assert_not_called()
        real_api.create_approval.assert_not_called()

        # Two effects recorded (post + transfer)
        assert len(recorder.effects) == 2
        methods = [e.method for e in recorder.effects]
        assert any("post" in m for m in methods)
        assert any("request_transfer" in m for m in methods)

        # Status dict reflects suppressed count
        status = recorder.to_status_dict()
        assert status["dry_run"] is True
        assert status["suppressed_effect_count"] == 2
