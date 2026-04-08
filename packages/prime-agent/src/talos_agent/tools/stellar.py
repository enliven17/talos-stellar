"""Stellar tools — internal economy (Pulse tokens, XLM dividends, governance).

All operations are proxied through the Talos Web API or read from
Stellar Mirror Node. The Agent never holds private keys.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.payments.stellar_kit import StellarKit
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings

# Injected by registry.build_all_tools
_settings: Settings = None  # type: ignore[assignment]
_api: TalosAPIClient = None  # type: ignore[assignment]
_stellar_kit: StellarKit | None = None


def _get_kit() -> StellarKit:
    global _stellar_kit
    if _stellar_kit is None:
        _stellar_kit = StellarKit(_api)
    return _stellar_kit


@tool("transfer_xlm", "Transfer XLM to a Stellar account (dividends, payments). Auto-checks approval threshold.")
async def transfer_xlm(to_account: str, amount: float, reason: str = "") -> dict:
    kit = _get_kit()
    await kit.initialize()

    # Check threshold
    threshold = float(_settings.approval_threshold)
    if amount >= threshold:
        result = await _api.create_approval(
            _settings.talos_id,
            type_="transaction",
            title=f"XLM transfer: {amount} to {to_account}",
            description=reason,
            amount=amount,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "amount": amount,
            "to": to_account,
        }

    return await kit.transfer_xlm(to_account, amount)


@tool("get_xlm_balance", "Check XLM balance for the Talos account via Horizon")
async def get_xlm_balance() -> dict:
    kit = _get_kit()
    await kit.initialize()
    return await kit.get_balance()


@tool("create_pulse_token", "Request Pulse (equity) token creation. Requires Creator approval on Dashboard.")
async def create_pulse_token(name: str, symbol: str, initial_supply: int = 1000000) -> dict:
    result = await _api.create_approval(
        _settings.talos_id,
        type_="transaction",
        title=f"Create Pulse token: {name} ({symbol})",
        description=f"Initial supply: {initial_supply}. Token creation handled by Web via Soroban.",
    )
    return {
        "status": "approval_requested",
        "approval_id": result.get("id") if result else None,
        "action": "create_pulse_token",
        "name": name,
        "symbol": symbol,
    }


@tool("airdrop_pulse", "Distribute Pulse tokens to Patron accounts. Requires Creator approval for large amounts.")
async def airdrop_pulse(token_id: str, recipients: str) -> dict:
    """recipients: JSON string of [{account: '0.0.xxx', amount: 1000}, ...]"""
    import json as _json
    try:
        recipient_list = _json.loads(recipients) if isinstance(recipients, str) else recipients
    except _json.JSONDecodeError:
        return {"error": "recipients must be valid JSON: [{account: '...', amount: N}, ...]"}

    total_amount = sum(r.get("amount", 0) for r in recipient_list)
    threshold = float(_settings.approval_threshold)

    if total_amount >= threshold:
        result = await _api.create_approval(
            _settings.talos_id,
            type_="transaction",
            title=f"Pulse airdrop: token {token_id}, total {total_amount}",
            description=f"Recipients: {recipients}",
            amount=total_amount,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "action": "airdrop_pulse",
        }

    # Execute transfers via Web API
    results = []
    for r in recipient_list:
        acct = r.get("account", "")
        amt = r.get("amount", 0)
        if acct and amt > 0:
            res = await _api.request_transfer(
                to_account=acct, amount=amt, currency="native", token_id=token_id
            )
            results.append({"account": acct, "amount": amt, "result": res})
    return {"status": "completed", "transfers": results}


@tool("execute_approved_transfer", "Execute a previously approved XLM or token transfer. Call after check_approval returns 'approved'.")
async def execute_approved_transfer(to_account: str, amount: float, currency: str = "XLM", token_id: str = "") -> dict:
    result = await _api.request_transfer(
        to_account=to_account,
        amount=amount,
        currency=currency,
        token_id=token_id or None,
    )
    if result and "error" not in result:
        return {"status": "completed", "to": to_account, "amount": amount, "result": result}
    return result or {"error": "Transfer execution failed"}


@tool("get_pulse_balance", "Check Pulse token balance for a specific account via Mirror Node")
async def get_pulse_balance(account_id: str, token_id: str) -> dict:
    kit = _get_kit()
    await kit.initialize()
    return await kit.get_token_balance(account_id, token_id)
