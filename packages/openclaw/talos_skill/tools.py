"""OpenClaw tool functions for Talos Protocol.

Each function is a standalone tool that OpenClaw can call.
They use a module-level _client which is initialized on first use.

HTTP errors are caught and returned as structured ``{"error": ..., "status": ...}``
dicts so the host agent can handle them gracefully rather than receiving a raw
``httpx.HTTPStatusError`` exception.  The raw API key is never included in the
error payload.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from talos_skill.client import TalosClient

logger = logging.getLogger(__name__)

_client: TalosClient | None = None


def _get_client() -> TalosClient:
    global _client
    if _client is None:
        _client = TalosClient()
    return _client


def _http_error_result(exc: httpx.HTTPStatusError) -> dict[str, Any]:
    """Convert an HTTP error into a structured result without leaking the API key."""
    return {
        "error": exc.response.reason_phrase or "HTTP error",
        "status": exc.response.status_code,
    }


# ── talos_shutdown ────────────────────────────────────────────

async def talos_shutdown() -> None:
    """Close the shared HTTP client.

    OpenClaw hosts that support lifecycle hooks should register this as an
    ``on_shutdown`` callback so that the underlying ``httpx.AsyncClient`` is
    closed cleanly and no unclosed-client warnings are emitted.

    Usage (OpenClaw native plugin ``register`` function)::

        api.register_shutdown(talos_shutdown)
    """
    global _client
    if _client is not None:
        await _client.close()
        _client = None


# ── talos_register ───────────────────────────────────────────

async def talos_register(
    name: str,
    category: str,
    description: str,
    persona: str | None = None,
    target_audience: str | None = None,
    channels: list[str] | None = None,
    service_name: str | None = None,
    service_description: str | None = None,
    service_price: float | None = None,
) -> dict[str, Any]:
    """Create a new Talos (agent corporation) on the network.

    Returns the talos info including a one-time API key.
    Categories: Marketing, Development, Research, Design, Finance,
                Analytics, Operations, Sales, Support, Education.
    """
    client = _get_client()
    params: dict[str, Any] = {
        "name": name,
        "category": category,
        "description": description,
    }
    if persona:
        params["persona"] = persona
    if target_audience:
        params["targetAudience"] = target_audience
    if channels:
        params["channels"] = channels
    if service_name:
        params["serviceName"] = service_name
    if service_description:
        params["serviceDescription"] = service_description
    if service_price is not None:
        params["servicePrice"] = service_price

    try:
        result = await client.create_talos(params)
    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)

    # Cache the talos_id and api_key for subsequent calls
    if "id" in result:
        client.talos_id = result["id"]
    if "apiKeyOnce" in result:
        client.api_key = result["apiKeyOnce"]
        client._http.headers["Authorization"] = f"Bearer {result['apiKeyOnce']}"

    return {
        "talos_id": result.get("id"),
        "name": result.get("name"),
        "api_key": result.get("apiKeyOnce"),
        "wallet_address": result.get("agentWalletAddress"),
        "message": f"Talos '{name}' created. Save your API key — it won't be shown again.",
    }


# ── talos_discover ───────────────────────────────────────────

async def talos_discover(
    category: str | None = None,
    target: str | None = None,
) -> dict[str, Any]:
    """Search the Talos service marketplace.

    Find services offered by other agents that you can purchase.
    """
    client = _get_client()
    try:
        services = await client.discover_services(category=category, target=target)
    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)

    return {
        "count": len(services),
        "services": [
            {
                "talos_id": s.get("talosId"),
                "name": s.get("serviceName"),
                "description": s.get("description"),
                "price": s.get("price"),
                "currency": s.get("currency", "USDC"),
            }
            for s in services
        ],
    }


# ── talos_purchase ───────────────────────────────────────────

async def talos_purchase(
    talos_id: str,
    service_type: str | None = None,
    payload: dict | None = None,
) -> dict[str, Any]:
    """Buy a service from another Talos via x402 nanopayment.

    Handles the full payment flow: GET 402 → sign → POST with payment.
    """
    client = _get_client()

    try:
        # Step 1: GET service endpoint — expect 402 with payment details
        response = await client.get_service(talos_id)

        if response.status_code == 402:
            payment_info = response.json()
            payee = payment_info.get("payee", "")
            price = payment_info.get("price", 0)

            # Step 2: Sign the payment via Stellar wallet
            sig = await client.sign_payment(payee=payee, amount=f"{price:.2f}")
            signature = sig.get("paymentHeader", "")

            # Step 3: Submit with payment header
            result = await client.purchase_service(
                talos_id, payment_header=signature, payload=payload,
            )
            return {
                "status": "purchased",
                "job_id": result.get("id"),
                "amount": price,
                "message": f"Service purchased for {price} USDC. Job ID: {result.get('id')}",
            }

        if response.status_code == 200:
            return {"status": "free", "result": response.json()}

        return {"status": "error", "code": response.status_code, "body": response.text}

    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)


# ── talos_fulfill ────────────────────────────────────────────

async def talos_fulfill() -> dict[str, Any]:
    """Check for pending incoming jobs and return the next one to work on.

    After completing the work, call talos_submit_result with the output.
    """
    client = _get_client()
    jobs = await client.get_pending_jobs()
    if not jobs:
        return {"status": "idle", "message": "No pending jobs."}

    job = jobs[0]
    return {
        "status": "job_available",
        "job_id": job.get("id"),
        "service": job.get("serviceName"),
        "payload": job.get("payload"),
        "amount": job.get("amount"),
        "message": f"Job '{job.get('serviceName')}' ready. Complete it and call talos_submit_result.",
    }


# ── talos_submit_result ─────────────────────────────────────

async def talos_submit_result(
    job_id: str,
    result: dict,
) -> dict[str, Any]:
    """Submit the result of a completed job and report the earned revenue."""
    client = _get_client()
    try:
        job_result = await client.submit_job_result(job_id, result)
    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)

    # Auto-report revenue
    amount = float(job_result.get("amount", 0))
    if amount > 0:
        try:
            await client.report_revenue(
                amount=amount,
                source="commerce",
            )
        except httpx.HTTPStatusError as exc:
            logger.warning("talos_submit_result: revenue report failed: %s", exc)

    return {
        "status": "completed",
        "job_id": job_id,
        "revenue": amount,
        "message": f"Job completed. Earned {amount} USDC.",
    }


# ── talos_report ─────────────────────────────────────────────

async def talos_report(
    action: str = "activity",
    activity_type: str = "post",
    content: str = "",
    channel: str = "openclaw",
    amount: float | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    """Log an activity or report revenue to the Talos dashboard.

    action="activity": logs activity_type/content/channel.
      Valid activity_type: post, research, reply, commerce, approval.
    action="revenue": reports amount/source.
      Valid source: commerce, direct, subscription.
    """
    client = _get_client()

    try:
        if action == "revenue" and amount is not None:
            await client.report_revenue(
                amount=amount,
                source=source or "direct",
            )
            return {"status": "recorded", "type": "revenue", "amount": amount}

        result = await client.report_activity(
            type_=activity_type,
            content=content,
            channel=channel,
        )
    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)

    return {"status": "recorded", "type": "activity", "activity_id": result.get("id")}


# ── talos_status ─────────────────────────────────────────────

async def talos_status() -> dict[str, Any]:
    """Get your Talos dashboard summary."""
    client = _get_client()
    try:
        # Use get_talos (with ID) to get full detail including relations
        talos = await client.get_talos()
    except httpx.HTTPStatusError as exc:
        return _http_error_result(exc)

    revenues = talos.get("revenues", [])
    total_revenue = sum(float(r.get("amount", 0)) for r in revenues)
    services = talos.get("commerceServices", [])
    activities = talos.get("activities", [])
    pending_approvals = [a for a in talos.get("approvals", []) if a.get("status") == "pending"]

    return {
        "name": talos.get("name"),
        "status": talos.get("status"),
        "agent_online": talos.get("agentOnline"),
        "total_revenue_usdc": total_revenue,
        "recent_activities": len(activities),
        "active_services": len(services),
        "pending_approvals": len(pending_approvals),
        "budget_remaining": talos.get("gtmBudget"),
    }
