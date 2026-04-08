"""Browser tools — Stagehand-powered GTM actions on local Chrome."""

from __future__ import annotations

import asyncio
import functools
from typing import TYPE_CHECKING, Any, Callable

from rich.console import Console

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.browser.session import BrowserSession
    from talos_agent.config import Settings

console = Console()

# Injected by registry.build_all_tools
_browser: BrowserSession = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]

BROWSER_TIMEOUT = 90  # seconds per browser action
_x_logged_in = False
_cookie_dismissed = False


async def _ensure_x_login() -> None:
    """Navigate to X and log in if not already authenticated."""
    global _x_logged_in, _cookie_dismissed
    if _x_logged_in:
        return

    if not _settings or not _settings.x_username or not _settings.x_password:
        console.print("[yellow]X credentials not configured — skipping login.[/yellow]")
        return

    console.print("[dim]Checking X login status...[/dim]")
    await _browser.goto("https://x.com/home")
    await asyncio.sleep(3)

    # Dismiss cookie banner once (this IS a page DOM element)
    if not _cookie_dismissed:
        await _dismiss_cookie_banner()
        _cookie_dismissed = True

    page_info = await _browser.extract(
        "Is the user logged in to X/Twitter? "
        "If you see a compose/post box or timeline feed → logged_in: true. "
        "If you see a login form, sign-in button, or 'Sign in' text → logged_in: false.",
        schema={"type": "object", "properties": {"logged_in": {"type": "boolean"}}, "required": ["logged_in"]},
    )

    is_logged_in = bool(page_info.get("logged_in")) if isinstance(page_info, dict) else False

    if is_logged_in:
        console.print("[green]Already logged in to X.[/green]")
        _x_logged_in = True
        if not _cookie_dismissed:
            await _dismiss_cookie_banner()
            _cookie_dismissed = True
        return

    console.print("[bold]Logging in to X...[/bold]")

    await _browser.goto("https://x.com/i/flow/login")
    await asyncio.sleep(4)

    await _browser.act(f"Click on the username or email input field and type: {_settings.x_username}")
    await asyncio.sleep(2)
    await _browser.act("Click the Next button")
    await asyncio.sleep(4)

    # X sometimes asks for email/phone verification before password
    verification_check = await _browser.extract(
        "What is the current page asking for? "
        "If it asks for email or phone verification → type: 'verification'. "
        "If it shows a password field → type: 'password'. "
        "If it shows something else → type: 'other'.",
        schema={"type": "object", "properties": {"type": {"type": "string"}}, "required": ["type"]},
    )

    page_type = verification_check.get("type", "other") if isinstance(verification_check, dict) else "other"

    if page_type == "verification" and _settings.x_email:
        await _browser.act(f"Click on the input field and type: {_settings.x_email}")
        await asyncio.sleep(1)
        await _browser.act("Click the Next button")
        await asyncio.sleep(4)

    await _browser.act(f"Click on the password input field and type: {_settings.x_password}")
    await asyncio.sleep(1)
    await _browser.act("Click the Log in button")
    await asyncio.sleep(5)

    post_login = await _browser.extract(
        "Is the user now logged in to X/Twitter? "
        "If you see a timeline, home feed, or compose button → logged_in: true. "
        "Otherwise → logged_in: false.",
        schema={"type": "object", "properties": {"logged_in": {"type": "boolean"}}, "required": ["logged_in"]},
    )

    success = bool(post_login.get("logged_in")) if isinstance(post_login, dict) else False

    if success:
        console.print("[bold green]Successfully logged in to X.[/bold green]")
        _x_logged_in = True
    else:
        console.print("[red]X login may have failed — continuing anyway.[/red]")


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
                    global _x_logged_in
                    _x_logged_in = False
                    await _browser.reconnect()
                    return await asyncio.wait_for(fn(*args, **kwargs), timeout=BROWSER_TIMEOUT)
                except Exception as retry_err:
                    return {"error": f"Browser reconnect failed: {type(retry_err).__name__}: {retry_err}"}
            return {"error": f"Browser error ({err_name}): {e}"}

    return wrapper


def _x_login_required(fn: Callable) -> Callable:
    """Ensure X login before executing the wrapped tool."""

    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> dict:
        await _ensure_x_login()
        return await fn(*args, **kwargs)

    return wrapper


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


async def _dismiss_cookie_banner() -> None:
    """Dismiss X's cookie consent banner. Always attempts the click without checking first."""
    try:
        await _browser.act(
            "Click the 'Accept all cookies' button at the bottom of the page. "
            "It is a dark button with white text that says 'Accept all cookies'."
        )
        await asyncio.sleep(2)
    except Exception:
        pass


@tool("browse_page", "Visit a URL and extract information based on instructions")
@_browser_safe
async def browse_page(url: str, instruction: str) -> dict:
    await _browser.goto(url)
    data = await _browser.extract(instruction)
    return {"url": url, "data": data}


