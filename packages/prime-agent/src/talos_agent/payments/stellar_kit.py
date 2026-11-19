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
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx
from rich.console import Console
from stellar_sdk import StrKey

from talos_agent.adapters.snapshots import StellarHealthSnapshot
from talos_agent.http import request_with_retry
from talos_agent.payments import (
    USDC_MAINNET_ISSUER,
    USDC_TESTNET_ISSUER,
)
from talos_agent.payments.stellar_retry import (
    StellarRetryClass,
    attach_stellar_failure,
    classify_stellar_failure,
    classify_stellar_result,
)

_HORIZON_URL = os.getenv("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org")
_SEVEN_DECIMALS = Decimal("0.0000001")

#: Default timeout (seconds) for Horizon HTTP requests.
_DEFAULT_HORIZON_TIMEOUT = 30.0


def _validate_account_id(account_id: str) -> bool:
    """Return True if *account_id* is a valid Stellar account identifier.

    Accepts classic Ed25519 public keys (G…) and muxed accounts (M…).
    Rejects anything else — empty strings, path-traversal fragments, secret
    keys, contract IDs, etc. — so that callers never interpolate untrusted
    input into a Horizon URL.
    """
    return StrKey.is_valid_ed25519_public_key(account_id) or StrKey.is_valid_med25519_public_key(account_id)


console = Console()


