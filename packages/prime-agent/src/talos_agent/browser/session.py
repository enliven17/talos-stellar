"""Stagehand browser session — manages local Chrome connection with auto-reconnect."""

from __future__ import annotations

import asyncio
import json
import subprocess

from rich.console import Console
from stagehand import Stagehand

from talos_agent.config import APP_DIR, Settings

console = Console()

CHROME_PROFILE_DIR = str(APP_DIR / "chrome-profile")
(APP_DIR / "chrome-profile").mkdir(parents=True, exist_ok=True)

# Write Chrome preferences to disable password manager and beforeunload prompts
_prefs_dir = APP_DIR / "chrome-profile" / "Default"
_prefs_dir.mkdir(parents=True, exist_ok=True)
_prefs_file = _prefs_dir / "Preferences"
_prefs: dict = {}
if _prefs_file.exists():
    try:
        _prefs = json.loads(_prefs_file.read_text())
    except Exception:
        _prefs = {}
_prefs.setdefault("credentials_enable_service", False)
_prefs.setdefault("profile", {})
_prefs["profile"]["password_manager_leak_detection"] = False
_prefs["profile"]["password_manager_enabled"] = False
_prefs["profile"]["exit_type"] = "Normal"
_prefs["profile"]["exited_cleanly"] = True
_prefs_file.write_text(json.dumps(_prefs))

CHROME_ARGS = [
    "--disable-features=PasswordManager,PasswordManagerOnboarding",
    "--disable-save-password-bubble",
    "--disable-popup-blocking",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
]

# Suppress Stagehand SEA server logs by redirecting stdout/stderr