@tool("post_to_x", "Post a tweet on X (Twitter). Content MUST be under 280 characters, plain text only.")
@_browser_safe
@_x_login_required
async def post_to_x(content: str) -> dict:
    if len(content) > 280:
        return {"error": f"Post is {len(content)} chars — exceeds 280 char limit. Shorten it and try again."}

    # Dismiss cookie banner first — it can block interactions
    await _dismiss_cookie_banner()

    # Use Playwright keyboard directly — bypasses Stagehand LLM entirely
    # Step 1: Press 'N' to open compose modal (X keyboard shortcut)
    await _browser.keyboard_press("n")
    await asyncio.sleep(2)

    # Step 2: Type content (text area is auto-focused by X after pressing N)
    await _browser.keyboard_type(content)
    await asyncio.sleep(2)

    # Step 3: Press Ctrl+Enter to post (X keyboard shortcut)
    await _browser.keyboard_press("Control+Enter")
    await asyncio.sleep(4)

    # Step 4: Verify — if modal closed, post succeeded
    verify = await _browser.extract(
        "Is there a compose tweet dialog/modal currently open on the page? "
        "If no dialog is open and you see the timeline → dialog_open: false. "
        "If the compose dialog is still visible with text → dialog_open: true.",
        schema={"type": "object", "properties": {"dialog_open": {"type": "boolean"}}, "required": ["dialog_open"]},
    )

    dialog_open = bool(verify.get("dialog_open")) if isinstance(verify, dict) else True
    if dialog_open:
        # Close modal: Escape → Discard (no beforeunload from modal)
        try:
            await _browser.act("Press the Escape key")
            await asyncio.sleep(1)
            await _browser.act("Click the 'Discard' button")
        except Exception:
            pass
        return {"error": "Post failed — compose dialog still open. Tweet was NOT published."}

    return {"status": "posted", "content": content, "channel": "X"}


@tool("check_x_mentions", "Check X notifications/mentions and return unread items")
@_browser_safe
@_x_login_required
async def check_x_mentions() -> dict:
    await _browser.goto("https://x.com/notifications/mentions")
    await asyncio.sleep(2)
    mentions = await _browser.extract(
        "Extract the latest 10 mentions: author handle, text content, tweet URL, and timestamp"
    )
    return {"mentions": mentions}


@tool("reply_on_x", "Reply to a specific tweet on X")
@_browser_safe
@_x_login_required
async def reply_on_x(tweet_url: str, content: str) -> dict:
    await _browser.goto(tweet_url)
    await asyncio.sleep(2)
    await _browser.act("Click the reply button")
    await _browser.act(f"Type the following reply: {content}")
    await _browser.act("Click the Reply button to post")
    return {"status": "replied", "tweet_url": tweet_url, "content": content}


@tool("search_x", "Search X for keywords and extract relevant posts")
@_browser_safe
@_x_login_required
async def search_x(query: str) -> dict:
    await _browser.goto(f"https://x.com/search?q={query}&src=typed_query&f=live")
    await asyncio.sleep(2)
    results = await _browser.extract(
        "Extract the top 10 posts: author handle, text content, engagement (likes, reposts), and tweet URL"
    )
    return {"query": query, "results": results}


@tool(
    "check_post_performance",
    "Check engagement metrics (likes, reposts, replies, impressions) for a recently posted tweet. "
    "Navigates to the user's profile and extracts metrics for the matching post.",
)
@_browser_safe
@_x_login_required
async def check_post_performance(content_snippet: str) -> dict:
    username = _settings.x_username if _settings else ""
    if not username:
        return {"error": "X username not configured"}

    await _browser.goto(f"https://x.com/{username}")
    await asyncio.sleep(3)

    metrics = await _browser.extract(
        f"Find the tweet that contains the text similar to: '{content_snippet[:80]}'. "
        "Extract: likes (number), reposts/retweets (number), replies (number), "
        "views/impressions (number), and the tweet URL. "
        "If not found, return found: false.",
        schema={
            "type": "object",
            "properties": {
                "found": {"type": "boolean"},
                "likes": {"type": "integer"},
                "reposts": {"type": "integer"},
                "replies": {"type": "integer"},
                "impressions": {"type": "integer"},
                "tweet_url": {"type": "string"},
            },
            "required": ["found"],
        },
    )
    return metrics if isinstance(metrics, dict) else {"found": False}


@tool(
    "get_profile_stats",
    "Get current X profile stats: follower count, following count, total posts.",
)
@_browser_safe
@_x_login_required
async def get_profile_stats() -> dict:
    username = _settings.x_username if _settings else ""
    if not username:
        return {"error": "X username not configured"}

    await _browser.goto(f"https://x.com/{username}")
    await asyncio.sleep(3)

    stats = await _browser.extract(
        "Extract the profile stats: followers count (number), following count (number), "
        "total posts count (number).",
        schema={
            "type": "object",
            "properties": {
                "followers": {"type": "integer"},
                "following": {"type": "integer"},
                "total_posts": {"type": "integer"},
            },
            "required": ["followers"],
        },
    )
    return stats if isinstance(stats, dict) else {"error": "Could not extract profile stats"}
