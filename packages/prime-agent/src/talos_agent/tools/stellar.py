"""Stellar tools — internal economy (Pulse tokens, XLM dividends, governance).

All operations are proxied through the Talos Web API or read from
Stellar Horizon. The Agent never holds private keys.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from talos_agent.payments.stellar_kit import StellarKit
from talos_agent.payments.stellar_retry import (
    attach_stellar_failure,
    classify_stellar_failure,
    classify_stellar_result,
)
from talos_agent.tools import context as _context
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings

# Injected by registry.build_all_tools
_settings: Settings = None  # type: ignore[assignment]
_api: TalosAPIClient = None  # type: ignore[assignment]
_stellar_kit: StellarKit | None = None


def _deps():
    """This agent's dependencies: the bound ToolContext, else this module's globals."""
    return _context.resolve(globals())


def _get_kit() -> StellarKit:
    deps = _deps()
    if deps.stellar_kit is None:
        deps.stellar_kit = StellarKit(deps.api)
    return deps.stellar_kit


@tool("transfer_xlm", "Transfer XLM to a Stellar account (dividends, payments). Auto-checks approval threshold.")
async def transfer_xlm(to_account: str, amount: float | str, reason: str = "") -> dict:
    kit = _get_kit()
    await kit.initialize()

    # Check threshold
    threshold = float(_deps().settings.approval_threshold)
    if amount > threshold:
        result = await _deps().api.create_approval(
            _deps().settings.talos_id,
            type_="transaction",
            title=f"XLM transfer: {formatted_amount} to {to_account}",
            description=reason,
            amount=float(formatted_amount),
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "amount": formatted_amount,
            "to": to_account,
        }

    return await kit.transfer_xlm(to_account, formatted_amount)


@tool("get_xlm_balance", "Check XLM balance for the Talos account via Horizon")
async def get_xlm_balance() -> dict:
    kit = _get_kit()
    await kit.initialize()
    return await kit.get_balance()


@tool("create_pulse_token", "Request Pulse (equity) token creation. Name must be 1-32 characters and symbol 1-12 alphanumeric characters. Requires Creator approval on Dashboard.")
async def create_pulse_token(name: str, symbol: str, initial_supply: int = 1000000) -> dict:
    if not name.strip() or len(name) > 32:
        return {"error": "name must be between 1 and 32 characters"}
    if re.fullmatch(r"[A-Za-z0-9]{1,12}", symbol) is None:
        return {"error": "symbol must be 1-12 alphanumeric characters"}
    if initial_supply <= 0:
        return {"error": "initial_supply must be greater than 0"}

    result = await _deps().api.create_approval(
        _deps().settings.talos_id,
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


_AIRDROP_MAX_RECIPIENTS = 200  # Hard cap per call to prevent runaway loops


def _validate_airdrop_recipients(recipient_list: list) -> tuple[list, str | None]:
    """Validate each recipient entry and return (validated_list, error_message).

    Rules:
    - ``recipient_list`` must be a list (not dict/str/etc.).
    - Each entry must be a dict with a valid Stellar G… account and a
      positive, finite, numeric ``amount`` (no negative, zero, or NaN values).
    - The entire call is rejected if *any* entry is invalid (fail-closed).
    - The number of recipients is capped at _AIRDROP_MAX_RECIPIENTS.

    The threshold total is computed from the *validated* list only — callers
    cannot lower it with negative entries that are subsequently skipped.
    """
    import math as _math

    if not isinstance(recipient_list, list):
        return [], "recipients must be a JSON array of objects"

    if len(recipient_list) == 0:
        return [], "recipients list must not be empty"

    if len(recipient_list) > _AIRDROP_MAX_RECIPIENTS:
        return [], (
            f"recipients list exceeds the per-call cap of {_AIRDROP_MAX_RECIPIENTS}; "
            "split into smaller batches"
        )

    from talos_agent.payments.stellar_kit import _validate_account_id

    validated: list[dict] = []
    for idx, entry in enumerate(recipient_list):
        if not isinstance(entry, dict):
            return [], f"recipients[{idx}]: each entry must be a JSON object"

        acct = entry.get("account", "")
        if not isinstance(acct, str) or not _validate_account_id(acct):
            return [], (
                f"recipients[{idx}]: 'account' must be a valid Stellar G… address "
                f"(got {acct!r})"
            )

        raw_amt = entry.get("amount")
        if raw_amt is None:
            return [], f"recipients[{idx}]: 'amount' is required"

        # Accept int/float/Decimal/str but reject booleans (bool is a subtype of int).
        if isinstance(raw_amt, bool):
            return [], f"recipients[{idx}]: 'amount' must be a number, got boolean"

        try:
            amt = float(raw_amt)
        except (TypeError, ValueError):
            return [], f"recipients[{idx}]: 'amount' must be numeric, got {raw_amt!r}"

        if not _math.isfinite(amt):
            return [], f"recipients[{idx}]: 'amount' must be a finite number, got {raw_amt!r}"

        if amt <= 0:
            return [], (
                f"recipients[{idx}]: 'amount' must be positive (got {raw_amt!r}); "
                "negative and zero amounts are not allowed"
            )

        validated.append({"account": acct, "amount": amt})

    return validated, None


@tool("airdrop_pulse", "Distribute Pulse tokens to Patron Stellar accounts (G... addresses). Requires Creator approval for large amounts.")
async def airdrop_pulse(token_id: str, recipients: str) -> dict:
    """recipients: JSON string of [{"account": "G...", "amount": 1000}, ...]."""
    import json as _json
    try:
        recipient_list = _json.loads(recipients) if isinstance(recipients, str) else recipients
    except _json.JSONDecodeError:
        return {"error": 'recipients must be valid JSON: [{"account": "G...", "amount": N}, ...]'}

    # --- Security: validate all entries before touching the threshold calc ---
    validated, err = _validate_airdrop_recipients(recipient_list)
    if err is not None:
        return {"error": err}

    # Threshold total computed from validated entries only; negative amounts
    # in the raw list cannot suppress the approval gate.
    total_amount = sum(r["amount"] for r in validated)
    threshold = float(_deps().settings.approval_threshold)

    if total_amount > threshold:
        result = await _deps().api.create_approval(
            _deps().settings.talos_id,
            type_="transaction",
            title=f"Pulse airdrop: token {token_id}, total {total_amount}",
            description=f"Recipients: {len(validated)} accounts",
            amount=total_amount,
        )
        return {
            "status": "approval_requested",
            "approval_id": result.get("id") if result else None,
            "action": "airdrop_pulse",
        }

    # Execute transfers via Web API (all entries already validated above)
    results = []
    for r in validated:
        acct = r["account"]
        amt = r["amount"]
        res = await _deps().api.request_transfer(
            to_account=acct, amount=amt, currency="native", token_id=token_id
        )
        failure = classify_stellar_result(res)
        if failure is not None:
            # Surface a bounded classification instead of raw server text.
            res = attach_stellar_failure(res, failure)
        results.append({"account": acct, "amount": amt, "result": res})
    return {"status": "completed", "transfers": results}


@tool("execute_approved_transfer", "Execute a previously approved XLM or token transfer. Call after check_approval returns 'approved'.")
async def execute_approved_transfer(to_account: str, amount: float, currency: str = "XLM", token_id: str = "") -> dict:
    result = await _deps().api.request_transfer(
        to_account=to_account,
        amount=amount,
        currency=currency,
        token_id=token_id or None,
    )
    failure = classify_stellar_result(result)
    if failure is not None:
        # Retryable / indeterminate / terminal metadata is additive; ``error``
        # carries a privacy-safe message rather than raw upstream text.
        return attach_stellar_failure(result, failure)
    if result:
        return {"status": "completed", "to": to_account, "amount": amount, "result": result}
    return attach_stellar_failure(None, classify_stellar_failure())


@tool("get_pulse_balance", "Check Pulse token balance for a specific Stellar G... account via Horizon")
async def get_pulse_balance(account_id: str, token_id: str) -> dict:
    kit = _get_kit()
    await kit.initialize()
    return await kit.get_token_balance(account_id, token_id)
