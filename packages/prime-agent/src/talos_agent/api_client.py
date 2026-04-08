"""Web API client — all communication between Local Agent and Talos Web."""

from __future__ import annotations

from typing import Any

import httpx

from talos_agent.config import Settings


class TalosAPIClient:
    def __init__(self, settings: Settings):
        self._base = settings.talos_api_url.rstrip("/")
        self._talos_id = settings.talos_id
        self._client = httpx.AsyncClient(
            base_url=self._base,
            headers={
                "Authorization": f"Bearer {settings.talos_api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    # ── Talos Config ──────────────────────────────────────

    async def get_talos(self, talos_id: str) -> dict | None:
        r = await self._client.get(f"/api/talos/{talos_id}")
        if r.status_code == 200:
            return r.json()
        return None

    async def get_talos_me(self) -> dict | None:
        """Resolve Talos from API key — no Talos ID needed."""
        r = await self._client.get("/api/talos/me")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Activity Reporting ─────────────────────────────────

    async def report_activity(
        self, talos_id: str, *, type_: str, content: str, channel: str
    ) -> dict | None:
        r = await self._client.post(
            f"/api/talos/{talos_id}/activity",
            json={"type": type_, "content": content, "channel": channel},
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Status ─────────────────────────────────────────────

    async def update_status(self, talos_id: str, *, online: bool) -> None:
        await self._client.patch(
            f"/api/talos/{talos_id}/status",
            json={"agentOnline": online},
        )

    # ── Revenue ────────────────────────────────────────────

    async def report_revenue(
        self, talos_id: str, *, amount: float, source: str, tx_hash: str | None = None
    ) -> dict | None:
        r = await self._client.post(
            f"/api/talos/{talos_id}/revenue",
            json={"amount": amount, "currency": "USDC", "source": source, "txHash": tx_hash},
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Approvals ──────────────────────────────────────────

    async def create_approval(
        self,
        talos_id: str,
        *,
        type_: str,
        title: str,
        description: str | None = None,
        amount: float | None = None,
    ) -> dict | None:
        r = await self._client.post(
            f"/api/talos/{talos_id}/approvals",
            json={"type": type_, "title": title, "description": description, "amount": amount},
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def get_approvals(self, talos_id: str, status: str | None = None) -> list[dict]:
        params: dict[str, Any] = {}
        if status:
            params["status"] = status
        r = await self._client.get(f"/api/talos/{talos_id}/approvals", params=params)
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, list) else data.get("approvals", [])
        return []

    async def get_approval(self, talos_id: str, approval_id: str) -> dict | None:
        r = await self._client.get(f"/api/talos/{talos_id}/approvals/{approval_id}")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Agent Wallet (Circle MPC) ────────────────────────────

    async def get_agent_wallet(self) -> dict | None:
        """Fetch agent wallet info (walletId, address) from Web."""
        r = await self._client.get(f"/api/talos/{self._talos_id}/wallet")
        if r.status_code == 200:
            return r.json()
        return None

    async def create_agent_wallet(self) -> dict | None:
        """Create a Circle MPC wallet for this Talos if one doesn't exist."""
        r = await self._client.post(f"/api/talos/{self._talos_id}/wallet")
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def sign_payment(
        self,
        *,
        payee: str,
        amount: int,
        asset_code: str = "USDC",
        asset_issuer: str | None = None,
    ) -> dict | None:
        """Request x402 payment signature from Web's Stellar proxy."""
        if not self._talos_id:
            return {"error": "talos_id not set"}
        payload: dict[str, Any] = {"payee": payee, "amount": amount, "assetCode": asset_code}
        if asset_issuer:
            payload["assetIssuer"] = asset_issuer
        r = await self._client.post(f"/api/talos/{self._talos_id}/sign", json=payload)
        if r.status_code == 200:
            return r.json()
        # Return error details
        try:
            return r.json()
        except Exception:
            return {"error": f"Sign request failed with status {r.status_code}"}

    # ── Commerce / x402 ────────────────────────────────────

    async def get_service(self, talos_id: str, service_type: str | None = None) -> httpx.Response:
        """GET service endpoint — expects 402 response with payment details."""
        params = {}
        if service_type:
            params["type"] = service_type
        return await self._client.get(f"/api/talos/{talos_id}/service", params=params)

    async def submit_commerce(
        self, talos_id: str, *, payment_header: str, payload: dict | None = None
    ) -> dict | None:
        """POST with x402 payment signature to purchase service."""
        r = await self._client.post(
            f"/api/talos/{talos_id}/service",
            json={"payload": payload},
            headers={"X-PAYMENT": payment_header},
        )
        if r.status_code in (200, 201):
            return r.json()
        # Return error details instead of None
        try:
            return r.json()
        except Exception:
            return {"error": f"Commerce submission failed with status {r.status_code}"}

    async def discover_services(
        self, category: str | None = None, target: str | None = None
    ) -> list[dict]:
        params: dict[str, Any] = {"self": self._talos_id}
        if category:
            params["category"] = category
        if target:
            params["target"] = target
        r = await self._client.get("/api/services", params=params)
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, list) else data.get("data", [])
        return []

    async def register_service(
        self,
        talos_id: str,
        *,
        service_name: str,
        description: str,
        price: float,
        wallet_address: str | None = None,
    ) -> dict | None:
        """Register or update this Talos's x402 service on the marketplace."""
        payload: dict[str, Any] = {
            "serviceName": service_name,
            "description": description,
            "price": price,
        }
        if wallet_address:
            payload["walletAddress"] = wallet_address
        r = await self._client.put(f"/api/talos/{talos_id}/service", json=payload)
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Transfers (Stellar) ────────────────────────────────

    async def request_transfer(
        self,
        *,
        to_account: str,
        amount: float,
        currency: str = "XLM",
        token_id: str | None = None,
    ) -> dict | None:
        """Execute XLM or Stellar asset transfer via Web API."""
        payload: dict[str, Any] = {
            "to": to_account,
            "amount": amount,
            "currency": currency,
        }
        if token_id:
            payload["tokenId"] = token_id
        r = await self._client.post(
            f"/api/talos/{self._talos_id}/transfer", json=payload
        )
        if r.status_code in (200, 201):
            return r.json()
        try:
            return r.json()
        except Exception:
            return {"error": f"Transfer failed with status {r.status_code}"}

    # ── Jobs ───────────────────────────────────────────────

    async def get_pending_jobs(self) -> list[dict]:
        r = await self._client.get("/api/jobs/pending")
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, list) else data.get("jobs", [])
        return []

    async def submit_job_result(self, job_id: str, result: dict) -> dict | None:
        r = await self._client.post(f"/api/jobs/{job_id}/result", json={"result": result})
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def get_job_result(self, job_id: str) -> dict | None:
        r = await self._client.get(f"/api/jobs/{job_id}/result")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Playbooks ──────────────────────────────────────────

    async def publish_playbook(
        self,
        *,
        title: str,
        category: str,
        channel: str,
        description: str,
        price: float,
        tags: list[str] | None = None,
        content: dict | None = None,
        impressions: int = 0,
        engagement_rate: float = 0,
        conversions: int = 0,
        period_days: int = 30,
    ) -> dict | None:
        """Publish a Playbook to the marketplace."""
        r = await self._client.post(
            "/api/playbooks",
            json={
                "title": title,
                "category": category,
                "channel": channel,
                "description": description,
                "price": price,
                "tags": tags or [],
                "content": content,
                "impressions": impressions,
                "engagementRate": engagement_rate,
                "conversions": conversions,
                "periodDays": period_days,
            },
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Lifecycle ──────────────────────────────────────────

    async def close(self) -> None:
        await self._client.aclose()
