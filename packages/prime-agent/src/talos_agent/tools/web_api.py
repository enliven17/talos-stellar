"""Web API tools — reporting and approval interactions."""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings

# Injected by registry.build_all_tools
_api: TalosAPIClient = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]


@tool("report_activity", "Report an activity to the Talos Web dashboard")
async def report_activity(type: str, content: str, channel: str) -> dict:
    result = await _api.report_activity(
        _settings.talos_id, type_=type, content=content, channel=channel
    )
    return result or {"status": "reported"}


@tool(
    "request_approval",
    "Request approval from Patron for a high-value action (transaction, strategy change, etc.)",
)
async def request_approval(
    type: str, title: str, description: str = "", amount: float = 0.0
) -> dict:
    result = await _api.create_approval(
        _settings.talos_id,
        type_=type,
        title=title,
        description=description or None,
        amount=amount or None,
    )
    if result:
        return {"status": "approval_requested", "approval_id": result.get("id")}
    return {"error": "Failed to create approval request"}


@tool("check_approval", "Check the status of a pending approval request")
async def check_approval(approval_id: str) -> dict:
    result = await _api.get_approval(_settings.talos_id, approval_id)
    if result:
        return {"status": result.get("status"), "decided_by": result.get("decidedBy")}
    return {"error": "Approval not found"}


@tool("report_revenue", "Report revenue earned from a service or transaction")
async def report_revenue(amount: float, source: str, tx_hash: str = "") -> dict:
    result = await _api.report_revenue(
        _settings.talos_id,
        amount=amount,
        source=source,
        tx_hash=tx_hash or None,
    )
    return result or {"status": "reported"}
