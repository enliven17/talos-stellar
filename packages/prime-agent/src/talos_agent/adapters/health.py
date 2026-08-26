"""Adapter health probes — lightweight, side-effect-free readiness checks.

Each probe inspects only the in-process state of an adapter (credentials
present, browser session initialised, etc.).  No HTTP requests are made,
no browser pages are loaded, and no tokens are consumed.

Usage
-----
Run individual probes::

    from talos_agent.adapters.health import DiscordProbe
    result = await DiscordProbe(adapter).probe()

Run aggregate over the whole registry::

    from talos_agent.adapters.health import AdapterHealthReporter
    report = await AdapterHealthReporter(registry, browser).report()

Probe states
------------
healthy   — adapter is fully configured and its session (if any) is live.
disabled  — required credentials are absent; the adapter is intentionally off.
degraded  — credentials are partially set or in an unexpected state.
timeout   — the probe itself did not complete within PROBE_TIMEOUT_SECONDS.
"""

from __future__ import annotations

import asyncio
import datetime
import enum
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

# ── Constants ─────────────────────────────────────────────────────────────────

PROBE_TIMEOUT_SECONDS: float = 5.0

# ── State ─────────────────────────────────────────────────────────────────────


class AdapterState(str, enum.Enum):
    """Health state of a single adapter."""

    HEALTHY = "healthy"
    DISABLED = "disabled"
    DEGRADED = "degraded"
    TIMEOUT = "timeout"


# ── Result ────────────────────────────────────────────────────────────────────


@dataclass
class ProbeResult:
    """Outcome of a single adapter health probe."""

    adapter: str
    """Canonical adapter name, e.g. ``"Discord"``, ``"Telegram"``, ``"X"``."""

    state: AdapterState
    """Overall health state."""

    detail: str = ""
    """Human-readable explanation — safe to expose in dashboards."""

    checked_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "adapter": self.adapter,
            "state": self.state.value,
            "detail": self.detail,
            "checked_at": self.checked_at.isoformat(),
        }


# ── Protocol ─────────────────────────────────────────────────────────────────


