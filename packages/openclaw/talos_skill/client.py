"""Lightweight Talos API client for OpenClaw skill."""

from __future__ import annotations

import os
from typing import Any

import httpx


class TalosClient:
    """Thin wrapper around the Talos Web API."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        talos_id: str | None = None,
    ):
        self.base_url = (base_url or os.getenv("TALOS_API_URL", "https://talos-stellar.vercel.app")).rstrip("/")
        self.api_key = api_key or os.getenv("TALOS_API_KEY", "")
        self.talos_id = talos_id or os.getenv("TALOS_ID", "")
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=30.0,
        )

    # ── Talos ────────────────────────────────────────────────

    async def create_talos(self, params: dict[str, Any]) -> dict:
        r = await self._http.post("/api/talos", json=params)
        r.raise_for_status()
        return r.json()

    async def get_talos(self, talos_id: str | None = None) -> dict:
        cid = talos_id or self.talos_id
        r = await self._http.get(f"/api/talos/{cid}")
        r.raise_for_status()
        return r.json()

    async def get_talos_me(self) -> dict:
        r = await self._http.get("/api/talos/me")
        r.raise_for_status()
        return r.json()

    # ── Activity & Revenue ────────────────────────────────────

    async def report_activity(self, type_: str, content: str, channel: str) -> dict:
        r = await self._http.post(
            f"/api/talos/{self.talos_id}/activity",
            json={"type": type_, "content": content, "channel": channel},
        )
        r.raise_for_status()
        return r.json()

    async def report_revenue(self, amount: float, source: str, tx_hash: str | None = None) -> dict:
        r = await self._http.post(
            f"/api/talos/{self.talos_id}/revenue",
            json={"amount": amount, "currency": "USDC", "source": source, "txHash": tx_hash},
        )
        r.raise_for_status()
        return r.json()

    # ── Commerce / x402 ───────────────────────────────────────

    async def discover_services(self, category: str | None = None, target: str | None = None) -> list[dict]:
        params: dict[str, str] = {}
        if category:
            params["category"] = category
        if target:
            params["target"] = target
        r = await self._http.get("/api/services", params=params)
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else data.get("services", [])

    async def get_service(self, talos_id: str) -> httpx.Response:
        """GET service — expects 402 with payment details."""
        return await self._http.get(f"/api/talos/{talos_id}/service")

    async def purchase_service(self, talos_id: str, payment_header: str, payload: dict | None = None) -> dict:
        r = await self._http.post(
            f"/api/talos/{talos_id}/service",
            json={"payload": payload},
            headers={"X-PAYMENT": payment_header},
        )
        r.raise_for_status()
        return r.json()

    async def sign_payment(self, payee: str, amount: int) -> dict:
        r = await self._http.post(
            f"/api/talos/{self.talos_id}/sign",
            json={"payee": payee, "amount": amount},
        )
        r.raise_for_status()
        return r.json()

    # ── Jobs ──────────────────────────────────────────────────

    async def get_pending_jobs(self) -> list[dict]:
        r = await self._http.get("/api/jobs/pending")
        if r.status_code != 200:
            return []
        data = r.json()
        return data if isinstance(data, list) else data.get("jobs", [])

    async def submit_job_result(self, job_id: str, result: dict) -> dict:
        r = await self._http.post(f"/api/jobs/{job_id}/result", json={"result": result})
        r.raise_for_status()
        return r.json()

    # ── Status ────────────────────────────────────────────────

    async def update_status(self, online: bool) -> None:
        await self._http.patch(
            f"/api/talos/{self.talos_id}/status",
            json={"agentOnline": online},
        )

    async def close(self) -> None:
        await self._http.aclose()
