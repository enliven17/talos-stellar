"""
pytest suite for talos_skill/tools.py (issue #889).

Every public tool function is covered with mocked HTTP via respx so no
network calls are made and no real TALOS_API_URL / keys are required.
"""
from __future__ import annotations

import importlib
import json
import os
from unittest.mock import patch

import httpx
import pytest
import respx

# ── Fixtures ──────────────────────────────────────────────────────────────────

BASE_URL = "https://talos-test.example"


@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    """Set minimal environment variables and reset the module-level client."""
    monkeypatch.setenv("TALOS_API_URL", BASE_URL)
    monkeypatch.setenv("TALOS_API_KEY", "test-key")
    monkeypatch.setenv("TALOS_ID", "talos-abc123")
    # Reset module-level _client so each test gets a fresh TalosClient
    import talos_skill.tools as tools_mod
    tools_mod._client = None
    yield
    tools_mod._client = None


# ── talos_register ────────────────────────────────────────────────────────────

class TestTalosRegister:
    @respx.mock
    @pytest.mark.asyncio
    async def test_returns_structured_result(self):
        from talos_skill.tools import talos_register

        respx.post(f"{BASE_URL}/api/talos").mock(
            return_value=httpx.Response(
                201,
                json={
                    "id": "talos-xyz",
                    "name": "TestBot",
                    "apiKeyOnce": "sk-once-abc",
                    "agentWalletAddress": "GABC123",
                },
            )
        )

        result = await talos_register(
            name="TestBot",
            category="Marketing",
            description="A test bot",
        )

        assert result["talos_id"] == "talos-xyz"
        assert result["name"] == "TestBot"
        assert result["api_key"] == "sk-once-abc"
        assert result["wallet_address"] == "GABC123"
        assert "Save your API key" in result["message"]

    @respx.mock
    @pytest.mark.asyncio
    async def test_optional_fields_are_sent_when_provided(self):
        from talos_skill.tools import talos_register
        import talos_skill.tools as tools_mod

        route = respx.post(f"{BASE_URL}/api/talos").mock(
            return_value=httpx.Response(201, json={"id": "t1", "name": "X"})
        )

        await talos_register(
            name="X",
            category="Sales",
            description="desc",
            persona="Friendly",
            target_audience="SMBs",
            channels=["x", "linkedin"],
            service_name="Lead Gen",
            service_description="Find leads",
            service_price=5.0,
        )

        body = json.loads(route.calls[0].request.content)
        assert body["persona"] == "Friendly"
        assert body["targetAudience"] == "SMBs"
        assert body["channels"] == ["x", "linkedin"]
        assert body["serviceName"] == "Lead Gen"
        assert body["servicePrice"] == 5.0

    @respx.mock
    @pytest.mark.asyncio
    async def test_caches_talos_id_and_api_key_on_client(self):
        from talos_skill.tools import talos_register, _get_client

        respx.post(f"{BASE_URL}/api/talos").mock(
            return_value=httpx.Response(
                201,
                json={"id": "talos-new", "apiKeyOnce": "sk-new"},
            )
        )

        await talos_register(name="Bot", category="Dev", description="d")
        client = _get_client()
        assert client.talos_id == "talos-new"
        assert client.api_key == "sk-new"


# ── talos_discover ────────────────────────────────────────────────────────────

class TestTalosDiscover:
    @respx.mock
    @pytest.mark.asyncio
    async def test_returns_service_list(self):
        from talos_skill.tools import talos_discover

        respx.get(f"{BASE_URL}/api/services").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {
                        "talosId": "t1",
                        "serviceName": "Lead Gen",
                        "description": "Find leads",
                        "price": 2.5,
                        "currency": "USDC",
                    }
                ],
            )
        )

        result = await talos_discover()

        assert result["count"] == 1
        svc = result["services"][0]
        assert svc["talos_id"] == "t1"
        assert svc["name"] == "Lead Gen"
        assert svc["price"] == 2.5
        assert svc["currency"] == "USDC"

    @respx.mock
    @pytest.mark.asyncio
    async def test_passes_category_and_target_as_query_params(self):
        from talos_skill.tools import talos_discover

        route = respx.get(f"{BASE_URL}/api/services").mock(
            return_value=httpx.Response(200, json=[])
        )

        await talos_discover(category="Marketing", target="startups")

        url = str(route.calls[0].request.url)
        assert "category=Marketing" in url
        assert "target=startups" in url

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_wrapped_response(self):
        """API may return { services: [...] } instead of a plain list."""
        from talos_skill.tools import talos_discover

        respx.get(f"{BASE_URL}/api/services").mock(
            return_value=httpx.Response(200, json={"services": [], "total": 0})
        )

        result = await talos_discover()
        assert result["count"] == 0
        assert result["services"] == []


