"""Integration tests for TalosAPIClient with mock HTTP responses and retry logic."""

from __future__ import annotations

import pytest
import respx
from httpx import Response

from talos_agent.api_client import TalosAPIClient
from talos_agent.config import Settings


@pytest.fixture
def api_client(mock_settings: Settings) -> TalosAPIClient:
    """Create a TalosAPIClient with test settings."""
    return TalosAPIClient(mock_settings)


class TestTalosAPIClientRetry:
    """Test retry logic and resilience to transient failures."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_talos_success(self, api_client: TalosAPIClient):
        """GET /api/talos/:id returns Talos config."""
        mock_response = {
            "id": "test-talos",
            "name": "Test Agent",
            "stellarAccountId": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
        }
        respx.get("http://test.local/api/talos/test-talos").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_talos("test-talos")
        assert result is not None
        assert result["id"] == "test-talos"
        assert result["name"] == "Test Agent"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_talos_not_found(self, api_client: TalosAPIClient):
        """GET /api/talos/:id returns None on 404."""
        respx.get("http://test.local/api/talos/nonexistent").mock(
            return_value=Response(404)
        )

        result = await api_client.get_talos("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_talos_me(self, api_client: TalosAPIClient):
        """GET /api/talos/me resolves Talos from API key."""
        mock_response = {"id": "resolved-talos", "name": "Auto-resolved Agent"}
        respx.get("http://test.local/api/talos/me").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_talos_me()
        assert result is not None
        assert result["id"] == "resolved-talos"

    @pytest.mark.asyncio
    @respx.mock
    async def test_report_activity_success(self, api_client: TalosAPIClient):
        """POST activity report returns activity record."""
        mock_response = {"id": "act-123", "type": "post", "content": "Hello"}
        respx.post("http://test.local/api/talos/test-talos-id/activity").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.report_activity(
            "test-talos-id", type_="post", content="Hello", channel="X"
        )
        assert result is not None
        assert result["id"] == "act-123"

    @pytest.mark.asyncio
    @respx.mock
    async def test_report_activity_failure(self, api_client: TalosAPIClient):
        """POST activity report returns None on failure."""
        respx.post("http://test.local/api/talos/test-talos-id/activity").mock(
            return_value=Response(500)
        )

        result = await api_client.report_activity(
            "test-talos-id", type_="post", content="Hello", channel="X"
        )
        assert result is None


class TestApprovalFlow:
    """Test approval request and status checking."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_create_approval(self, api_client: TalosAPIClient):
        """POST approval request returns approval with ID."""
        mock_response = {
            "id": "approval-456",
            "type": "transaction",
            "title": "High-value transfer",
            "amount": 50.0,
            "status": "pending",
        }
        respx.post("http://test.local/api/talos/test-talos-id/approvals").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.create_approval(
            "test-talos-id",
            type_="transaction",
            title="High-value transfer",
            amount=50.0,
        )
        assert result is not None
        assert result["id"] == "approval-456"
        assert result["status"] == "pending"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_approvals_list(self, api_client: TalosAPIClient):
        """GET approvals returns list of pending approvals."""
        mock_response = [
            {"id": "a1", "type": "transaction", "status": "pending"},
            {"id": "a2", "type": "strategy", "status": "approved"},
        ]
        respx.get("http://test.local/api/talos/test-talos-id/approvals").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_approvals("test-talos-id")
        assert len(result) == 2
        assert result[0]["id"] == "a1"
        assert result[1]["status"] == "approved"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_approval_single(self, api_client: TalosAPIClient):
        """GET approval by ID returns approval details."""
        mock_response = {
            "id": "approval-456",
            "status": "approved",
            "decidedBy": "patron@example.com",
        }
        respx.get(
            "http://test.local/api/talos/test-talos-id/approvals/approval-456"
        ).mock(return_value=Response(200, json=mock_response))

        result = await api_client.get_approval("test-talos-id", "approval-456")
        assert result is not None
        assert result["status"] == "approved"


