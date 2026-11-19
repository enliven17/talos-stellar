"""SSRF guard for outbound URL access in the prime-agent.

Only ``http`` and ``https`` schemes are allowed. Hostnames are resolved via
DNS and rejected when they point at loopback, link-local, private, or
cloud-metadata ranges.

Usage::

    from talos_agent.security.ssrf import assert_public_url

    await assert_public_url(url)      # raises BlockedURLError on violation
    # …or check without raising:
    ok, reason = await is_public_url(url)

Environment
-----------
``SSRF_ALLOWED_HOSTS``
    Comma-separated list of hostnames (exact match, case-insensitive) that
    bypass the IP check. Intended for local-development or test overrides
    only (e.g. ``localhost,mock-server``). Never set in production.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from typing import Optional

# ---------------------------------------------------------------------------
# Blocked network ranges — keep in sync with web/src/lib/security/ssrf.ts
# ---------------------------------------------------------------------------
_BLOCKED_NETWORKS: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = [
    # Loopback
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv6Network("::1/128"),
    # Unspecified
    ipaddress.IPv4Network("0.0.0.0/8"),
    # Private (RFC 1918)
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    # Link-local / APIPA
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv6Network("fe80::/10"),
    # Unique local (ULA)
    ipaddress.IPv6Network("fc00::/7"),
    # Cloud-provider metadata endpoints
    ipaddress.IPv4Network("100.64.0.0/10"),   # CGNAT / AWS metadata
]

_ALLOWED_SCHEMES = {"http", "https"}

# Optional allowlist for dev/test (never populated in production).
_SSRF_ALLOWED_HOSTS: frozenset[str] = frozenset(
    h.strip().lower()
    for h in os.getenv("SSRF_ALLOWED_HOSTS", "").split(",")
    if h.strip()
)


class BlockedURLError(ValueError):
    """Raised when a URL is blocked by the SSRF guard."""

    def __init__(self, message: str, url: str = "") -> None:
        super().__init__(message)
        self.url = url
        self.reason = message


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_blocked_ip(addr: str) -> bool:
    """Return True if *addr* falls within a blocked network range."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        # Not a valid IP — treat as blocked to be safe.
        return True
    return any(ip in net for net in _BLOCKED_NETWORKS)


def _resolve_addresses(hostname: str) -> list[str]:
    """Synchronously resolve *hostname* to a list of IP address strings.

    Uses :func:`socket.getaddrinfo` so both A and AAAA records are returned.
    Raises :class:`BlockedURLError` if DNS resolution fails.
    """
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
        return [info[4][0] for info in infos]
    except socket.gaierror as exc:
        raise BlockedURLError(f"DNS resolution failed for '{hostname}': {exc}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_public_url_sync(url: str) -> tuple[bool, Optional[str]]:
    """Synchronous variant of :func:`is_public_url`.

    Returns ``(True, None)`` when *url* is allowed, or
    ``(False, reason_string)`` when it is blocked.
    """
    # ── 1. Parse URL ────────────────────────────────────────────────────────
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
    except Exception as exc:
        return False, f"URL parse error: {exc}"

    # ── 2. Scheme check ─────────────────────────────────────────────────────
    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        return False, f"Scheme '{scheme}' is not allowed; only http and https are permitted"

    hostname = parsed.hostname or ""
    if not hostname:
        return False, "URL has no hostname"

    # ── 3. Allowlist bypass (dev/test only) ─────────────────────────────────
    if hostname.lower() in _SSRF_ALLOWED_HOSTS:
        return True, None

    # ── 4. Direct IP literal check ──────────────────────────────────────────
    try:
        _ = ipaddress.ip_address(hostname)
        # It's an IP literal — check it directly without DNS.
        if _is_blocked_ip(hostname):
            return False, f"IP address '{hostname}' is in a restricted range"
        return True, None
    except ValueError:
        pass  # Not an IP literal; proceed to DNS resolution.

    # ── 5. DNS resolution check ─────────────────────────────────────────────
    try:
        addresses = _resolve_addresses(hostname)
    except BlockedURLError as exc:
        return False, str(exc)

    for addr in addresses:
        if _is_blocked_ip(addr):
            return False, (
                f"Hostname '{hostname}' resolves to '{addr}' which is in a restricted range"
            )

    return True, None


async def is_public_url(url: str) -> tuple[bool, Optional[str]]:
    """Async-compatible URL guard.

    Delegates to :func:`is_public_url_sync` (DNS resolution is synchronous
    via the stdlib; acceptable for an infrequent security check).  Returns
    ``(True, None)`` when *url* is safe, or ``(False, reason)`` when blocked.
    """
    return is_public_url_sync(url)


async def assert_public_url(url: str) -> None:
    """Raise :class:`BlockedURLError` if *url* must not be loaded.

    This is the primary entry point for browser/HTTP tools.

    :raises BlockedURLError: when the URL scheme is disallowed, the hostname
        resolves to a private/loopback/metadata IP, or DNS resolution fails.
    """
    allowed, reason = await is_public_url(url)
    if not allowed:
        raise BlockedURLError(reason or "URL is blocked", url=url)
