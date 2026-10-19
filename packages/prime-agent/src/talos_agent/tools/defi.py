"""DeFi tools — loan requests and repayment management for lending platforms."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from stellar_sdk import StrKey

from talos_agent.tools import context as _context
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# Injected by registry.build_all_tools
_api: TalosAPIClient = None  # type: ignore[assignment]
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]

_MIN_DURATION_DAYS = 1
_MAX_DURATION_DAYS = 365


def _deps():
    """This agent's dependencies: the bound ToolContext, else this module's globals."""
    return _context.resolve(globals())


def _is_valid_positive_amount(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value > 0
    except (TypeError, OverflowError):
        return False


def _is_valid_duration_days(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, int):
        return False
    return _MIN_DURATION_DAYS <= value <= _MAX_DURATION_DAYS


def _is_valid_repayment_address(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    return StrKey.is_valid_ed25519_public_key(value)


@tool(
    "request_defi_loan",
    "Request a loan from a DeFi lending platform. Requires Creator approval for amounts above threshold. "
    "Tracks loan in local database for automated repayment monitoring.",
)
async def request_defi_loan(
    platform: str,
    amount: float,
    collateral_asset: str = "USDC",
    loan_asset: str = "USDC",
    duration_days: int = 30,
    purpose: str = "",
    repayment_address: str | None = None,
) -> dict:
    """Request a loan from a DeFi lending platform.
    
    Args:
        platform: Name of the lending platform (e.g., 'aave', 'compound', 'blender')
        amount: Amount to borrow in loan_asset
        collateral_asset: Asset to use as collateral (default: USDC)
        loan_asset: Asset to borrow (default: USDC)
        duration_days: Expected loan duration in days (default: 30)
        purpose: Description of loan purpose
        repayment_address: Stellar public key for automated repayments
    
    Returns:
        Loan request status with tracking information
    """
    if not _is_valid_positive_amount(amount):
        return {"error": "Loan amount must be a finite number greater than 0"}

    if not _is_valid_duration_days(duration_days):
        return {
            "error": (
                f"Loan duration_days must be an integer between "
                f"{_MIN_DURATION_DAYS} and {_MAX_DURATION_DAYS}"
            )
        }

    if not _is_valid_repayment_address(repayment_address):
        return {
            "error": "Invalid repayment_address: must be a valid Stellar Ed25519 public key"
        }

    # Check approval threshold
    threshold = float(_deps().settings.approval_threshold)
    if amount > threshold:
        result = await _deps().api.create_approval(
            _deps().settings.talos_id,
            type_="transaction",
            title=f"DeFi loan request: {amount} {loan_asset} from {platform}",
            description=f"Collateral: {collateral_asset}, Duration: {duration_days} days. Purpose: {purpose}",
            amount=amount,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "platform": platform,
            "amount": amount,
            "loan_asset": loan_asset,
            "collateral_asset": collateral_asset,
            "repayment_address": repayment_address,
        }

    # For amounts below threshold, proceed with loan request
    # In a real implementation, this would interact with the lending platform's API
    # For now, we'll track the loan request in the database
    
    loan_id = _deps().db.create_loan(
        platform=platform,
        amount=amount,
        collateral_asset=collateral_asset,
        loan_asset=loan_asset,
        duration_days=duration_days,
        purpose=purpose,
        repayment_address=repayment_address,
    )
    
    # Record as spending for budget tracking
    _deps().db.record_spending(
        amount=amount,
        category="defi_loan",
        description=f"Loan from {platform}: {purpose}",
    )
    
    return {
        "status": "requested",
        "loan_id": loan_id,
        "platform": platform,
        "amount": amount,
        "loan_asset": loan_asset,
        "collateral_asset": collateral_asset,
        "duration_days": duration_days,
        "repayment_address": repayment_address,
        "message": "Loan request tracked. Actual borrowing requires integration with lending platform.",
    }


@tool(
    "get_active_loans",
    "Retrieve all active loans from the database with their current status and repayment information.",
)
async def get_active_loans() -> dict:
    """Get all active loans being tracked."""
    loans = _deps().db.get_active_loans()
    return {
        "count": len(loans),
        "loans": loans,
    }


@tool(
    "repay_loan",
    "Manually trigger repayment for a specific loan. Use when you want to repay before the scheduled auto-repayment.",
)
async def repay_loan(loan_id: int, amount: float | None = None) -> dict:
    """Repay a loan, either partially or in full.
    
    Args:
        loan_id: Database ID of the loan to repay
        amount: Amount to repay (if None, repays full outstanding amount)
    
    Returns:
        Repayment status
    """
    if amount is not None and not _is_valid_positive_amount(amount):
        return {"error": "Repayment amount must be a finite number greater than 0"}

    loan = _deps().db.get_loan_by_id(loan_id)
    if not loan:
        return {"error": f"Loan {loan_id} not found"}
    
    if loan["status"] != "active":
        return {"error": f"Loan {loan_id} is not active (status: {loan['status']})"}
    
    # If amount not specified, repay full outstanding
    if amount is None:
        amount = loan["outstanding_amount"]

    if not _is_valid_positive_amount(amount):
        return {"error": "Repayment amount must be a finite number greater than 0"}
    
    if amount > loan["outstanding_amount"]:
        return {"error": f"Repayment amount {amount} exceeds outstanding {loan['outstanding_amount']}"}
    
    # Check approval threshold for repayment
    threshold = float(_deps().settings.approval_threshold)
    if amount > threshold:
        result = await _deps().api.create_approval(
            _deps().settings.talos_id,
            type_="transaction",
            title=f"Loan repayment: {amount} {loan['loan_asset']} to {loan['platform']}",
            description=f"Repaying loan {loan_id}. Outstanding before: {loan['outstanding_amount']}",
            amount=amount,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "loan_id": loan_id,
            "amount": amount,
        }
    
    # Process repayment
    _deps().db.record_repayment(loan_id, amount)
    
    return {
        "status": "repayment_recorded",
        "loan_id": loan_id,
        "amount": amount,
        "remaining": loan["outstanding_amount"] - amount,
    }