@runtime_checkable
class AdapterProbe(Protocol):
    """Common interface for all adapter health probes.

    Implementations MUST NOT make any external network calls, read files,
    or trigger side effects.  They inspect only in-process state.
    """

    async def probe(self) -> ProbeResult:
        """Run the probe and return a :class:`ProbeResult`."""
        ...


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _run_with_timeout(coro, timeout: float = PROBE_TIMEOUT_SECONDS) -> ProbeResult:
    """Run *coro* and wrap a TimeoutError into a TIMEOUT ProbeResult."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        return ProbeResult(
            adapter="unknown",
            state=AdapterState.TIMEOUT,
            detail=f"Probe did not complete within {timeout}s",
        )


# ── Discord probe ─────────────────────────────────────────────────────────────


class DiscordProbe:
    """Probe the DiscordAdapter configuration.

    healthy  — webhook URL set, OR both bot_token AND channel_id set.
    degraded — bot_token present but channel_id missing (or vice versa).
    disabled — no credentials at all.
    """

    def __init__(self, adapter) -> None:
        self._adapter = adapter

    async def probe(self) -> ProbeResult:
        a = self._adapter
        snapshot_fn = getattr(a, "health_snapshot", None)
        snapshot = snapshot_fn() if callable(snapshot_fn) else {}
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        has_webhook = bool(
            snapshot["has_webhook"]
            if "has_webhook" in snapshot
            else getattr(a, "_webhook_url", "")
        )
        has_token = bool(
            snapshot["has_token"]
            if "has_token" in snapshot
            else getattr(a, "_bot_token", "")
        )
        has_channel = bool(
            snapshot["has_channel"]
            if "has_channel" in snapshot
            else getattr(a, "_channel_id", "")
        )

        if has_webhook or (has_token and has_channel):
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.HEALTHY,
                detail=(
                    "webhook configured"
                    if has_webhook
                    else "bot token + channel ID configured"
                ),
            )

        if has_token and not has_channel:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.DEGRADED,
                detail="DISCORD_BOT_TOKEN set but DISCORD_CHANNEL_ID is missing",
            )

        if has_channel and not has_token:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.DEGRADED,
                detail="DISCORD_CHANNEL_ID set but DISCORD_BOT_TOKEN is missing",
            )

        return ProbeResult(
            adapter=a.channel_name,
            state=AdapterState.DISABLED,
            detail=(
                "No credentials found. "
                "Set DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID."
            ),
        )


# ── Telegram probe ────────────────────────────────────────────────────────────


class TelegramProbe:
    """Probe the TelegramAdapter configuration.

    healthy  — both bot_token AND chat_id are set.
    degraded — one credential present, the other missing.
    disabled — no credentials at all.
    """

    def __init__(self, adapter) -> None:
        self._adapter = adapter

    async def probe(self) -> ProbeResult:
        a = self._adapter
        snapshot_fn = getattr(a, "health_snapshot", None)
        snapshot = snapshot_fn() if callable(snapshot_fn) else {}
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        has_token = bool(
            snapshot["has_token"]
            if "has_token" in snapshot
            else getattr(a, "_bot_token", "")
        )
        has_chat = bool(
            snapshot["has_chat"]
            if "has_chat" in snapshot
            else getattr(a, "_chat_id", "")
        )

        if has_token and has_chat:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.HEALTHY,
                detail="bot token and chat ID configured",
            )

        if has_token and not has_chat:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.DEGRADED,
                detail="telegram_bot_token set but telegram_chat_id is missing",
            )

        if has_chat and not has_token:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.DEGRADED,
                detail="telegram_chat_id set but telegram_bot_token is missing",
            )

        return ProbeResult(
            adapter=a.channel_name,
            state=AdapterState.DISABLED,
            detail=(
                "No credentials found. "
                "Set telegram_bot_token and telegram_chat_id."
            ),
        )


# ── X (browser) probe ─────────────────────────────────────────────────────────


class XProbe:
    """Probe the XAdapter + its underlying BrowserSession.

    healthy  — username/password credentials set AND browser session is live.
    degraded — credentials set but browser not initialised (or vice versa).
    disabled — no X credentials at all.
    """

    def __init__(self, adapter) -> None:
        self._adapter = adapter

    async def probe(self) -> ProbeResult:
        a = self._adapter
        snapshot_fn = getattr(a, "health_snapshot", None)
        snapshot = snapshot_fn() if callable(snapshot_fn) else {}
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        settings = getattr(a, "_settings", None)
        has_username = bool(
            snapshot["has_username"]
            if "has_username" in snapshot
            else getattr(settings, "x_username", "")
        )
        from talos_agent.config import resolve_setting_secret

        has_password = bool(
            snapshot["has_password"]
            if "has_password" in snapshot
            else resolve_setting_secret(settings, "x_password")
        )
        has_creds = has_username and has_password

        browser: object | None = getattr(a, "_browser", None)
        browser_live = bool(
            snapshot["browser_live"]
            if "browser_live" in snapshot
            else _browser_is_live(browser)
        )

        if not has_creds:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.DISABLED,
                detail="No X credentials found. Set X_USERNAME and X_PASSWORD.",
            )

        if has_creds and browser_live:
            return ProbeResult(
                adapter=a.channel_name,
                state=AdapterState.HEALTHY,
                detail="credentials configured and browser session is live",
            )

        # Credentials present but browser not yet ready
        return ProbeResult(
            adapter=a.channel_name,
            state=AdapterState.DEGRADED,
            detail=(
                "X credentials configured but browser session is not initialised. "
                "The adapter will become healthy once the browser starts."
            ),
        )


def _browser_is_live(browser: object | None) -> bool:
    """Return True if *browser* has an active Stagehand/page handle.

    Inspects only in-process attributes — no I/O performed.
    """
    if browser is None:
        return False
    # BrowserSession stores the Stagehand instance in _stagehand once started
    stagehand = getattr(browser, "_stagehand", None)
    if stagehand is None:
        return False
    # Stagehand exposes a `page` property once a context is open
    page = getattr(stagehand, "page", None)
    return page is not None


# ── BrowserSession probe ──────────────────────────────────────────────────────


class BrowserSessionProbe:
    """Probe a raw BrowserSession (independent of any particular adapter).

    healthy  — Stagehand instance exists and has an open page.
    degraded — Stagehand instance exists but page is not yet open.
    disabled — No Stagehand instance (browser not configured / not started).
    """

    def __init__(self, browser) -> None:
        self._browser = browser

    async def probe(self) -> ProbeResult:
        b = self._browser
        if b is None:
            return ProbeResult(
                adapter="BrowserSession",
                state=AdapterState.DISABLED,
                detail="No browser session instance provided.",
            )

        stagehand = getattr(b, "_stagehand", None)
        if stagehand is None:
            return ProbeResult(
                adapter="BrowserSession",
                state=AdapterState.DISABLED,
                detail="Browser session not started (no Stagehand instance).",
            )

        page = getattr(stagehand, "page", None)
        if page is None:
            return ProbeResult(
                adapter="BrowserSession",
                state=AdapterState.DEGRADED,
                detail="Stagehand initialised but no page is open yet.",
            )

        return ProbeResult(
            adapter="BrowserSession",
            state=AdapterState.HEALTHY,
            detail="Stagehand session active with open page.",
        )


# ── Aggregate reporter ────────────────────────────────────────────────────────


@dataclass
class HealthReport:
    """Aggregate health report across all registered adapters."""

    overall: AdapterState
    """Worst state across all probes."""

    adapters: list[ProbeResult]
    """Per-adapter probe results."""

    checked_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "overall": self.overall.value,
            "adapters": [r.to_dict() for r in self.adapters],
            "checked_at": self.checked_at.isoformat(),
        }


_STATE_SEVERITY: dict[AdapterState, int] = {
    AdapterState.HEALTHY: 0,
    AdapterState.DISABLED: 1,
    AdapterState.DEGRADED: 2,
    AdapterState.TIMEOUT: 3,
}


def _worst(states: list[AdapterState]) -> AdapterState:
    if not states:
        return AdapterState.DISABLED
    return max(states, key=lambda s: _STATE_SEVERITY[s])


class AdapterHealthReporter:
    """Runs all adapter probes and returns an aggregate :class:`HealthReport`.

    Parameters
    ----------
    registry:
        An :class:`~talos_agent.adapters.registry.AdapterRegistry` whose
        registered adapters are probed.
    browser:
        Optional :class:`~talos_agent.browser.session.BrowserSession` to
        include as a standalone probe.
    timeout:
        Per-probe timeout in seconds (default: :data:`PROBE_TIMEOUT_SECONDS`).
    """

    def __init__(self, registry, browser=None, timeout: float = PROBE_TIMEOUT_SECONDS) -> None:
        self._registry = registry
        self._browser = browser
        self._timeout = timeout

    async def report(self) -> HealthReport:
        """Run all probes concurrently and return a :class:`HealthReport`."""
        probes: list[tuple[str, AdapterProbe]] = []

        for adapter in self._registry._adapters.values():
            name = adapter.channel_name.lower()
            if name == "discord":
                probes.append(("discord", DiscordProbe(adapter)))
            elif name == "telegram":
                probes.append(("telegram", TelegramProbe(adapter)))
            elif name == "x":
                probes.append(("x", XProbe(adapter)))

        if self._browser is not None:
            probes.append(("browser", BrowserSessionProbe(self._browser)))

        results: list[ProbeResult] = []
        if probes:
            coros = [
                _run_with_timeout(probe.probe(), timeout=self._timeout)
                for _, probe in probes
            ]
            raw = await asyncio.gather(*coros, return_exceptions=True)
            for (name, _), outcome in zip(probes, raw):
                if isinstance(outcome, BaseException):
                    results.append(
                        ProbeResult(
                            adapter=name,
                            state=AdapterState.DEGRADED,
                            detail=f"Probe raised an unexpected exception: {outcome}",
                        )
                    )
                else:
                    results.append(outcome)

        overall = _worst([r.state for r in results])
        return HealthReport(overall=overall, adapters=results)
