"""Web API client — all communication between Local Agent and Talos Web."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from talos_agent import metrics
from talos_agent.config import Settings
from talos_agent.http import RetryableHTTPError, request_with_retry
from talos_agent.tracing import inject_trace_headers, traced_span
from opentelemetry.trace import SpanKind

_NO_KEY = object()
_MAX_PAGINATION_PAGES = 1_000


class PaginationError(ValueError):
    """Raised when a paginated API response cannot be consumed safely."""


@dataclass(frozen=True)
class PaginatedPage:
    """One cursor-based API page, preserving the server response order."""

    items: list[dict[str, Any]]
    next_cursor: str | None


class TalosAPIClient:
    def __init__(self, settings: Settings):
        self._base = settings.talos_api_url.rstrip("/")
        self._talos_id = settings.talos_id
        self._client = httpx.AsyncClient(
            base_url=self._base,
            headers={
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )
        self._settings = settings

    def _request_headers(self, supplied: dict[str, str] | None = None) -> dict[str, str]:
        """Capture one credential for the complete retry lifecycle of a request."""
        headers = {"Authorization": f"Bearer {self._settings.secret_value('talos_api_key')}"}
        headers.update(supplied or {})
        return headers

    # ── Retry-wrapped, traced HTTP verbs ──────────────────

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Single choke point for all Web API calls: span + trace-header
        injection + retry-count/status metrics, on top of the existing
        request_with_retry backoff. Every public method below funnels
        through this instead of calling httpx directly.
        """
        path = urlsplit(url).path or url
        start = time.monotonic()
        retry_count = 0

        with traced_span(
            f"web_api.{method} {path}",
            {"http.request.method": method, "url.path": path},
            kind=SpanKind.CLIENT,
        ) as span:
            # Inject only after the span above is current, so the
            # traceparent we send actually points at *this* span.
            headers = dict(kwargs.pop("headers", None) or {})
            inject_trace_headers(headers)
            kwargs["headers"] = headers

            send = getattr(self._client, method.lower())
            response: httpx.Response | None = None
            status_code = 0
            try:

                async def _do_send() -> httpx.Response:
                    nonlocal retry_count
                    if retry_count > 0:
                        span.add_event("http.retry", {"http.retry.count": retry_count})
                    retry_count += 1
                    return await send(url, **kwargs)

                response = await request_with_retry(_do_send)
                status_code = response.status_code
                span.set_attribute("http.response.status_code", status_code)
                span.set_attribute("http.retry.count", max(0, retry_count - 1))
                return response
            except RetryableHTTPError as exc:
                status_code = exc.status_code
                span.set_attribute("http.response.status_code", status_code)
                span.set_attribute("http.retry.count", max(0, retry_count - 1))
                raise
            finally:
                metrics.record_http_call(
                    status_code, max(0, retry_count - 1), time.monotonic() - start
                )

    async def _get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await request_with_retry(lambda: self._client.get(url, **kwargs), provider="talos_web_api")

    async def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        idempotency_key = kwargs.pop("idempotency_key", _NO_KEY)
        if idempotency_key is not _NO_KEY and idempotency_key:
            headers = dict(kwargs.pop("headers", {}) or {})
            headers["Idempotency-Key"] = str(idempotency_key)
            kwargs["headers"] = headers
        return await request_with_retry(lambda: self._client.post(url, **kwargs), provider="talos_web_api")

    async def _put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await request_with_retry(lambda: self._client.put(url, **kwargs), provider="talos_web_api")

    async def _patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return await request_with_retry(lambda: self._client.patch(url, **kwargs), provider="talos_web_api")

    async def _get_cursor_page(
        self,
        url: str,
        *,
        item_key: str,
        params: dict[str, Any] | None = None,
        cursor: str | None = None,
        page_size: int | None = None,
    ) -> PaginatedPage:
        """Fetch and validate one cursor-based page from a collection endpoint."""
        query = dict(params or {})
        if cursor is not None:
            query["cursor"] = cursor
        if page_size is not None:
            query["limit"] = page_size

        response = await self._get(url, params=query)
        if response.status_code != 200:
            raise PaginationError(f"pagination request failed with status {response.status_code}")

        try:
            payload = response.json()
        except (TypeError, ValueError) as exc:
            raise PaginationError("pagination response was not valid JSON") from exc

        # Older deployments returned a bare list.  It is a complete, single page
        # and remains supported by the existing list methods.
        if isinstance(payload, list):
            items = payload
            next_cursor = None
        elif isinstance(payload, dict):
            if item_key not in payload or "nextCursor" not in payload:
                raise PaginationError("pagination response is missing required fields")
            items = payload[item_key]
            next_cursor = payload["nextCursor"]
        else:
            raise PaginationError("pagination response has an unexpected shape")

        if not isinstance(items, list) or not all(isinstance(item, dict) for item in items):
            raise PaginationError("pagination response contains invalid items")
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
            raise PaginationError("pagination response contains an invalid next cursor")
        return PaginatedPage(items=items, next_cursor=next_cursor)

    async def _get_all_cursor_pages(
        self,
        url: str,
        *,
        item_key: str,
        params: dict[str, Any] | None = None,
        page_size: int | None = None,
        max_pages: int = _MAX_PAGINATION_PAGES,
    ) -> list[dict[str, Any]]:
        """Traverse cursor pages with bounds, loop detection, and de-duplication."""
        if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages < 1:
            raise ValueError("max_pages must be a positive integer")

        items: list[dict[str, Any]] = []
        seen_cursors: set[str] = set()
        seen_items: set[str] = set()
        cursor: str | None = None

        for _ in range(max_pages):
            page = await self._get_cursor_page(
                url,
                item_key=item_key,
                params=params,
                cursor=cursor,
                page_size=page_size,
            )
            for item in page.items:
                # API list records have IDs; talosId is the stable identifier on
                # marketplace records.  Reject a duplicate rather than silently
                # returning it twice when a continuation regresses.
                identifier = item.get("id", item.get("talosId"))
                if not isinstance(identifier, str) or not identifier:
                    raise PaginationError("pagination item is missing a stable identifier")
                if identifier in seen_items:
                    raise PaginationError("pagination response contains a duplicate item")
                seen_items.add(identifier)
                items.append(item)

            next_cursor = page.next_cursor
            if next_cursor is None:
                return items
            if next_cursor in seen_cursors or next_cursor == cursor:
                raise PaginationError("pagination response repeated a cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        raise PaginationError("pagination exceeded the maximum page count")

    # ── Talos Config ──────────────────────────────────────

    async def get_talos(self, talos_id: str) -> dict | None:
        r = await self._get(f"/api/talos/{talos_id}")
        if r.status_code == 200:
            return r.json()
        return None

    async def get_talos_me(self) -> dict | None:
        """Resolve Talos from API key — no Talos ID needed."""
        r = await self._get("/api/talos/me")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Activity Reporting ─────────────────────────────────

    async def report_activity(
        self,
        talos_id: str,
        *,
        type_: str,
        content: str,
        channel: str,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        r = await self._post(
            f"/api/talos/{talos_id}/activity",
            json={"type": type_, "content": content, "channel": channel},
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Status ─────────────────────────────────────────────

    async def update_status(self, talos_id: str, *, online: bool) -> None:
        # Status updates are fire-and-forget; no idempotency key needed.
        await self._patch(
            f"/api/talos/{talos_id}/status",
            json={"agentOnline": online},
            idempotency_key=None,
        )

    # ── Revenue ────────────────────────────────────────────

    async def report_revenue(
        self,
        talos_id: str,
        *,
        amount: float,
        source: str,
        tx_hash: str | None = None,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        r = await self._post(
            f"/api/talos/{talos_id}/revenue",
            json={"amount": amount, "currency": "USDC", "source": source, "txHash": tx_hash},
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Approvals ──────────────────────────────────────────

    async def create_approval(
        self,
        talos_id: str,
        *,
        type_: str,
        title: str,
        description: str | None = None,
        amount: float | None = None,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        r = await self._post(
            f"/api/talos/{talos_id}/approvals",
            json={"type": type_, "title": title, "description": description, "amount": amount},
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def get_approvals_page(
        self,
        talos_id: str,
        status: str | None = None,
        *,
        cursor: str | None = None,
        page_size: int | None = None,
    ) -> PaginatedPage:
        """Get one approvals page using the API's opaque cursor."""
        params: dict[str, Any] = {}
        if status:
            params["status"] = status
        return await self._get_cursor_page(
            f"/api/talos/{talos_id}/approvals",
            item_key="approvals",
            params=params,
            cursor=cursor,
            page_size=page_size,
        )

    async def get_all_approvals(
        self,
        talos_id: str,
        status: str | None = None,
        *,
        page_size: int | None = None,
        max_pages: int = _MAX_PAGINATION_PAGES,
    ) -> list[dict[str, Any]]:
        """Get all approvals in API order, stopping at the final cursor."""
        params: dict[str, Any] = {}
        if status:
            params["status"] = status
        return await self._get_all_cursor_pages(
            f"/api/talos/{talos_id}/approvals",
            item_key="approvals",
            params=params,
            page_size=page_size,
            max_pages=max_pages,
        )

    async def get_approvals(self, talos_id: str, status: str | None = None) -> list[dict]:
        """Compatibility wrapper returning all approval pages as one list."""
        return await self.get_all_approvals(talos_id, status)

    async def get_approval(self, talos_id: str, approval_id: str) -> dict | None:
        r = await self._get(f"/api/talos/{talos_id}/approvals/{approval_id}")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Agent Wallet (Circle MPC) ────────────────────────────

    async def get_agent_wallet(self) -> dict | None:
        """Fetch agent wallet info (walletId, address) from Web."""
        r = await self._get(f"/api/talos/{self._talos_id}/wallet")
        if r.status_code == 200:
            return r.json()
        return None

    async def create_agent_wallet(self) -> dict | None:
        """Create a Circle MPC wallet for this Talos if one doesn't exist."""
        r = await self._post(f"/api/talos/{self._talos_id}/wallet", idempotency_key=None)
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def sign_payment(
        self,
        *,
        payee: str,
        amount: int,
        asset_code: str = "USDC",
        asset_issuer: str | None = None,
    ) -> dict | None:
        """Request x402 payment signature from Web's Stellar proxy."""
        if not self._talos_id:
            return {"error": "talos_id not set"}
        payload: dict[str, Any] = {"payee": payee, "amount": amount, "assetCode": asset_code}
        if asset_issuer:
            payload["assetIssuer"] = asset_issuer
        # sign_payment is not a state-mutating write; opt out of idempotency.
        r = await self._post(f"/api/talos/{self._talos_id}/sign", json=payload, idempotency_key=None)
        if r.status_code == 200:
            return r.json()
        # Return error details
        try:
            return r.json()
        except Exception:
            return {"error": f"Sign request failed with status {r.status_code}"}

    # ── Commerce / x402 ────────────────────────────────────

    async def get_service(self, talos_id: str, service_type: str | None = None) -> httpx.Response:
        """GET service endpoint — expects 402 response with payment details."""
        params = {}
        if service_type:
            params["type"] = service_type
        return await self._get(f"/api/talos/{talos_id}/service", params=params)

    async def submit_commerce(
        self,
        talos_id: str,
        *,
        payment_header: str,
        payload: dict | None = None,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        """POST with x402 payment signature to purchase service."""
        r = await self._post(
            f"/api/talos/{talos_id}/service",
            json={"payload": payload},
            headers={"X-PAYMENT": payment_header},
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        # Return error details instead of None
        try:
            return r.json()
        except Exception:
            return {"error": f"Commerce submission failed with status {r.status_code}"}

    async def discover_services_page(
        self,
        category: str | None = None,
        target: str | None = None,
        *,
        cursor: str | None = None,
        page_size: int | None = None,
    ) -> PaginatedPage:
        """Get one marketplace-services page using the API's opaque cursor."""
        params: dict[str, Any] = {"self": self._talos_id}
        if category:
            params["category"] = category
        if target:
            params["target"] = target
        return await self._get_cursor_page(
            "/api/services",
            item_key="data",
            params=params,
            cursor=cursor,
            page_size=page_size,
        )

    async def discover_all_services(
        self,
        category: str | None = None,
        target: str | None = None,
        *,
        page_size: int | None = None,
        max_pages: int = _MAX_PAGINATION_PAGES,
    ) -> list[dict[str, Any]]:
        """Get all marketplace services in API order, stopping at the final cursor."""
        params: dict[str, Any] = {"self": self._talos_id}
        if category:
            params["category"] = category
        if target:
            params["target"] = target
        return await self._get_all_cursor_pages(
            "/api/services",
            item_key="data",
            params=params,
            page_size=page_size,
            max_pages=max_pages,
        )

    async def discover_services(
        self, category: str | None = None, target: str | None = None
    ) -> list[dict]:
        """Compatibility wrapper returning all marketplace pages as one list."""
        return await self.discover_all_services(category, target)

    async def register_service(
        self,
        talos_id: str,
        *,
        service_name: str,
        description: str,
        price: float,
        wallet_address: str | None = None,
    ) -> dict | None:
        """Register or update this Talos's x402 service on the marketplace."""
        payload: dict[str, Any] = {
            "serviceName": service_name,
            "description": description,
            "price": price,
        }
        if wallet_address:
            payload["walletAddress"] = wallet_address
        r = await self._put(f"/api/talos/{talos_id}/service", json=payload)
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Transfers (Stellar) ────────────────────────────────

    async def request_transfer(
        self,
        *,
        to_account: str,
        amount: float,
        currency: str = "XLM",
        token_id: str | None = None,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        """Execute XLM or Stellar asset transfer via Web API."""
        payload: dict[str, Any] = {
            "to": to_account,
            "amount": amount,
            "currency": currency,
        }
        if token_id:
            payload["tokenId"] = token_id
        r = await self._post(
            f"/api/talos/{self._talos_id}/transfer",
            json=payload,
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        try:
            return r.json()
        except Exception:
            return {"error": f"Transfer failed with status {r.status_code}"}

    # ── Jobs ───────────────────────────────────────────────

    async def get_pending_jobs(self) -> list[dict]:
        r = await self._get("/api/jobs/pending")
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, list) else data.get("jobs", [])
        return []

    async def claim_job(self, job_id: str, ttl_seconds: int = 300) -> dict | None:
        """Acquire a lease on a pending job. Returns the fencing token on success."""
        # claim_job is idempotent by the server's lease model; auto-inject a key.
        r = await self._post(
            f"/api/jobs/{job_id}/claim",
            json={"ttlSeconds": ttl_seconds},
        )
        if r.status_code == 200:
            return r.json()
        return None

    async def heartbeat_job(self, job_id: str, fencing_token: int) -> dict | None:
        """Extend the lease on a claimed job. Returns renewed expiry on success."""
        r = await self._post(
            f"/api/jobs/{job_id}/heartbeat",
            json={"fencingToken": fencing_token},
        )
        if r.status_code == 200:
            return r.json()
        return None

    async def release_job(self, job_id: str, fencing_token: int) -> dict | None:
        """Release a lease on a claimed job."""
        r = await self._post(
            f"/api/jobs/{job_id}/release",
            json={"fencingToken": fencing_token},
        )
        if r.status_code == 200:
            return r.json()
        return None

    async def submit_job_result(
        self,
        job_id: str,
        result: dict,
        fencing_token: int = 0,
        *,
        idempotency_key: str | None = None,
    ) -> dict | None:
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        r = await self._post(
            f"/api/jobs/{job_id}/result",
            json={"result": result, "fencingToken": fencing_token},
            headers=headers,
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    async def get_job_result(self, job_id: str) -> dict | None:
        r = await self._get(f"/api/jobs/{job_id}/result")
        if r.status_code == 200:
            return r.json()
        return None

    # ── Playbooks ──────────────────────────────────────────

    async def publish_playbook(
        self,
        *,
        title: str,
        category: str,
        channel: str,
        description: str,
        price: float,
        tags: list[str] | None = None,
        content: dict | None = None,
        impressions: int = 0,
        engagement_rate: float = 0,
        conversions: int = 0,
        period_days: int = 30,
        idempotency_key: str | None = _NO_KEY,  # type: ignore[assignment]
    ) -> dict | None:
        """Publish a Playbook to the marketplace."""
        r = await self._post(
            "/api/playbooks",
            json={
                "title": title,
                "category": category,
                "channel": channel,
                "description": description,
                "price": price,
                "tags": tags or [],
                "content": content,
                "impressions": impressions,
                "engagementRate": engagement_rate,
                "conversions": conversions,
                "periodDays": period_days,
            },
            idempotency_key=idempotency_key,
        )
        if r.status_code in (200, 201):
            return r.json()
        return None

    # ── Dividend Distribution ─────────────────────────────

    async def get_distribution_preview(self, talos_id: str) -> dict | None:
        """Preview dividend distribution without executing."""
        r = await self._get(f"/api/talos/{talos_id}/revenue/distribute")
        if r.status_code == 200:
            return r.json()
        return None

    async def distribute_dividends(
        self, talos_id: str, *, requester_public_key: str
    ) -> dict | None:
        """Execute dividend distribution to patrons."""
        r = await self._post(
            f"/api/talos/{talos_id}/revenue/distribute",
            json={"requesterPublicKey": requester_public_key},
        )
        if r.status_code in (200, 201):
            return r.json()
        try:
            return r.json()
        except Exception:
            return {"error": f"Distribution failed with status {r.status_code}"}

    # ── Lifecycle ──────────────────────────────────────────

    async def close(self) -> None:
        await self._client.aclose()

    def set_request_id(self, request_id: str) -> None:
        """Propagate cycle_id as X-Request-Id to web API calls."""
        self._client.headers["x-request-id"] = request_id
