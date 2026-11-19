"""Tests for the SSRF guard (issue #895).

Verifies that browse_page and the underlying ssrf module block disallowed
schemes, private/loopback/metadata IP ranges, and pass public URLs through.

DNS resolution is mocked so tests are fully offline and deterministic.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from talos_agent.security.ssrf import (
    BlockedURLError,
    assert_public_url,
    is_public_url,
    is_public_url_sync,
)


# ══════════════════════════════════════════════════════════════════════════════
# Helper
# ══════════════════════════════════════════════════════════════════════════════

def _make_getaddrinfo_mock(ip: str):
    """Return a mock that mimics socket.getaddrinfo resolving to *ip*."""
    def _mock(host, port, **kwargs):  # noqa: ANN001
        # getaddrinfo returns list of (family, type, proto, canonname, sockaddr)
        # sockaddr for IPv4 is (address, port); for IPv6 (address, port, flow, scope)
        if ":" in ip:
            return [(10, 1, 6, "", (ip, 0, 0, 0))]
        return [(2, 1, 6, "", (ip, 0))]
    return _mock


# ══════════════════════════════════════════════════════════════════════════════
# Scheme blocking
# ══════════════════════════════════════════════════════════════════════════════

class TestSchemeBlocking:
    """Non-http(s) schemes must be rejected without any DNS call."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_url", [
        "file:///etc/passwd",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        "ftp://example.com/file.txt",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "gopher://evil.example.com",
        "ldap://evil.example.com",
        "smb://192.168.1.1/share",
    ])
    async def test_blocked_scheme_never_reaches_browser(self, bad_url: str):
        allowed, reason = await is_public_url(bad_url)
        assert not allowed
        assert reason is not None
        assert "scheme" in reason.lower() or "not allowed" in reason.lower()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad_url", [
        "file:///etc/passwd",
        "ftp://example.com/file.txt",
        "javascript:alert(1)",
    ])
    async def test_assert_public_url_raises_on_bad_scheme(self, bad_url: str):
        with pytest.raises(BlockedURLError):
            await assert_public_url(bad_url)


# ══════════════════════════════════════════════════════════════════════════════
# IP range blocking (with mocked DNS)
# ══════════════════════════════════════════════════════════════════════════════

class TestIPRangeBlocking:
    """Loopback, private, link-local, and metadata ranges must be blocked."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("hostname,resolved_ip", [
        # Loopback
        ("localhost", "127.0.0.1"),
        ("loopback.example.com", "127.0.0.1"),
        ("loopback6.example.com", "::1"),
        # Link-local / metadata
        ("metadata.example.com", "169.254.169.254"),   # AWS / GCP / Azure metadata
        ("apipa.example.com", "169.254.1.1"),
        # Private ranges
        ("internal.corp", "10.0.0.1"),
        ("corporate.lan", "172.16.0.1"),
        ("homelab.local", "192.168.1.1"),
        # CGNAT / AWS metadata secondary
        ("shared-nat.example.com", "100.64.0.1"),
    ])
    async def test_private_ip_blocked(self, hostname: str, resolved_ip: str):
        url = f"http://{hostname}/"
        with patch("talos_agent.security.ssrf.socket.getaddrinfo",
                   side_effect=_make_getaddrinfo_mock(resolved_ip)):
            allowed, reason = await is_public_url(url)

        assert not allowed, f"Expected {url!r} to be blocked (resolves to {resolved_ip})"
        assert reason is not None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url", [
        "http://127.0.0.1/",
        "http://127.0.0.1:8080/admin",
        "http://0.0.0.0/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "https://169.254.169.254/metadata/v1/",
        "http://[::1]/",
        "http://[fe80::1]/",
        "http://100.64.0.1/",
    ])
    async def test_direct_ip_literal_blocked(self, url: str):
        """IP literals in URLs are blocked without DNS lookup."""
        # No DNS mock needed — these are IP literals
        allowed, reason = await is_public_url(url)
        assert not allowed, f"Expected {url!r} to be blocked"
        assert reason is not None

    @pytest.mark.asyncio
    async def test_assert_public_url_raises_for_metadata_endpoint(self):
        with pytest.raises(BlockedURLError) as exc_info:
            await assert_public_url("http://169.254.169.254/latest/meta-data/")
        assert exc_info.value.url == "http://169.254.169.254/latest/meta-data/"


# ══════════════════════════════════════════════════════════════════════════════
# Public URLs pass through
# ══════════════════════════════════════════════════════════════════════════════

class TestPublicURLsAllowed:
    """Legitimate public URLs must be allowed."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url,resolved_ip", [
        ("https://example.com/", "93.184.216.34"),
        ("https://www.google.com/search?q=stellar", "142.250.80.36"),
        ("http://openai.com/", "104.18.6.49"),
        ("https://horizon-testnet.stellar.org/accounts/GABC", "104.21.0.1"),
    ])
    async def test_public_url_allowed(self, url: str, resolved_ip: str):
        with patch("talos_agent.security.ssrf.socket.getaddrinfo",
                   side_effect=_make_getaddrinfo_mock(resolved_ip)):
            allowed, reason = await is_public_url(url)

        assert allowed, f"Expected {url!r} to be allowed, got reason: {reason}"
        assert reason is None

    @pytest.mark.asyncio
    async def test_assert_public_url_does_not_raise_for_public_host(self):
        with patch("talos_agent.security.ssrf.socket.getaddrinfo",
                   side_effect=_make_getaddrinfo_mock("93.184.216.34")):
            # Should not raise
            await assert_public_url("https://example.com/path?q=1")


