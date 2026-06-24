"""X (Twitter) channel adapter — browser-based posting via Stagehand."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from rich.console import Console

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult

if TYPE_CHECKING:
    from talos_agent.browser.session import BrowserSession
    from talos_agent.config import Settings

console = Console()

_CHAR_LIMIT = 280
_LOGIN_URL = "https://x.com/i/flow/login"
_HOME_URL = "https://x.com/home"
_MENTIONS_URL = "https://x.com/notifications/mentions"
_SEARCH_URL = "https://x.com/search?q={query}&src=typed_query&f=live"
_PROFILE_URL = "https://x.com/{username}"


class XAdapter(BaseSocialAdapter):
    """Publishes to X (Twitter) using Stagehand browser automation."""

    channel_name = "X"

    def __init__(self, browser: BrowserSession, settings: Settings) -> None:
        self._browser = browser
        self._settings = settings
        self._logged_in = False
        self._cookie_dismissed = False

    # ── Capabilities ─────────────────────────────────────────

    def get_capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            char_limit=_CHAR_LIMIT,
            supports_media=True,
            supports_threads=True,
            supports_replies=True,
            supports_search=True,
            supports_mentions=True,
            supports_analytics=True,
        )

    # ── Auth ─────────────────────────────────────────────────

    async def _dismiss_cookie_banner(self) -> None:
        try:
            await self._browser.act(
                "Click the 'Accept all cookies' button at the bottom of the page. "
                "It is a dark button with white text that says 'Accept all cookies'."
            )
            await asyncio.sleep(2)
        except Exception:
            pass

    async def _ensure_login(self) -> None:
        if self._logged_in:
            return

        if not self._settings.x_username or not self._settings.x_password:
            console.print("[yellow]X credentials not configured — skipping login.[/yellow]")
            return

        console.print("[dim]Checking X login status...[/dim]")
        await self._browser.goto(_HOME_URL)
        await asyncio.sleep(3)

        if not self._cookie_dismissed:
            await self._dismiss_cookie_banner()
            self._cookie_dismissed = True

        page_info = await self._browser.extract(
            "Is the user logged in to X/Twitter? "
            "If you see a compose/post box or timeline feed → logged_in: true. "
            "If you see a login form, sign-in button, or 'Sign in' text → logged_in: false.",
            schema={"type": "object", "properties": {"logged_in": {"type": "boolean"}}, "required": ["logged_in"]},
        )
        if isinstance(page_info, dict) and page_info.get("logged_in"):
            console.print("[green]Already logged in to X.[/green]")
            self._logged_in = True
            return

        console.print("[bold]Logging in to X...[/bold]")
        await self._browser.goto(_LOGIN_URL)
        await asyncio.sleep(4)

        await self._browser.act(
            f"Click on the username or email input field and type: {self._settings.x_username}"
        )
        await asyncio.sleep(2)
        await self._browser.act("Click the Next button")
        await asyncio.sleep(4)

        # X sometimes requests email/phone verification before the password step
        check = await self._browser.extract(
            "What is the current page asking for? "
            "email or phone verification → type: 'verification'. "
            "password field → type: 'password'. "
            "something else → type: 'other'.",
            schema={"type": "object", "properties": {"type": {"type": "string"}}, "required": ["type"]},
        )
        page_type = check.get("type", "other") if isinstance(check, dict) else "other"
        if page_type == "verification" and self._settings.x_email:
            await self._browser.act(
                f"Click on the input field and type: {self._settings.x_email}"
            )
            await asyncio.sleep(1)
            await self._browser.act("Click the Next button")
            await asyncio.sleep(4)

        await self._browser.act(
            f"Click on the password input field and type: {self._settings.x_password}"
        )
        await asyncio.sleep(1)
        await self._browser.act("Click the Log in button")
        await asyncio.sleep(5)

        post_login = await self._browser.extract(
            "Is the user now logged in to X/Twitter? "
            "If you see a timeline, home feed, or compose button → logged_in: true. "
            "Otherwise → logged_in: false.",
            schema={"type": "object", "properties": {"logged_in": {"type": "boolean"}}, "required": ["logged_in"]},
        )
        if isinstance(post_login, dict) and post_login.get("logged_in"):
            console.print("[bold green]Successfully logged in to X.[/bold green]")
            self._logged_in = True
        else:
            console.print("[red]X login may have failed — continuing anyway.[/red]")

    # ── Publishing ───────────────────────────────────────────

    async def post(self, content: str, **kwargs) -> PublishResult:
        valid, error = self.validate_content(content)
        if not valid:
            return PublishResult(status="failed", channel=self.channel_name, content=content, error=error)

        await self._ensure_login()
        await self._dismiss_cookie_banner()

        # Use Playwright keyboard shortcuts directly — bypasses Stagehand LLM overhead
        await self._browser.keyboard_press("n")
        await asyncio.sleep(2)
        await self._browser.keyboard_type(content)
        await asyncio.sleep(2)
        await self._browser.keyboard_press("Control+Enter")
        await asyncio.sleep(4)

        verify = await self._browser.extract(
            "Is there a compose tweet dialog/modal currently open on the page? "
            "If no dialog is open and you see the timeline → dialog_open: false. "
            "If the compose dialog is still visible with text → dialog_open: true.",
            schema={"type": "object", "properties": {"dialog_open": {"type": "boolean"}}, "required": ["dialog_open"]},
        )
        dialog_open = bool(verify.get("dialog_open")) if isinstance(verify, dict) else True
        if dialog_open:
            try:
                await self._browser.act("Press the Escape key")
                await asyncio.sleep(1)
                await self._browser.act("Click the 'Discard' button")
            except Exception:
                pass
            return PublishResult(
                status="failed",
                channel=self.channel_name,
                content=content,
                error="Post failed — compose dialog still open. Tweet was NOT published.",
            )

        return PublishResult(status="posted", channel=self.channel_name, content=content)

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        await self._ensure_login()
        await self._browser.goto(target_url)
        await asyncio.sleep(2)
        await self._browser.act("Click the reply button")
        await self._browser.act(f"Type the following reply: {content}")
        await self._browser.act("Click the Reply button to post")
        return PublishResult(
            status="posted",
            channel=self.channel_name,
            content=content,
            metadata={"target_url": target_url},
        )

    # ── Discovery ────────────────────────────────────────────

    async def get_mentions(self, **kwargs) -> list[dict]:
        await self._ensure_login()
        await self._browser.goto(_MENTIONS_URL)
        await asyncio.sleep(2)
        result = await self._browser.extract(
            "Extract the latest 10 mentions: author handle, text content, tweet URL, and timestamp"
        )
        return result if isinstance(result, list) else []

    async def search(self, query: str, **kwargs) -> list[dict]:
        await self._ensure_login()
        await self._browser.goto(_SEARCH_URL.format(query=query))
        await asyncio.sleep(2)
        results = await self._browser.extract(
            "Extract the top 10 posts: author handle, text content, engagement (likes, reposts), and tweet URL"
        )
        return results if isinstance(results, list) else []

    # ── Analytics ────────────────────────────────────────────

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        await self._ensure_login()
        username = self._settings.x_username
        if not username:
            return {"error": "X username not configured"}
        await self._browser.goto(_PROFILE_URL.format(username=username))
        await asyncio.sleep(3)
        metrics = await self._browser.extract(
            f"Find the tweet that contains text similar to: '{content_snippet[:80]}'. "
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

    async def get_profile_stats(self, **kwargs) -> dict:
        await self._ensure_login()
        username = self._settings.x_username
        if not username:
            return {"error": "X username not configured"}
        await self._browser.goto(_PROFILE_URL.format(username=username))
        await asyncio.sleep(3)
        stats = await self._browser.extract(
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