class TestWalletOperations:
    """Test agent wallet creation and retrieval."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_agent_wallet(self, api_client: TalosAPIClient):
        """GET wallet returns wallet ID and address."""
        mock_response = {
            "walletId": "circle-wallet-789",
            "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
        }
        respx.get("http://test.local/api/talos/test-talos-id/wallet").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_agent_wallet()
        assert result is not None
        assert result["walletId"] == "circle-wallet-789"
        assert "publicKey" in result

    @pytest.mark.asyncio
    @respx.mock
    async def test_create_agent_wallet(self, api_client: TalosAPIClient):
        """POST wallet creates new wallet if none exists."""
        mock_response = {
            "walletId": "circle-wallet-new",
            "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
        }
        respx.post("http://test.local/api/talos/test-talos-id/wallet").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.create_agent_wallet()
        assert result is not None
        assert result["walletId"] == "circle-wallet-new"


class TestPaymentSigning:
    """Test x402 payment signing via Web API."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_sign_payment_success(self, api_client: TalosAPIClient):
        """POST sign returns payment header for x402 transfer."""
        mock_response = {
            "paymentHeader": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            "from": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
        }
        respx.post("http://test.local/api/talos/test-talos-id/sign").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=1_000_000,
            asset_code="USDC",
        )
        assert result is not None
        assert "paymentHeader" in result
        assert result["from"] == "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

    @pytest.mark.asyncio
    @respx.mock
    async def test_sign_payment_with_issuer(self, api_client: TalosAPIClient):
        """POST sign handles custom asset issuer."""
        mock_response = {
            "paymentHeader": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        }
        respx.post("http://test.local/api/talos/test-talos-id/sign").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=500_000,
            asset_code="PULSE",
            asset_issuer="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMX",
        )
        assert result is not None


class TestCommerceFlow:
    """Test 402 commerce request flow."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_service_returns_402(self, api_client: TalosAPIClient):
        """GET service returns 402 Payment Required with payment details."""
        mock_response = {
            "price": 10.50,
            "payee": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "token": "GBBD47UZQ5PBC4MUE4BBQWBW6IM5I46UYOWMUSFA67YPPY権",
            "chainId": 280,
        }
        respx.get("http://test.local/api/talos/other-talos/service").mock(
            return_value=Response(402, json=mock_response)
        )

        response = await api_client.get_service("other-talos", service_type="playbook")
        assert response.status_code == 402
        data = response.json()
        assert data["price"] == 10.50
        assert "payee" in data

    @pytest.mark.asyncio
    @respx.mock
    async def test_submit_commerce_with_payment(self, api_client: TalosAPIClient):
        """POST service with X-PAYMENT header submits payment and receives job ID."""
        mock_response = {
            "jobId": "job-2024-001",
            "status": "submitted",
            "result": None,
        }
        route = respx.post("http://test.local/api/talos/other-talos/service")
        route.mock(return_value=Response(201, json=mock_response))

        result = await api_client.submit_commerce(
            "other-talos",
            payment_header="Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            payload={"query": "design a logo"},
        )
        assert result is not None
        assert result["jobId"] == "job-2024-001"

    @pytest.mark.asyncio
    @respx.mock
    async def test_submit_commerce_error_response(self, api_client: TalosAPIClient):
        """POST service returns error if payment verification fails."""
        mock_response = {
            "error": "Invalid payment signature",
            "details": "Signature does not match payee or amount",
        }
        respx.post("http://test.local/api/talos/other-talos/service").mock(
            return_value=Response(402, json=mock_response)
        )

        result = await api_client.submit_commerce(
            "other-talos",
            payment_header="Bearer invalid...",
            payload={},
        )
        assert result is not None
        assert "error" in result


class TestDiscoverServices:
    """Test service discovery marketplace."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_discover_services_by_category(self, api_client: TalosAPIClient):
        """GET services returns matching services by category."""
        mock_response = [
            {
                "id": "svc-1",
                "name": "Content Generation",
                "provider": "content-talos",
                "price": 5.0,
                "category": "Marketing",
            },
            {
                "id": "svc-2",
                "name": "Data Analysis",
                "provider": "analytics-talos",
                "price": 15.0,
                "category": "Analytics",
            },
        ]
        respx.get("http://test.local/api/services").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.discover_services(category="Marketing")
        assert len(result) >= 2
        assert any(s["name"] == "Content Generation" for s in result)


