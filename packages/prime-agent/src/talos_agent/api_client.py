"""Web API client — all communication between Local Agent and Talos Web."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from opentelemetry.trace import SpanKind

from talos_agent import metrics
from talos_agent.config import Settings
from talos_agent.http import (
    ResponseTooLargeError,
    RetryableHTTPError,
    request_with_retry,
)
from talos_agent.payments.stellar_retry import (
    attach_stellar_failure,
    classify_stellar_failure,
)
from talos_agent.idempotency import (
    IdempotencyConflictError,
    generate_idempotency_key,
    is_payload_conflict,
    validate_idempotency_key,
)
from talos_agent.tracing import inject_trace_headers, traced_span

_NO_KEY = object()
_MAX_PAGINATION_PAGES = 1_000


def _inject_key(
    idempotency_key: Any,  # str | None | _NO_KEY
) -> str | None:
    """Resolve the effective idempotency key for a write call.

    - ``_NO_KEY`` sentinel  → auto-generate a fresh UUID v4.
    - ``None``             → opt-out; no key injected.
    - Any string           → use as-is after validation.
    """
    if idempotency_key is _NO_KEY:
        return generate_idempotency_key()
    if idempotency_key is None:
        return None
    return validate_idempotency_key(idempotency_key)


def _check_idempotency_conflict(
    response: httpx.Response,
    key: str | None,
    path: str,
) -> None:
    """Raise :class:`IdempotencyConflictError` if the 409 is a payload conflict."""
    if response.status_code != 409 or key is None:
        return
    try:
        body = response.text
    except Exception:
        body = ""
    if is_payload_conflict(body):
        raise IdempotencyConflictError(key=key, path=path, body=body)


def _check_response_size(response: httpx.Response, limit_bytes: int) -> None:
    """Raise ResponseTooLargeError when the response body exceeds *limit_bytes*.

    The check is performed in two stages to fail as early as possible:

    1. **Content-Length header** — if the server declared a body size that
       already exceeds the limit, reject before reading a single byte.
    2. **Actual body size** — after the body is buffered by httpx, measure
       ``len(response.content)`` as the authoritative byte count.

    Privacy contract: neither the response body nor any header values are
    included in the error.  Only the URL path, measured size, and limit are
    recorded so that secrets, seeds, payment proofs, and media cannot leak.
    """
    try:
        url = str(response.request.url)
    except RuntimeError:
        url = str(response.url)

    # Stage 1: fast-reject on declared Content-Length.
    content_length_header = response.headers.get("content-length")
    if content_length_header is not None:
        try:
            declared = int(content_length_header)
        except ValueError:
            declared = None
        if declared is not None and declared > limit_bytes:
            raise ResponseTooLargeError(url, declared, limit_bytes)

    # Stage 2: measure the buffered body (authoritative).
    actual = len(response.content)
    if actual > limit_bytes:
        raise ResponseTooLargeError(url, actual, limit_bytes)


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
        max_bytes = getattr(settings, "api_client_response_max_bytes", None)
        self._response_max_bytes: int = (
            max_bytes if isinstance(max_bytes, int) and not isinstance(max_bytes, bool) else 1_048_576
        )

    def _request_headers(self, supplied: dict[str, str] | None = None) -> dict[str, str]:
        """Capture one credential for the complete retry lifecycle of a request."""
        headers = {"Authorization": f"Bearer {self._settings.secret_value('talos_api_key')}"}
        headers.update(supplied or {})
        return headers

    # ── Retry-wrapped, traced HTTP verbs ──────────────────

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Single choke point for all Web API calls: auth headers + idempotency
        key + circuit-breaker gating + span + trace-header injection +
        retry-count/status metrics, on top of the existing request_with_retry
        backoff. Every public method below funnels through this instead of
        calling httpx directly.
        """
        # Fire-and-forget verbs (status heartbeats) opt out via idempotency_key=None.
        idempotency_key = kwargs.pop("idempotency_key", _NO_KEY)
        key = _inject_key(idempotency_key)

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
            if key is not None:
                headers["Idempotency-Key"] = key
            headers.update(self._request_headers())
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

                response = await request_with_retry(_do_send, provider="talos_web_api")
                status_code = response.status_code
                _check_idempotency_conflict(response, key, url)
                _check_response_size(response, self._response_max_bytes)
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
        return await self._request("GET", url, **kwargs)

    async def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self._request("POST", url, **kwargs)

    async def _put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self._request("PUT", url, **kwargs)

    async def _patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self._request("PATCH", url, **kwargs)

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

    async de