# ══════════════════════════════════════════════════════════════════════════════
# DNS failure handling
# ══════════════════════════════════════════════════════════════════════════════

class TestDNSFailure:
    """DNS failures must be treated as blocked (fail-closed)."""

    @pytest.mark.asyncio
    async def test_dns_failure_blocks_url(self):
        import socket
        with patch("talos_agent.security.ssrf.socket.getaddrinfo",
                   side_effect=socket.gaierror("Name or service not known")):
            allowed, reason = await is_public_url("http://nonexistent.invalid/")

        assert not allowed
        assert reason is not None


# ══════════════════════════════════════════════════════════════════════════════
# browse_page integration
# ══════════════════════════════════════════════════════════════════════════════

class TestBrowsePageSSRFGuard:
    """browse_page must return a blocked_url error without touching the browser."""

    def _make_mock_browser(self):
        """Return a mock BrowserSession that fails if goto is called."""
        mock_browser = MagicMock()
        mock_browser.goto = AsyncMock(side_effect=AssertionError("goto must not be called for blocked URLs"))
        mock_browser.extract = AsyncMock(return_value="some data")
        return mock_browser

    @pytest.mark.asyncio
    @pytest.mark.parametrize("blocked_url", [
        "file:///etc/passwd",
        "http://127.0.0.1/admin",
        "http://0.0.0.0/",
        "https://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "ftp://example.com/",
        "http://192.168.1.1/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
    ])
    async def test_blocked_url_returns_error_without_calling_browser(self, blocked_url: str):
        """browse_page must not call _browser.goto for any blocked URL."""
        import talos_agent.tools.browser as browser_module

        original_browser = browser_module._browser
        try:
            browser_module._browser = self._make_mock_browser()

            result = await browser_module.browse_page(blocked_url, "Extract page content")

            # Must return a structured error
            assert result.get("error") == "blocked_url", (
                f"Expected 'blocked_url' error for {blocked_url!r}, got: {result}"
            )
            assert "reason" in result

            # Crucially: goto must NOT have been called
            browser_module._browser.goto.assert_not_called()

        finally:
            browser_module._browser = original_browser

    @pytest.mark.asyncio
    async def test_public_url_reaches_browser(self):
        """browse_page passes public URLs through to the browser."""
        import talos_agent.tools.browser as browser_module

        mock_browser = MagicMock()
        mock_browser.goto = AsyncMock(return_value=None)
        mock_browser.extract = AsyncMock(return_value="page content")

        original_browser = browser_module._browser
        try:
            browser_module._browser = mock_browser

            with patch("talos_agent.security.ssrf.socket.getaddrinfo",
                       side_effect=_make_getaddrinfo_mock("93.184.216.34")):
                result = await browser_module.browse_page(
                    "https://example.com/", "Extract headline"
                )

            assert result.get("url") == "https://example.com/"
            assert result.get("data") == "page content"
            mock_browser.goto.assert_called_once_with("https://example.com/")

        finally:
            browser_module._browser = original_browser