def to_stellar_amount(value: Decimal | float | int | str) -> Decimal:
    """Parse a numeric or string value to Decimal with exact precision.

    Float inputs are converted via str(value) to avoid binary float artifacts
    where possible, while Decimal and string inputs retain exact precision.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, str)):
        return Decimal(str(value).strip())
    # float input
    return Decimal(str(value))


def format_stellar_amount(amount: Decimal | float | int | str) -> str:
    """Serialize an on-chain Stellar amount as a string with exactly 7 decimal places."""
    d = to_stellar_amount(amount)
    return f"{d.quantize(_SEVEN_DECIMALS):f}"


class StellarKit:
    """Proxy for Stellar operations via Talos Web API.

    Read operations use Stellar Horizon (public, no key needed).
    Write operations are forwarded to Web, which handles signing.

    A single :class:`httpx.AsyncClient` is created during :meth:`initialize`
    and reused across all Horizon requests so that connection pooling and TLS
    sessions are shared.  The client is closed in :meth:`close`, which must
    be awaited during graceful shutdown.
    """

    def __init__(
        self,
        api_client: Any,
        *,
        horizon_timeout: float = _DEFAULT_HORIZON_TIMEOUT,
        usdc_issuer: str | None = None,
    ):
        self._api = api_client
        self._initialized = False
        self._horizon_timeout = horizon_timeout
        self._client: httpx.AsyncClient | None = None
        self._usdc_issuer = usdc_issuer

    def resolve_usdc_issuer(self) -> str:
        """Resolve the configured USDC issuer account ID."""
        if self._usdc_issuer is not None:
            return self._usdc_issuer.strip()
        settings = getattr(self._api, "_settings", None) or getattr(self._api, "settings", None)
        if settings is not None:
            configured = getattr(settings, "stellar_usdc_issuer", None)
            if isinstance(configured, str) and configured.strip():
                return configured.strip()
        env_issuer = os.getenv("STELLAR_USDC_ISSUER") or os.getenv("NEXT_PUBLIC_STELLAR_USDC_ISSUER")
        if env_issuer and env_issuer.strip():
            return env_issuer.strip()
        network = os.getenv("STELLAR_NETWORK", "").lower()
        horizon_url = os.getenv("STELLAR_HORIZON_URL", _HORIZON_URL)
        if network == "mainnet" or ("horizon.stellar.org" in horizon_url and "testnet" not in horizon_url):
            return USDC_MAINNET_ISSUER
        return USDC_TESTNET_ISSUER

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
            if not _validate_account_id(acct):
                return {"error": "invalid_account", "account": acct}
            # Reuse the shared client; fall back to a temporary one if not
            # initialized (e.g. called in tests without initialize()).
            client = self._client or httpx.AsyncClient(timeout=self._horizon_timeout)
            close_after = self._client is None
            try:
                r = await request_with_retry(
                    lambda: client.get(f"{_HORIZON_URL}/accounts/{acct}"),
                    provider="stellar_horizon",
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

    async def get_token_balance(
        self,
        account_id: str,
        token_id: str,
        issuer: str | None = None,
    ) -> dict[str, Any]:
        """Query Stellar asset balance via Horizon.

        Matches by both asset code and asset issuer.
        token_id may be 'CODE' or 'CODE:ISSUER'. An explicit issuer argument
        can also be provided. For 'USDC', the issuer defaults to the configured
        asset setting when omitted.
        """
        try:
            token_id = (token_id or "").strip()
            if not token_id:
                return {
                    "error": "Invalid token identifier: empty token_id",
                    "error_code": "invalid_identifier",
                    "token_id": token_id,
                    "account": account_id,
                    "failure_class": StellarRetryClass.PERMANENT.value,
                    "failure_code": "invalid_identifier",
                    "retryable": False,
                    "indeterminate": False,
                    "terminal": True,
                }

            if not account_id:
                return {"error": "No Stellar account configured"}

            # Parse CODE[:ISSUER]
            parsed_code: str
            parsed_issuer: str | None = None
            if ":" in token_id:
                parts = token_id.split(":")
                if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
                    return {
                        "error": f"Invalid token identifier '{token_id}': expected CODE:ISSUER format",
                        "error_code": "invalid_identifier",
                        "token_id": token_id,
                        "account": account_id,
                        "failure_class": StellarRetryClass.PERMANENT.value,
                        "failure_code": "invalid_identifier",
                        "retryable": False,
                        "indeterminate": False,
                        "terminal": True,
                    }
                parsed_code = parts[0].strip()
                parsed_issuer = parts[1].strip()
            else:
                parsed_code = token_id

            explicit_issuer = issuer.strip() if (issuer is not None and issuer.strip()) else None

            # Detect conflicting issuer arguments
            if parsed_issuer and explicit_issuer and parsed_issuer != explicit_issuer:
                return {
                    "error": (
                        f"Conflicting issuer specifications for asset '{parsed_code}': "
                        f"'{parsed_issuer}' in token_id vs '{explicit_issuer}' in argument"
                    ),
                    "error_code": "conflicting_issuer",
                    "token_id": token_id,
                    "account": account_id,
                    "asset_code": parsed_code,
                    "failure_class": StellarRetryClass.PERMANENT.value,
                    "failure_code": "conflicting_issuer",
                    "retryable": False,
                    "indeterminate": False,
                    "terminal": True,
                }

            target_issuer = explicit_issuer or parsed_issuer
            if not target_issuer and parsed_code.upper() == "USDC":
                default_issuer = self.resolve_usdc_issuer()
                if default_issuer:
                    target_issuer = default_issuer

            client = self._client or httpx.AsyncClient(timeout=self._horizon_timeout)
            close_after = self._client is None
            try:
                r = await request_with_retry(
                    lambda: client.get(f"{_HORIZON_URL}/accounts/{account_id}"),
                    provider="stellar_horizon",
                )
            finally:
                if close_after:
                    await client.aclose()

            if r.status_code == 200:
                data = r.json()
                balances = data.get("balances", [])

                code_matches = [
                    b for b in balances
                    if b.get("asset_code") == parsed_code
                    or (isinstance(b.get("asset_code"), str) and b.get("asset_code").upper() == parsed_code.upper())
                ]

                if target_issuer:
                    matching = [
                        b for b in code_matches
                        if b.get("asset_issuer") == target_issuer
                    ]
                    if len(matching) > 1:
                        return {
                            "error": (
                                f"Ambiguous balances: multiple balances match code '{parsed_code}' "
                                f"and issuer '{target_issuer}'"
                            ),
                            "error_code": "ambiguous_asset",
                            "token_id": token_id,
                            "account": account_id,
                            "asset_code": parsed_code,
                            "asset_issuer": target_issuer,
                            "matching_issuers": [target_issuer],
                            "failure_class": StellarRetryClass.PERMANENT.value,
                            "failure_code": "ambiguous_asset",
                            "retryable": False,
                            "indeterminate": False,
                            "terminal": True,
                        }
                    balance = float(matching[0]["balance"]) if matching else 0.0
                    return {
                        "balance": balance,
                        "token_id": token_id,
                        "account": account_id,
                        "asset_code": parsed_code,
                        "asset_issuer": target_issuer,
                    }

                # When target_issuer is not specified:
                if len(code_matches) > 1:
                    matching_issuers = [b.get("asset_issuer", "") for b in code_matches if b.get("asset_issuer")]
                    return {
                        "error": (
                            f"Ambiguous token identifier '{token_id}': multiple assets match code "
                            f"'{parsed_code}' with different issuers. Specify issuer as CODE:ISSUER or pass issuer."
                        ),
                        "error_code": "ambiguous_asset",
                        "token_id": token_id,
                        "account": account_id,
                        "asset_code": parsed_code,
                        "matching_issuers": matching_issuers,
                        "failure_class": StellarRetryClass.PERMANENT.value,
                        "failure_code": "ambiguous_asset",
                        "retryable": False,
                        "indeterminate": False,
                        "terminal": True,
                    }

                if len(code_matches) == 1:
                    single = code_matches[0]
                    balance = float(single.get("balance", 0))
                    matched_issuer = single.get("asset_issuer")
                    return {
                        "balance": balance,
                        "token_id": token_id,
                        "account": account_id,
                        "asset_code": parsed_code,
                        "asset_issuer": matched_issuer,
                    }

                return {
                    "balance": 0.0,
                    "token_id": token_id,
                    "account": account_id,
                    "asset_code": parsed_code,
                    "asset_issuer": None,
                }

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
            dec_amount = to_stellar_amount(amount)
            formatted_amount = format_stellar_amount(dec_amount)
            result = await self._api.request_transfer(
                to_account=to_account, amount=formatted_amount, currency="XLM"
            )
        except Exception as exc:
            return attach_stellar_failure(None, classify_stellar_failure(exc=exc))

        failure = classify_stellar_result(result)
        if failure is not None:
            return attach_stellar_failure(result, failure)

        if result:
            return {"status": "submitted", "to": to_account, "amount": formatted_amount}

        # Empty response with no error payload — surface an unclassified failure.
        return attach_stellar_failure(None, classify_stellar_failure())