class TestJobOperations:
    """Test pending jobs and result submission."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_pending_jobs(self, api_client: TalosAPIClient):
        """GET jobs/pending returns list of incoming x402 jobs."""
        mock_response = [
            {
                "id": "job-incoming-1",
                "serviceName": "playbook_generation",
                "requesterTalosId": "requesting-talos",
                "payload": {"niche": "AI agents"},
            },
        ]
        respx.get("http://test.local/api/jobs/pending").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_pending_jobs()
        assert len(result) >= 1
        assert result[0]["id"] == "job-incoming-1"

    @pytest.mark.asyncio
    @respx.mock
    async def test_submit_job_result(self, api_client: TalosAPIClient):
        """POST job result submits fulfillment result."""
        mock_response = {"status": "fulfilled", "jobId": "job-incoming-1"}
        respx.post("http://test.local/api/jobs/job-incoming-1/result").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.submit_job_result(
            "job-incoming-1", {"playbook": "generated content"}
        )
        assert result is not None
        assert result["status"] == "fulfilled"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_job_result(self, api_client: TalosAPIClient):
        """GET job result returns completed result."""
        mock_response = {
            "status": "completed",
            "result": {"playbook": "content data"},
        }
        respx.get("http://test.local/api/jobs/job-2024-001/result").mock(
            return_value=Response(200, json=mock_response)
        )

        result = await api_client.get_job_result("job-2024-001")
        assert result is not None
        assert result["status"] == "completed"


class TestPlaybookPublishing:
    """Test playbook publishing to marketplace."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_publish_playbook(self, api_client: TalosAPIClient):
        """POST playbook publishes to marketplace."""
        mock_response = {
            "id": "pb-2024-001",
            "title": "AI Content Strategy",
            "price": 25.0,
            "status": "published",
        }
        respx.post("http://test.local/api/playbooks").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.publish_playbook(
            title="AI Content Strategy",
            category="Content Strategy",
            channel="X",
            description="A proven strategy for AI content",
            price=25.0,
            tags=["ai", "content"],
            impressions=50000,
            engagement_rate=8.5,
        )
        assert result is not None
        assert result["id"] == "pb-2024-001"


class TestTransfers:
    """Test Stellar transfer operations."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_request_transfer_xlm(self, api_client: TalosAPIClient):
        """POST transfer requests XLM transfer."""
        mock_response = {"status": "submitted", "tx_hash": "abc123..."}
        respx.post("http://test.local/api/talos/test-talos-id/transfer").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.request_transfer(
            to_account="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=100.0,
            currency="XLM",
        )
        assert result is not None
        assert result["status"] == "submitted"

    @pytest.mark.asyncio
    @respx.mock
    async def test_request_transfer_with_token(self, api_client: TalosAPIClient):
        """POST transfer with token ID for custom asset."""
        mock_response = {"status": "submitted"}
        respx.post("http://test.local/api/talos/test-talos-id/transfer").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.request_transfer(
            to_account="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=500.0,
            currency="native",
            token_id="pulse-token-1",
        )
        assert result is not None


class TestRevenueReporting:
    """Test revenue reporting."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_report_revenue(self, api_client: TalosAPIClient):
        """POST revenue reports earnings."""
        mock_response = {"id": "rev-123", "amount": 10.5, "status": "recorded"}
        respx.post("http://test.local/api/talos/test-talos-id/revenue").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.report_revenue(
            "test-talos-id",
            amount=10.5,
            source="playbook_sale",
            tx_hash="tx-2024-001",
        )
        assert result is not None
        assert result["amount"] == 10.5


class TestStatusUpdates:
    """Test status reporting."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_update_status(self, api_client: TalosAPIClient):
        """PATCH status updates online status."""
        respx.patch("http://test.local/api/talos/test-talos-id/status").mock(
            return_value=Response(200, json={"status": "ok"})
        )

        # Should not raise
        await api_client.update_status("test-talos-id", online=True)


class TestServiceRegistration:
    """Test service marketplace registration."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_register_service(self, api_client: TalosAPIClient):
        """PUT service registers provider offering."""
        mock_response = {
            "id": "svc-registered-1",
            "serviceName": "Playbook Generation",
            "price": 20.0,
            "status": "active",
        }
        respx.put("http://test.local/api/talos/test-talos-id/service").mock(
            return_value=Response(201, json=mock_response)
        )

        result = await api_client.register_service(
            "test-talos-id",
            service_name="Playbook Generation",
            description="Generate custom GTM playbooks",
            price=20.0,
            wallet_address="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
        )
        assert result is not None
        assert result["serviceName"] == "Playbook Generation"
