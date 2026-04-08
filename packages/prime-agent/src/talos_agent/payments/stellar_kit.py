"""Stellar operations — delegates to Web API.

The Prime Agent never holds Stellar private keys. All on-chain operations
(balance queries, token transfers, dividends) go through the Talos Web
server, which uses Stellar SDK server-side or reads from Horizon.
"""

from __future__ import annotations

import os
from typing import Any

from rich.console import Console

_HORIZON_URL = os.getenv("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org")

console = Console()


class StellarKit:
    """Proxy for Stellar operations via Talos Web API.

    Read operations use Stellar Horizon (public, no key needed).
    Write operations are forwarded to Web, which handles signing.
    """

    def __init__(self, api_client: Any):
        self._api = api_client
        self._initialized = False

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        console.print("[green]Stellar proxy ready (via Web API + Horizon).[/green]")

    @property
    def available(self) -> bool:
        return self._initialized

    async def get_balance(self, account_id: str = "") -> dict[str, Any]:
        """Query XLM balance via Horizon (public API)."""
        try:
            talos = await self._api.get_talos(self._api._talos_id)
            acct = account_id or (talos.get("stellarAccountId", "") if talos else "")
            if not acct:
                return {"error": "No Stellar account configured"}
            # Horizon is public — no auth needed
            import httpx
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    f"{_HORIZON_URL}/accounts/{acct}"
                )
                if r.status_code == 200:
                    data = r.json()
                    balance = data.get("balances", [])
                    xlm_balance = next((b for b in balance if b.get("asset_type") == "native"), None)
                    if xlm_balance:
                        return {"balance_xlm": float(xlm_balance["balance"]), "account": acct}
                    return {"balance_xlm": 0, "account": acct}
            return {"error": "Horizon query failed"}
        except Exception as e:
            return {"error": f"Balance query failed: {e}"}

    async def get_token_balance(self, account_id: str, token_id: str) -> dict[str, Any]:
        """Query Stellar asset balance via Horizon."""
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                r = await client.get(
                    f"{_HORIZON_URL}/accounts/{account_id}",
                )
                if r.status_code == 200:
                    data = r.json()
                    balances = data.get("balances", [])
                    token_balance = next((b for b in balances if b.get("asset_code") == token_id), None)
                    balance = float(token_balance["balance"]) if token_balance else 0
                    return {"balance": balance, "token_id": token_id, "account": account_id}
            return {"error": "Horizon query failed"}
        except Exception as e:
            return {"error": f"Token balance query failed: {e}"}

    async def transfer_xlm(self, to_account: str, amount: float) -> dict[str, Any]:
        """Request XLM transfer via Web API (Web handles signing)."""
        try:
            result = await self._api.request_transfer(
                to_account=to_account, amount=amount, currency="XLM"
            )
            if result:
                return {"status": "submitted", "to": to_account, "amount": amount}
            return {"error": "Transfer request failed"}
        except Exception as e:
            return {"error": f"Transfer failed: {e}"}
