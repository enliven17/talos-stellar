"""Commerce tools — x402 inter-Talos service marketplace + Playbook trading."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from talos_agent.payments.x402_signer import X402Signer
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# Injected by registry.build_all_tools
_api: TalosAPIClient = None  # type: ignore[assignment]
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]
_signer: X402Signer | None = None

ALL_CATEGORIES = [
    "Sales", "Marketing", "Analytics", "Development", "Research",
    "Design", "Finance", "Operations", "Support", "Education",
]


def price_to_usdc_units(price_str: str) -> int:
    """Convert a decimal price string to USDC smallest units (6 decimals).

    Uses string-based arithmetic to avoid IEEE 754 floating-point rounding
    errors (e.g. ``1.05 * 1_000_000`` → ``1049999`` in float math).
    """
    parts = str(price_str).split(".")
    whole = parts[0]
    frac = parts[1] if len(parts) > 1 else ""
    frac = frac[:6].ljust(6, "0")  # Pad/truncate to exactly 6 decimal places
    return int(whole + frac)


def _get_signer() -> X402Signer:
    global _signer
    if _signer is None or _signer._api is not _api:
        _signer = X402Signer(_api)
    return _signer


@tool(
    "discover_services",
    "Search the x402 service marketplace. Your own services are excluded. "
    "A random category is picked each call for diversity across all 10 marketplace categories.",
)
async def discover_services(target: str = "") -> dict:
    import random
    category = random.choice(["Sales", "Marketing", "Analytics"])  # TODO: restore ALL_CATEGORIES after testing
    services = await _api.discover_services(
        category=category,
        target=target or None,
    )
    return {"category_searched": category, "services": services, "count": len(services)}


@tool(
    "purchase_service",
    "Purchase a service or Playbook from anOther Talos via x402 (USDC on Arc). Handles 402→sign→submit flow.",
)
async def purchase_service(talos_id: str, service_type: str = "", payload: str = "{}") -> dict:
    try:
        payload_dict = json.loads(payload)
    except json.JSONDecodeError:
        payload_dict = {}

    # Budget check — refuse if monthly spending would exceed GTM budget
    talos_config = _db.get_talos_config()
    gtm_budget = float((talos_config or {}).get("gtmBudget", 200))
    spent_month = _db.get_spending_period(30)
    # We'll check against actual price after 402, but pre-check with budget headroom
    if spent_month >= gtm_budget:
        return {
            "error": "GTM budget exhausted for this month",
            "budget": gtm_budget,
            "spent": spent_month,
            "suggestion": "Focus on free actions (posting, research, fulfilling jobs) or request budget increase approval",
        }

    # Step 1: GET service → expect 402
    response = await _api.get_service(talos_id, service_type=service_type or None)

    if response.status_code != 402:
        return {"error": f"Expected 402, got {response.status_code}", "body": response.text[:200]}

    # Parse 402 response
    payment_details = response.json()
    price = payment_details.get("price", 0)
    payee = payment_details.get("payee", "")
    token = payment_details.get("token")
    chain_id = payment_details.get("chainId")

    # Check if purchase would exceed GTM budget
    if spent_month + float(price) > gtm_budget:
        return {
            "error": f"Purchase of ${price} would exceed GTM budget",
            "budget": gtm_budget,
            "spent": spent_month,
            "remaining": gtm_budget - spent_month,
            "price": price,
            "suggestion": "Request approval to exceed budget or wait for next period",
        }

    # Check approval threshold
    threshold = float(_settings.approval_threshold)
    if price >= threshold:
        result = await _api.create_approval(
            _settings.talos_id,
            type_="transaction",
            title=f"x402 purchase from Talos {talos_id}: ${price}",
            description=f"Service: {service_type}, Payload: {payload}",
            amount=price,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "price": price,
            "talos_id": talos_id,
        }

    # Step 2: Sign payment (EIP-3009)
    signer = _get_signer()
    await signer.initialize()

    # Convert price to USDC smallest unit (6 decimals) — string-based to avoid float rounding
    amount_units = price_to_usdc_units(str(price))

    sign_result = await signer.sign_payment(
        payee=payee,
        amount=amount_units,
        token_address=token,
        chain_id=chain_id,
    )


    if "error" in sign_result:
        return sign_result

    # Step 3: POST with X-PAYMENT header
    submit_result = await _api.submit_commerce(
        talos_id,
        payment_header=sign_result["payment_header"],
        payload=payload_dict,
    )

    if not submit_result:
        return {"error": "Commerce submission failed"}

    # Server returns error JSON if payment verification failed
    if "error" in submit_result:
        return {"error": submit_result["error"], "details": submit_result.get("details", "")}

    job_id = submit_result.get("jobId") or submit_result.get("id", "")

    # Track in local DB
    _db.add_commerce_job(job_id, talos_id, service_type, payload_dict)

    # Record spending against GTM budget
    _db.record_spending(
        amount=float(price),
        category="x402_purchase",
        description=f"Service from Talos {talos_id}: {service_type}",
    )

    # Instant fulfillment: result is already in the response
    if submit_result.get("status") == "completed" and submit_result.get("result"):
        _db.update_commerce_status(job_id, "completed")
        return {
            "status": "completed",
            "job_id": job_id,
            "price": price,
            "talos_id": talos_id,
            "service_type": service_type,
            "result": submit_result["result"],
        }

    return {
        "status": "submitted",
        "job_id": job_id,
        "price": price,
        "talos_id": talos_id,
        "service_type": service_type,
    }


@tool(
    "poll_service_result",
    "Poll for the result of a purchased service. Returns the result or 'pending' status.",
)
async def poll_service_result(job_id: str) -> dict:
    result = await _api.get_job_result(job_id)

    if not result:
        return {"status": "pending", "job_id": job_id}

    status = result.get("status", "pending")
    if status == "completed":
        _db.update_commerce_status(job_id, "completed")

        # If it's a playbook, save it
        job_result = result.get("result", {})
        if isinstance(job_result, dict) and "templates" in job_result:
            name = job_result.get("name", f"Playbook from job {job_id}")
            _db.save_playbook(name, job_result, source_talos=result.get("talosId"))
            return {
                "status": "completed",
                "type": "playbook",
                "playbook_name": name,
                "data": job_result,
            }

        return {"status": "completed", "result": job_result}

    return {"status": status, "job_id": job_id}


@tool(
    "apply_playbook",
    "Apply a purchased GTM Playbook to update agent strategy. The playbook's schedule, templates, and tactics will inform future actions.",
)
async def apply_playbook(playbook_name: str) -> dict:
    """Find and activate a playbook by name."""
    conn = _db._conn
    rows = conn.execute(
        "SELECT id, name, data FROM playbooks WHERE name LIKE ?", (f"%{playbook_name}%",)
    ).fetchall()

    if not rows:
        return {"error": f"No playbook found matching '{playbook_name}'"}

    row = rows[0]
    _db.apply_playbook(row["id"])

    return {
        "status": "applied",
        "playbook": row["name"],
        "message": "Playbook is now active. Future agent cycles will use this strategy.",
    }


# ══════════════════════��════════════════════════════════════════════
# Provider-side tools — this Talos fulfills incoming x402 jobs
# ═══════════════════════════════════════════════════════════════════


@tool(
    "get_pending_jobs",
    "Check for incoming x402 service requests that Other Taloses have purchased from us. Returns pending jobs to fulfill.",
)
async def get_pending_jobs() -> dict:
    jobs = await _api.get_pending_jobs()
    if not jobs:
        return {"status": "no_pending_jobs", "count": 0}
    summary = [
        {
            "job_id": j.get("id"),
            "service": j.get("serviceName"),
            "requester": j.get("requesterTalosId"),
            "payload": j.get("payload"),
        }
        for j in jobs
    ]
    return {"jobs": summary, "count": len(summary)}


@tool(
    "fulfill_job",
    "Submit the result for an x402 service job we received. Call this after performing the requested service (e.g. generating an image, writing copy, producing a playbook).",
)
async def fulfill_job(job_id: str, result: str = "{}") -> dict:
    try:
        result_dict = json.loads(result)
    except json.JSONDecodeError:
        result_dict = {"text": result}

    response = await _api.submit_job_result(job_id, result_dict)
    if response:
        # Report revenue — we earned money from this service
        _db.add_activity("commerce", f"Fulfilled job {job_id}", "x402")
        return {"status": "fulfilled", "job_id": job_id}
    return {"error": f"Failed to submit result for job {job_id}"}


@tool(
    "generate_playbook",
    "Generate a GTM Playbook from your accumulated activity data and publish it to the marketplace. "
    "Analyzes your content history, engagement patterns, and successful tactics to create a sellable playbook.",
)
async def generate_playbook(
    title: str,
    category: str = "Content Templates",
    channel: str = "X",
    price: float = 1.0,
    description: str = "",
) -> dict:
    """Generate a playbook from agent's accumulated GTM data and publish it."""
    # Gather agent's activity data for playbook content
    recent_content = _db.get_recent_content(50)
    posts_total = _db.count_today("post")  # today only; full history below
    active_playbook = _db.get_active_playbook()

    # Compile content history into structured playbook
    content_by_channel: dict[str, list[str]] = {}
    for c in recent_content:
        ch = c.get("channel", "unknown")
        content_by_channel.setdefault(ch, []).append(c.get("content", ""))

    # Build playbook content structure
    playbook_content = {
        "schedule": "Daily: 2-3 posts, 5-10 engagement replies. Weekly: 1 research thread.",
        "templates": content_by_channel.get(channel, content_by_channel.get("X", []))[:10],
        "hashtags": [],
        "tactics": [
            "Consistent daily posting with engagement-first approach",
            "Monitor mentions and reply within 1 cycle",
            "Research trending topics before creating content",
        ],
        "source_metrics": {
            "total_content_pieces": len(recent_content),
            "channels_active": list(content_by_channel.keys()),
        },
    }

    # Merge insights from active playbook if available
    if active_playbook and isinstance(active_playbook.get("data"), dict):
        existing = active_playbook["data"]
        if "tactics" in existing:
            playbook_content["tactics"].extend(existing["tactics"][:3])
        if "hashtags" in existing:
            playbook_content["hashtags"] = existing["hashtags"]

    # Compute basic metrics from activity
    conn = _db._conn
    total_posts = conn.execute(
        "SELECT COUNT(*) as cnt FROM activity_log WHERE type = 'post'"
    ).fetchone()
    total_replies = conn.execute(
        "SELECT COUNT(*) as cnt FROM activity_log WHERE type = 'reply'"
    ).fetchone()
    days_active = conn.execute(
        "SELECT COUNT(DISTINCT date(created_at)) as cnt FROM activity_log"
    ).fetchone()

    impressions_est = (total_posts["cnt"] if total_posts else 0) * 100  # rough estimate
    engagement_rate = 0.0
    if total_posts and total_posts["cnt"] > 0 and total_replies:
        engagement_rate = round(
            (total_replies["cnt"] / (total_posts["cnt"] * 10)) * 100, 2
        )

    auto_description = description or (
        f"Proven GTM strategy from {days_active['cnt'] if days_active else 0} days of autonomous execution. "
        f"Includes {len(playbook_content['templates'])} content templates and battle-tested tactics."
    )

    # Publish to marketplace via API
    result = await _api.publish_playbook(
        title=title,
        category=category,
        channel=channel,
        description=auto_description,
        price=price,
        tags=["auto-generated", channel.lower(), category.lower().replace(" ", "-")],
        content=playbook_content,
        impressions=impressions_est,
        engagement_rate=min(engagement_rate, 99.99),
        conversions=0,
        period_days=days_active["cnt"] if days_active else 30,
    )

    if result:
        return {
            "status": "published",
            "playbook_id": result.get("id"),
            "title": title,
            "price": price,
            "templates_count": len(playbook_content["templates"]),
            "impressions": impressions_est,
        }
    return {"error": "Failed to publish playbook to marketplace"}


@tool(
    "register_service",
    "Register or update this Talos's x402 service offering on the marketplace so other agents can discover and purchase it.",
)
async def register_service(
    service_name: str,
    description: str,
    price: float,
    wallet_address: str = "",
) -> dict:
    result = await _api.register_service(
        _settings.talos_id,
        service_name=service_name,
        description=description,
        price=price,
        wallet_address=wallet_address or None,
    )
    if result:
        return {"status": "registered", "service_name": service_name, "price": price}
    return {"error": "Service registration failed"}
