"""Stellar operations — delegates to Web API.

The Prime Agent never holds Stellar private keys. All on-chain operations
(balance queries, token transfers, dividends) go through the Talos Web
server, which uses Stellar SDK server-side or reads from Horizon.

Failures are classified with :mod:`talos_agent.payments.stellar_retry` so that
callers and operators can decide deterministically whether a transaction is
safe to retry.  The returned classification is privacy-safe: no exception
text, seeds, payment proofs, or response bodies are ever surfaced.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from rich.console import Console

from talos_agent.adapters.snapshots import StellarHealthSnapshot
from talos_agent.http import request_with_retry
from talos_agent.payments.stellar_retry import (
    attach_stellar_failure,
    classify_stellar_failure,
    classify_stellar_result,
)

_HORIZON_URL = os.getenv("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org")

#: Default timeout (seconds) for Horizon HTTP requests.
_DEFAULT_HORIZON_TIMEOUT = 30.0

console = Console()


class StellarKit:
    """Proxy for Stellar operations via Talos Web API.

    Read operations use Stellar Horizon (public, no key needed).
    Write operations are forwarded to Web, which handles signing.

    A single :class:`httpx.AsyncClient` is created during :meth:`initialize`
    and reused across all Horizon requests so that connection pooling and TLS
    sessions are shared.  The client is closed in :meth:`close`, which must
    be awaited during graceful shutdown.
    """

    def __init__(self, api_client: Any, *, horizon_timeout: float = _DEFAULT_HORIZON_TIMEOUT):
        self._api = api_client
        self._initialized = False
        self._horizon_timeout = horizon_timeout
        self._client: httpx.AsyncClient | None = None

    async def initialize(self) -> None:
        if self._initialized:
            return
        self._client = httpx.AsyncClient(timeout=self._horizon_timeout)
        self._initialized = True
        console.print("[green]Stellar proxy ready (via Web API + Horizon).[/green]")

    async def close(self) -> None:
        """Close the shared Horizon HTTP client.

        Must be awaited during graceful shutdown to avoid unclosed-client
        warnings and to release the underlying connection pool cleanly.
        """
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._initialized = False

    @property
    def available(self) -> bool:
        return self._initialized

    def health_snapshot(self) -> StellarHealthSnapshot:
        """Return in-process readiness snapshot for health probes (side-effect free)."""
        return StellarHealthSnapshot(
            has_api=self._api is not None,
            initialized=bool(self._initialized),
        )

    async def get_balance(self, account_id: str = "") -> dict[str, Any]:
        """Query XLM balance via Horizon (public API)."""
        try:
            talos = await self._api.get_talos(self._api._talos_id)
            acct = account_id or (talos.get("stellarAccountId", "") if talos else "")
            if not acct:
                return {"error": "No Stellar account configured"}
            # Reuse the shared client; fall back to a temporary one if not
            # initialized (e.g. called in tests without initialize()).
            client = self._client or httpx.AsyncClient(timeout=self._horizon_timeout)
            close_after = self._client is None
            try:
                r = await request_with_retry(
                    lambda: client.get(f"{_HORIZON_URL}/accounts/{acct}"),
                    provider="talos_web_api",
                )
            finally:
                if close_after:
                    await client.aclose()
            if r.status_code == 200:
                data = r.json()
                balance = data.get("balances", [])
                xlm_balance = next((b for b in balance if b.get("asset_type") == "native"), None)
                if xlm_balance:
                    return {"balance_xlm": float(xlm_balance["balance"]), "account": acct}
                return {"balance_xlm": 0, "account": acct}
            return attach_stellar_failure(
                None,
                classify_stellar_failure(status_code=r.status_code),
            )
        except Exception as exc:
            return attach_stellar_failure(
                None,
                classify_stellar_failure(exc=exc),
            )

    async def get_token_balance(self, account_id: str, token_id: str) -> dict[str, Any]:
        """Query Stellar asset balance via Horizon."""
        try:
            client = self._client or httpx.AsyncClient(timeout=self._horizon_timeout)
            close_after = self._client is None
            try:
                r = await request_with_retry(
                    lambda: client.get(f"{_HORIZON_URL}/accounts/{account_id}"),
                    provider="talos_web_api",
                )
            finally:
                if close_after:
                    await client.aclose()
            if r.status_code == 200:
                data = r.json()
                balances = data.get("balances", [])
                token_balance = next((b for b in balances if b.get("asset_code") == token_id), None)
                balance = float(token_balance["balance"]) if token_balance else 0
                return {"balance": balance, "token_id": token_id, "account": account_id}
            return attach_stellar_failure(
                None,
                classify_stellar_failure(status_code=r.status_code),
            )
        except Exception as exc:
            return attach_stellar_failure(
                None,
                classify_stellar_failure(exc=exc),
            )

    async def transfer_xlm(self, to_account: str, amount: float) -> dict[str, Any]:
        """Request XLM transfer via Web API (Web handles signing).

        On failure the returned dict carries ``error`` plus the bounded
        classification fields (``failure_class``, ``failure_code``,
        ``retryable``, ``indeterminate``, ``terminal``).  On success it keeps
        the historical ``{"status": "submitted", ...}`` shape.
        """
        try:
            result = await self._api.request_transfer(
                to_account=to_account, amount=amount, currency="XLM"
            )
        except Exception as exc:
            return attach_stellar_failure(None, classify_stellar_failure(exc=exc))

        failure = classify_stellar_result(result)
        if failure is not None:
            return attach_stellar_failure(result, failure)

        if result:
            return {"status": "submitted", "to": to_account, "amount": amount}

        # Empty response with no error payload — surface an unclassified failure.
        return attach_stellar_failure(None, classify_stellar_failure())
