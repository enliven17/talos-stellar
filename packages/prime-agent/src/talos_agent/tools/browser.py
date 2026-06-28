"""Browser tools — Stagehand-powered GTM actions on local Chrome."""

from __future__ import annotations

import asyncio
import functools
from typing import TYPE_CHECKING, Any, Callable

from rich.console import Console

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.adapters.registry import AdapterRegistry
    from talos_agent.browser.session import BrowserSession
    from talos_agent.config import Settings

console = Console()

# Injected by registry.build_all_tools
_browser: BrowserSession = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]
_adapter_registry: AdapterRegistry = None  # type: ignore[assignment]

BROWSER_TIMEOUT = 90  # seconds per browser action


def _browser_safe(fn: Callable) -> Callable:
    """Wrap a browser tool with timeout, error handling, and auto-reconnect."""

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> dict:
        if _browser is None:
            return {"error": "Browser session not initialized"}
        try:
            return await asyncio.wait_for(fn(*args, **kwargs), timeout=BROWSER_TIMEOUT)
        except asyncio.TimeoutError:
            return {"error": f"Browser action timed out after {BROWSER_TIMEOUT}s"}
        except Exception as e:
            err_name = type(e).__name__
            if "session" in str(e).lower() or "closed" in str(e).lower() or "500" in str(e):
                try:
                    # Reset session-dependent state on all adapters that track login
                    if _adapter_registry:
                        x_adapter = _adapter_registry.get("X")
                        if x_adapter and hasattr(x_adapter, "_logged_in"):
                            x_adapter._logged_in = False
                    await _browser.reconnect()
                    return await asyncio.wait_for(fn(*args, **kwargs), timeout=BROWSER_TIMEOUT)
                except Exception as retry_err:
                    return {"error": f"Browser reconnect failed: {type(retry_err).__name__}: {retry_err}"}
            return {"error": f"Browser error ({err_name}): {e}"}

    return wrapper


async def _dismiss_cookie_banner() -> None:
    """Dismiss a generic cookie consent banner (Google, etc.)."""
    try:
        await _browser.act(
            "Click the 'Accept all cookies' button at the bottom of the page. "
            "It is a dark button with white text that says 'Accept all cookies'."
        )
        await asyncio.sleep(2)
    except Exception:
        pass


# ── General browser tools ────────────────────────────────────────────────────

@tool("search_web", "Search Google and return top results for market research")
@_browser_safe
async def search_web(query: str) -> dict:
    import urllib.parse
    search_url = f"https://www.google.com/search?q={urllib.parse.quote_plus(query)}&hl=en"
    await _browser.goto(search_url)
    await asyncio.sleep(3)
    await _dismiss_cookie_banner()
    results = await _browser.extract(
        "Extract the title, URL, and summary snippet of the top 5 search results",
    )
    return {"query": query, "results": results}


@tool("browse_page", "Visit a URL and extract information based on instructions")
@_browser_safe
async def browse_page(url: str, instruction: str) -> dict:
    await _browser.goto(url)
    data = await _browser.extract(instruction)
    return {"url": url, "data": data}


# ── Legacy X (Twitter) tools — delegate to XAdapter ─────────────────────────
# These exist for backward compatibility with prompts that reference X-specific
# tool names. New code should use publish_content / get_publishing_channels.

@tool("post_to_x", "Post a tweet on X (Twitter). Content MUST be under 280 characters, plain text only.")
@_browser_safe
async def post_to_x(content: str) -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    result = await adapter.post(content)
    return result.to_dict()


@tool("check_x_mentions", "Check X notifications/mentions and return unread items")
@_browser_safe
async def check_x_mentions() -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    mentions = await adapter.get_mentions()
    return {"mentions": mentions}


@tool("reply_on_x", "Reply to a specific tweet on X")
@_browser_safe
async def reply_on_x(tweet_url: str, content: str) -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    result = await adapter.reply(tweet_url, content)
    return result.to_dict()


@tool("search_x", "Search X for keywords and extract relevant posts")
@_browser_safe
async def search_x(query: str) -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    results = await adapter.search(query)
    return {"query": query, "results": results}


@tool(
    "check_post_performance",
    "Check engagement metrics (likes, reposts, replies, impressions) for a recently posted tweet. "
    "Navigates to the user's profile and extracts metrics for the matching post.",
)
@_browser_safe
async def check_post_performance(content_snippet: str) -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    return await adapter.get_post_performance(content_snippet)


@tool(
    "get_profile_stats",
    "Get current X profile stats: follower count, following count, total posts.",
)
@_browser_safe
async def get_profile_stats() -> dict:
    adapter = _adapter_registry.get("X") if _adapter_registry else None
    if not adapter:
        return {"error": "X adapter not configured"}
    return await adapter.get_profile_stats()