# ── talos_purchase ────────────────────────────────────────────────────────────

class TestTalosPurchase:
    @respx.mock
    @pytest.mark.asyncio
    async def test_full_payment_flow(self):
        from talos_skill.tools import talos_purchase

        respx.get(f"{BASE_URL}/api/talos/seller-1/service").mock(
            return_value=httpx.Response(
                402, json={"payee": "GPAYEE", "price": 1.5}
            )
        )
        respx.post(f"{BASE_URL}/api/talos/talos-abc123/sign").mock(
            return_value=httpx.Response(200, json={"paymentHeader": "sig-xyz"})
        )
        respx.post(f"{BASE_URL}/api/talos/seller-1/service").mock(
            return_value=httpx.Response(200, json={"id": "job-001"})
        )

        result = await talos_purchase(talos_id="seller-1", payload={"topic": "AI"})

        assert result["status"] == "purchased"
        assert result["job_id"] == "job-001"
        assert result["amount"] == 1.5

    @respx.mock
    @pytest.mark.asyncio
    async def test_free_service_returns_immediately(self):
        from talos_skill.tools import talos_purchase

        respx.get(f"{BASE_URL}/api/talos/seller-free/service").mock(
            return_value=httpx.Response(200, json={"data": "free result"})
        )

        result = await talos_purchase(talos_id="seller-free")

        assert result["status"] == "free"
        assert result["result"] == {"data": "free result"}

    @respx.mock
    @pytest.mark.asyncio
    async def test_unexpected_status_returns_error(self):
        from talos_skill.tools import talos_purchase

        respx.get(f"{BASE_URL}/api/talos/seller-bad/service").mock(
            return_value=httpx.Response(503, text="unavailable")
        )

        result = await talos_purchase(talos_id="seller-bad")

        assert result["status"] == "error"
        assert result["code"] == 503


# ── talos_fulfill ─────────────────────────────────────────────────────────────

class TestTalosFulfill:
    @respx.mock
    @pytest.mark.asyncio
    async def test_returns_idle_when_no_jobs(self):
        from talos_skill.tools import talos_fulfill

        respx.get(f"{BASE_URL}/api/jobs/pending").mock(
            return_value=httpx.Response(200, json=[])
        )

        result = await talos_fulfill()

        assert result["status"] == "idle"
        assert "No pending jobs" in result["message"]

    @respx.mock
    @pytest.mark.asyncio
    async def test_returns_first_pending_job(self):
        from talos_skill.tools import talos_fulfill

        respx.get(f"{BASE_URL}/api/jobs/pending").mock(
            return_value=httpx.Response(
                200,
                json=[
                    {
                        "id": "job-42",
                        "serviceName": "trend_research",
                        "payload": {"topic": "AI"},
                        "amount": 2.0,
                    },
                    {"id": "job-43", "serviceName": "find_leads", "payload": {}, "amount": 1.0},
                ],
            )
        )

        result = await talos_fulfill()

        assert result["status"] == "job_available"
        assert result["job_id"] == "job-42"
        assert result["service"] == "trend_research"
        assert result["amount"] == 2.0

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_non_200_gracefully(self):
        from talos_skill.tools import talos_fulfill

        respx.get(f"{BASE_URL}/api/jobs/pending").mock(
            return_value=httpx.Response(503)
        )

        result = await talos_fulfill()
        assert result["status"] == "idle"


# ── talos_submit_result ───────────────────────────────────────────────────────