def _quiet_sea_server():
    try:
        import subprocess as _sp
        _orig_popen = _sp.Popen

        class _QuietPopen(_orig_popen):
            def __init__(self, *args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if isinstance(cmd, list) and len(cmd) == 1 and "stagehand" in str(cmd[0]).lower():
                    kwargs["stdout"] = subprocess.DEVNULL
                    kwargs["stderr"] = subprocess.DEVNULL
                super().__init__(*args, **kwargs)

        _sp.Popen = _QuietPopen
    except Exception:
        pass

_quiet_sea_server()

MAX_RECONNECT_ATTEMPTS = 3

# Serialize browser/stagehand initialization across all agents in the same process.
# Stagehand downloads its binary on first use; concurrent initializations cause a
# rename() race on the same .tmp file → "No such file or directory" crash.
# One semaphore ensures only one Stagehand() constructor runs at a time; after the
# binary is cached every subsequent init is instant.
_INIT_SEM = asyncio.Semaphore(1)


class BrowserSession:
    """Wrapper around Stagehand for local Chrome automation with reconnect."""

    def __init__(self, client: Stagehand, session_id: str):
        self._client = client
        self._session_id = session_id
        self._closed = False

    @classmethod
    async def start(cls, *, model_api_key: str | None = None) -> BrowserSession:
        settings = Settings()
        headless = settings.browser_headless

        def _start():
            client = Stagehand(
                server="local",
                local_headless=headless,
                model_api_key=model_api_key,
            )
            session = client.sessions.start(
                model_name="gpt-4o",
                browser={"type": "local", "launchOptions": {
                    "headless": headless,
                    "userDataDir": CHROME_PROFILE_DIR,
                    "args": CHROME_ARGS,
                }},
            )
            session_id = session.id if hasattr(session, "id") else str(session)
            return client, session_id

        # Serialize across all agents: only one Stagehand() constructor runs at a
        # time so the binary download + rename never races.
        async with _INIT_SEM:
            client, session_id = await asyncio.to_thread(_start)
        return cls(client, session_id)

    async def reconnect(self) -> None:
        """Tear down old session and start a fresh one."""
        console.print("[yellow]Reconnecting browser session...[/yellow]")
        try:
            await asyncio.to_thread(self._client.sessions.end, self._session_id)
        except Exception:
            pass

        settings = Settings()
        headless = settings.browser_headless

        for attempt in range(1, MAX_RECONNECT_ATTEMPTS + 1):
            try:
                def _reconnect():
                    client = Stagehand(
                        server="local",
                        local_headless=headless,
                    )
                    session = client.sessions.start(
                        model_name="gpt-4o",
                        browser={"type": "local", "launchOptions": {
                            "headless": headless,
                            "userDataDir": CHROME_PROFILE_DIR,
                            "args": CHROME_ARGS,
                        }},
                    )
                    session_id = session.id if hasattr(session, "id") else str(session)
                    return client, session_id

                client, session_id = await asyncio.to_thread(_reconnect)
                self._client = client
                self._session_id = session_id
                self._closed = False
                console.print(f"[green]Browser reconnected (attempt {attempt}).[/green]")
                return
            except Exception as e:
                console.print(f"[red]Reconnect attempt {attempt} failed: {e}[/red]")
                if attempt == MAX_RECONNECT_ATTEMPTS:
                    raise RuntimeError(
                        f"Browser reconnect failed after {MAX_RECONNECT_ATTEMPTS} attempts"
                    ) from e

    @property
    def is_alive(self) -> bool:
        if self._closed:
            return False
        try:
            return self._session_id is not None
        except Exception:
            return False

    def _get_cdp_url(self) -> str | None:
        """Get the CDP websocket URL from the Stagehand SEA server."""
        try:
            import httpx
            sea = self._client._sea_server
            if sea and sea.base_url:
                r = httpx.get(f"{sea.base_url}/v1/sessions/{self._session_id}")
                if r.status_code == 200:
                    data = r.json()
                    return data.get("cdpUrl") or data.get("wsUrl") or data.get("debuggerUrl")
        except Exception:
            pass
        return None

    async def goto(self, url: str) -> None:
        await asyncio.to_thread(self._client.sessions.navigate, self._session_id, url=url)

    async def act(self, instruction: str) -> str:
        result = await asyncio.to_thread(
            self._client.sessions.act, self._session_id, input=instruction
        )
        return str(result)

    async def extract(self, instruction: str, schema: dict | None = None) -> dict | list:
        kwargs: dict = {"instruction": instruction}
        if schema:
            kwargs["schema"] = schema

        def _extract():
            return self._client.sessions.extract(self._session_id, **kwargs)

        response = await asyncio.to_thread(_extract)
        if hasattr(response, "data") and hasattr(response.data, "result"):
            return response.data.result
        return response

    async def keyboard_type(self, text: str) -> None:
        """Type text using Playwright keyboard (bypasses Stagehand LLM)."""
        def _type():
            from playwright.sync_api import sync_playwright
            cdp_url = self._get_cdp_url()
            if cdp_url:
                pw = sync_playwright().start()
                browser = pw.chromium.connect_over_cdp(cdp_url)
                page = browser.contexts[0].pages[0]
                page.keyboard.type(text, delay=30)
                browser.close()
                pw.stop()
        await asyncio.to_thread(_type)

    async def keyboard_press(self, key: str) -> None:
        """Press a key combo using Playwright keyboard (bypasses Stagehand LLM)."""
        def _press():
            from playwright.sync_api import sync_playwright
            cdp_url = self._get_cdp_url()
            if cdp_url:
                pw = sync_playwright().start()
                browser = pw.chromium.connect_over_cdp(cdp_url)
                page = browser.contexts[0].pages[0]
                page.keyboard.press(key)
                browser.close()
                pw.stop()
        await asyncio.to_thread(_press)

    async def url(self) -> str:
        return ""

    async def close(self) -> dict:
        """End the Stagehand session. Idempotent and privacy-safe.

        Returns a small status dict suitable for operators/tests. Never includes
        session payloads, cookies, profile paths, or API keys.
        """
        if self._closed:
            return {
                "status": "already_closed",
                "session_present": bool(self._session_id),
            }

        self._closed = True
        session_id = self._session_id
        ended = False
        error_type: str | None = None

        if not session_id:
            # Missing / malformed session — treat as clean so callers can proceed.
            self._session_id = ""
            return {
                "status": "closed",
                "session_present": False,
                "ended": False,
                "reason": "missing_session_id",
            }

        try:
            await asyncio.to_thread(self._client.sessions.end, session_id)
            ended = True
        except Exception as exc:
            # Dependency failure (Stagehand down, already-ended, network): still
            # mark closed locally so cancellation paths cannot leak a live handle.
            error_type = type(exc).__name__
            console.print(
                f"[yellow]Browser session end failed during close "
                f"({error_type}); marking closed locally.[/yellow]"
            )

        self._session_id = ""
        return {
            "status": "closed",
            "session_present": True,
            "ended": ended,
            "error_type": error_type,
        }

    async def cleanup_on_cancellation(self) -> dict:
        """Tear down the browser session after task/job cancellation.

        Safe to call multiple times and from concurrent cancel paths. Errors are
        explicit and privacy-safe — no secrets, seeds, or media are logged.
        """
        if self._closed and not self._session_id:
            return {
                "status": "already_cleaned",
                "closed": True,
            }

        result = await self.close()
        result["cleanup"] = "cancellation"
        return result
