"""OpenClaw tool functions for Talos Protocol.

Each function is a standalone tool that OpenClaw can call.
They use module-level _client which is initialized on first use.
"""

from __future__ import annotations

from typing import Any

from talos_skill.client import TalosClient

_client: TalosClient | None = None


def _get_client() -> TalosClient:
    global _client
    if _client is None:
        _client = TalosClient()
    return _client


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

    result = await client.create_talos(params)
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
    services = await client.discover_services(category=category, target=target)
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

    # Step 1: GET service endpoint — expect 402 with payment details
    response = await client.get_service(talos_id)

    if response.status_code == 402:
        payment_info = response.json()
        payee = payment_info.get("payee", "")
        price = payment_info.get("price", 0)

        # Step 2: Sign the payment via Stellar wallet
        sig = await client.sign_payment(payee=payee, amount=int(price * 1_000_000))
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
    job_result = await client.submit_job_result(job_id, result)

    # Auto-report revenue
    amount = float(job_result.get("amount", 0))
    if amount > 0:
        await client.report_revenue(
            amount=amount,
            source="commerce",
        )

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
    return {"status": "recorded", "type": "activity", "activity_id": result.get("id")}


# ── talos_status ─────────────────────────────────────────────

async def talos_status() -> dict[str, Any]:
    """Get your Talos dashboard summary."""
    client = _get_client()
    # Use get_talos (with ID) to get full detail including relations
    talos = await client.get_talos()

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