class TestTalosSubmitResult:
    @respx.mock
    @pytest.mark.asyncio
    async def test_submits_and_reports_revenue(self):
        from talos_skill.tools import talos_submit_result

        respx.post(f"{BASE_URL}/api/jobs/job-99/result").mock(
            return_value=httpx.Response(
                200, json={"id": "job-99", "amount": "3.5"}
            )
        )
        revenue_route = respx.post(
            f"{BASE_URL}/api/talos/talos-abc123/revenue"
        ).mock(return_value=httpx.Response(200, json={"id": "rev-1"}))

        result = await talos_submit_result(
            job_id="job-99", result={"summary": "done"}
        )

        assert result["status"] == "completed"
        assert result["job_id"] == "job-99"
        assert result["revenue"] == 3.5
        assert revenue_route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_skips_revenue_report_when_amount_is_zero(self):
        from talos_skill.tools import talos_submit_result

        respx.post(f"{BASE_URL}/api/jobs/job-0/result").mock(
            return_value=httpx.Response(200, json={"id": "job-0", "amount": "0"})
        )
        revenue_route = respx.post(
            f"{BASE_URL}/api/talos/talos-abc123/revenue"
        ).mock(return_value=httpx.Response(200, json={}))

        await talos_submit_result(job_id="job-0", result={})

        assert not revenue_route.called


# ── talos_report ──────────────────────────────────────────────────────────────

class TestTalosReport:
    @respx.mock
    @pytest.mark.asyncio
    async def test_logs_activity(self):
        from talos_skill.tools import talos_report

        route = respx.post(
            f"{BASE_URL}/api/talos/talos-abc123/activity"
        ).mock(return_value=httpx.Response(200, json={"id": "act-1"}))

        result = await talos_report(
            action="activity",
            activity_type="post",
            content="Shared a thread on X",
            channel="x",
        )

        assert result["status"] == "recorded"
        assert result["type"] == "activity"
        assert result["activity_id"] == "act-1"
        body = json.loads(route.calls[0].request.content)
        assert body["type"] == "post"
        assert body["channel"] == "x"

    @respx.mock
    @pytest.mark.asyncio
    async def test_reports_revenue(self):
        from talos_skill.tools import talos_report

        route = respx.post(
            f"{BASE_URL}/api/talos/talos-abc123/revenue"
        ).mock(return_value=httpx.Response(200, json={"id": "rev-2"}))

        result = await talos_report(
            action="revenue",
            amount=10.0,
            source="commerce",
        )

        assert result["status"] == "recorded"
        assert result["type"] == "revenue"
        assert result["amount"] == 10.0
        body = json.loads(route.calls[0].request.content)
        assert body["amount"] == 10.0
        assert body["source"] == "commerce"

    @respx.mock
    @pytest.mark.asyncio
    async def test_revenue_defaults_source_to_direct(self):
        from talos_skill.tools import talos_report

        route = respx.post(
            f"{BASE_URL}/api/talos/talos-abc123/revenue"
        ).mock(return_value=httpx.Response(200, json={}))

        await talos_report(action="revenue", amount=5.0)

        body = json.loads(route.calls[0].request.content)
        assert body["source"] == "direct"


# ── talos_status ──────────────────────────────────────────────────────────────

class TestTalosStatus:
    @respx.mock
    @pytest.mark.asyncio
    async def test_returns_dashboard_summary(self):
        from talos_skill.tools import talos_status

        respx.get(f"{BASE_URL}/api/talos/talos-abc123").mock(
            return_value=httpx.Response(
                200,
                json={
                    "name": "TestBot",
                    "status": "active",
                    "agentOnline": True,
                    "gtmBudget": 500.0,
                    "revenues": [{"amount": "3.5"}, {"amount": "2.0"}],
                    "commerceServices": [{"id": "svc-1"}],
                    "activities": [{"id": "act-1"}, {"id": "act-2"}],
                    "approvals": [
                        {"id": "ap-1", "status": "pending"},
                        {"id": "ap-2", "status": "approved"},
                    ],
                },
            )
        )

        result = await talos_status()

        assert result["name"] == "TestBot"
        assert result["status"] == "active"
        assert result["agent_online"] is True
        assert result["total_revenue_usdc"] == pytest.approx(5.5)
        assert result["active_services"] == 1
        assert result["recent_activities"] == 2
        assert result["pending_approvals"] == 1
        assert result["budget_remaining"] == 500.0

    @respx.mock
    @pytest.mark.asyncio
    async def test_handles_empty_relations(self):
        from talos_skill.tools import talos_status

        respx.get(f"{BASE_URL}/api/talos/talos-abc123").mock(
            return_value=httpx.Response(
                200,
                json={
                    "name": "EmptyBot",
                    "status": "pending",
                    "agentOnline": False,
                },
            )
        )

        result = await talos_status()

        assert result["total_revenue_usdc"] == 0.0
        assert result["active_services"] == 0
        assert result["recent_activities"] == 0
        assert result["pending_approvals"] == 0
