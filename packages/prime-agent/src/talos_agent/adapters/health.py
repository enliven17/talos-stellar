"""Adapter health probes — lightweight, side-effect-free readiness checks.

Each probe inspects only the in-process state of an adapter (credentials
present, browser session initialised, payment proxy ready, etc.). No HTTP
requests are made, no browser pages are loaded, no blockchain transactions
are submitted, and no tokens or funds are consumed.

Usage
-----
Run individual probes::

    from talos_agent.adapters.health import DiscordProbe
    result = await DiscordProbe(adapter).probe()

Run aggregate over social, browser, and payment adapters::

    from talos_agent.adapters.health import AdapterHealthReporter
    report = await AdapterHealthReporter(
        registry=registry,
        browser=browser,
        stellar_kit=stellar,
        x402_signer=signer,
    ).report()

Probe states
------------
healthy   — adapter is fully configured and its session/proxy is live.
disabled  — required credentials or configurations are absent; intentionally off.
degraded  — credentials partially set, dependency unavailable, or probe failed.
timeout   — the probe itself did not complete within PROBE_TIMEOUT_SECONDS.

Error categories
----------------
none                   — no error (healthy or intentionally disabled).
missing_credentials    — required secrets/tokens/channels are missing.
invalid_credentials    — credentials provided are invalid or misconfigured.
dependency_unavailable — external dependency (browser, horizon, web API) is not live.
timeout                — health probe timed out before completing.
internal_error         — probe raised an unexpected internal exception.
network_error          — network or connection error encountered.
"""

from __future__ import annotations

import asyncio
import datetime
import enum
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# ── Constants ─────────────────────────────────────────────────────────────────

PROBE_TIMEOUT_SECONDS: float = 5.0

# ── Sanitization ─────────────────────────────────────────────────────────────

_SENSITIVE_PATTERNS = [
    re.compile(r"S[A-Z0-9]{55}"),  # Stellar secret seed
    re.compile(r"sk-[A-Za-z0-9\-_]{20,}"),  # OpenAI/API secret key
    re.compile(r"(https?://[^\s:@]+:[^\s:@]+@\S+)"),  # URL with basic auth creds
    re.compile(r"(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*", re.IGNORECASE),
    re.compile(r"([a-zA-Z0-9_\-]{24,}\.[a-zA-Z0-9_\-]{6}\.[a-zA-Z0-9_\-]{27,})"),  # Discord bot token
]


def _sanitize_health_detail(text: str) -> str:
    """Strip secrets, credentials, tokens, or signed payloads from details."""
    if not text:
        return ""
    sanitized = str(text)
    for pattern in _SENSITIVE_PATTERNS:
        sanitized = pattern.sub("[REDACTED]", sanitized)
    return sanitized


# ── State & Categories ───────────────────────────────────────────────────────


class AdapterState(str, enum.Enum):
    """Health state of a single adapter."""

    HEALTHY = "healthy"
    DISABLED = "disabled"
    DEGRADED = "degraded"
    TIMEOUT = "timeout"


class ErrorCategory(str, enum.Enum):
    """Error classification category for adapter health states."""

    NONE = "none"
    MISSING_CREDENTIALS = "missing_credentials"
    INVALID_CREDENTIALS = "invalid_credentials"
    DEPENDENCY_UNAVAILABLE = "dependency_unavailable"
    TIMEOUT = "timeout"
    INTERNAL_ERROR = "internal_error"
    NETWORK_ERROR = "network_error"


# ── Result ────────────────────────────────────────────────────────────────────


@dataclass
class ProbeResult:
    """Outcome of a single adapter health probe."""

    adapter: str
    """Canonical adapter name, e.g. ``"Discord"``, ``"Telegram"``, ``"X"``, ``"StellarPayment"``."""

    state: AdapterState
    """Overall health state."""

    detail: str = ""
    """Human-readable explanation — safe to expose in dashboards and logs."""

    error_category: ErrorCategory = ErrorCategory.NONE
    """Typed category explaining the cause when state is not healthy."""

    checked_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict[str, Any]:
        cat = (
            self.error_category.value
            if isinstance(self.error_category, enum.Enum)
            else str(self.error_category or "none")
        )
        return {
            "adapter": self.adapter,
            "state": self.state.value if isinstance(self.state, enum.Enum) else str(self.state),
            "detail": _sanitize_health_detail(self.detail),
            "error_category": cat,
            "checked_at": self.checked_at.isoformat(),
        }


# ── Protocol ─────────────────────────────────────────────────────────────────


@runtime_checkable
class AdapterProbe(Protocol):
    """Common interface for all adapter health probes.

    Implementations MUST NOT make any external network calls, read files,
    or trigger side effects. They inspect only in-process state.
    """

    async def probe(self) -> ProbeResult:
        """Run the probe and return a :class:`ProbeResult`."""
        ...


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _run_with_timeout(
    coro, timeout: float = PROBE_TIMEOUT_SECONDS, adapter_name: str = "unknown"
) -> ProbeResult:
    """Run *coro* and wrap a TimeoutError into a TIMEOUT ProbeResult."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        return ProbeResult(
            adapter=adapter_name,
            state=AdapterState.TIMEOUT,
            detail=f"Probe did not complete within {timeout}s",
            error_category=ErrorCategory.TIMEOUT,
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
        adapter_name = getattr(a, "channel_name", "Discord")
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
                adapter=adapter_name,
                state=AdapterState.HEALTHY,
                detail=(
                    "webhook configured"
                    if has_webhook
                    else "bot token + channel ID configured"
                ),
                error_category=ErrorCategory.NONE,
            )

        if has_token and not has_channel:
            return ProbeResult(
                adapter=adapter_name,
                state=AdapterState.DEGRADED,
                detail="DISCORD_BOT_TOKEN set but DISCORD_CHANNEL_ID is missing",
                error_category=ErrorCategory.MISSING_CREDENTIALS,
            )

        if has_channel and not has_token:
            return ProbeResult(
                adapter=adapter_name,
                state=AdapterState.DEGRADED,
                detail="DISCORD_CHANNEL_ID set but DISCORD_BOT_TOKEN is missing",
                error_category=ErrorCategory.MISSING_CREDENTIALS,
            )

        return ProbeResult(
            adapter=adapter_name,
            state=AdapterState.DISABLED,
            detail=(
                "No credentials found. "
                "Set DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID."
            ),
            error_category=ErrorCategory.NONE,
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
        adapter_name = getattr(a, "channel_name", "Telegram")
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
                adapter=adapter_name,
                state=AdapterState.HEALTHY,
                detail="bot token and chat ID configured",
                error_category=ErrorCategory.NONE,
            )

        if has_token and not has_chat:
            return ProbeResult(
                adapter=adapter_name,
                state=AdapterState.DEGRADED,
                detail="telegram_bot_token set but telegram_chat_id is missing",
                error_category=ErrorCategory.MISSING_CREDENTIALS,
            )

        if has_chat and not has_token:
            return ProbeResult(
                adapter=adapter_name,
                state=AdapterState.DEGRADED,
                detail="telegram_chat_id set but telegram_bot_token is missing",
                error_category=ErrorCategory.MISSING_CREDENTIALS,
            )

        return ProbeResult(
            adapter=adapter_name,
            state=AdapterState.DISABLED,
            detail=(
                "No credentials found. "
                "Set telegram_bot_token and telegram_chat_id."
            ),
            error_category=ErrorCategory.NONE,
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
        adapter_name = getattr(a, "channel_name", "X")
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
                adapter=adapter_name,
                state=AdapterState.DISABLED,
                detail="No X credentials found. Set X_USERNAME and X_PASSWORD.",
                error_category=ErrorCategory.NONE,
            )

        if has_creds and browser_live:
            return ProbeResult(
                adapter=adapter_name,
                state=AdapterState.HEALTHY,
                detail="credentials configured and browser session is live",
                error_category=ErrorCategory.NONE,
            )

        # Credentials present but browser not yet ready
        return ProbeResult(
            adapter=adapter_name,
            state=AdapterState.DEGRADED,
            detail=(
                "X credentials configured but browser session is not initialised. "
                "The adapter will become healthy once the browser starts."
            ),
            error_category=ErrorCategory.DEPENDENCY_UNAVAILABLE,
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
                error_category=ErrorCategory.NONE,
            )

        stagehand = getattr(b, "_stagehand", None)
        if stagehand is None:
            return ProbeResult(
                adapter="BrowserSession",
                state=AdapterState.DISABLED,
                detail="Browser session not started (no Stagehand instance).",
                error_category=ErrorCategory.NONE,
            )

        page = getattr(stagehand, "page", None)
        if page is None:
            return ProbeResult(
                adapter="BrowserSession",
                state=AdapterState.DEGRADED,
                detail="Stagehand initialised but no page is open yet.",
                error_category=ErrorCategory.DEPENDENCY_UNAVAILABLE,
            )

        return ProbeResult(
            adapter="BrowserSession",
            state=AdapterState.HEALTHY,
            detail="Stagehand session active with open page.",
            error_category=ErrorCategory.NONE,
        )


# ── Payment probes (Stellar & x402) ──────────────────────────────────────────


class StellarPaymentProbe:
    """Probe Stellar payment proxy / StellarKit configuration and readiness.

    healthy  — API client configured and proxy initialized.
    degraded — API client configured but proxy not yet initialized.
    disabled — No API client provided (Stellar payments disabled).
    """

    def __init__(self, stellar_kit) -> None:
        self._stellar_kit = stellar_kit

    async def probe(self) -> ProbeResult:
        s = self._stellar_kit
        if s is None:
            return ProbeResult(
                adapter="StellarPayment",
                state=AdapterState.DISABLED,
                detail="No Stellar payment instance provided.",
                error_category=ErrorCategory.NONE,
            )

        snapshot_fn = getattr(s, "health_snapshot", None)
        snapshot = snapshot_fn() if callable(snapshot_fn) else {}
        snapshot = snapshot if isinstance(snapshot, dict) else {}

        has_api = bool(
            snapshot["has_api"]
            if "has_api" in snapshot
            else getattr(s, "_api", None) is not None
        )
        initialized = bool(
            snapshot["initialized"]
            if "initialized" in snapshot
            else getattr(s, "_initialized", False)
        )

        if not has_api:
            return ProbeResult(
                adapter="StellarPayment",
                state=AdapterState.DISABLED,
                detail="Stellar payment proxy disabled (no API client configured).",
                error_category=ErrorCategory.NONE,
            )

        if has_api and initialized:
            return ProbeResult(
                adapter="StellarPayment",
                state=AdapterState.HEALTHY,
                detail="Stellar payment proxy initialized and ready.",
                error_category=ErrorCategory.NONE,
            )

        return ProbeResult(
            adapter="StellarPayment",
            state=AdapterState.DEGRADED,
            detail="Stellar payment proxy configured but not initialized.",
            error_category=ErrorCategory.DEPENDENCY_UNAVAILABLE,
        )


class X402PaymentProbe:
    """Probe x402 signer payment adapter configuration and readiness.

    healthy  — API client configured, initialized, and agent wallet available.
    degraded — API client configured but signer not initialized.
    disabled — No API client or no wallet assigned (signing disabled).
    """

    def __init__(self, signer) -> None:
        self._signer = signer

    async def probe(self) -> ProbeResult:
        s = self._signer
        if s is None:
            return ProbeResult(
                adapter="X402Signer",
                state=AdapterState.DISABLED,
                detail="No x402 signer instance provided.",
                error_category=ErrorCategory.NONE,
            )

        snapshot_fn = getattr(s, "health_snapshot", None)
        snapshot = snapshot_fn() if callable(snapshot_fn) else {}
        snapshot = snapshot if isinstance(snapshot, dict) else {}

        has_api = bool(
            snapshot["has_api"]
            if "has_api" in snapshot
            else getattr(s, "_api", None) is not None
        )
        initialized = bool(
            snapshot["initialized"]
            if "initialized" in snapshot
            else getattr(s, "_initialized", False)
        )
        has_wallet = bool(
            snapshot["has_wallet"]
            if "has_wallet" in snapshot
            else bool(getattr(s, "_wallet_address", None))
        )

        if not has_api:
            return ProbeResult(
                adapter="X402Signer",
                state=AdapterState.DISABLED,
                detail="x402 payment signer disabled (no API client configured).",
                error_category=ErrorCategory.NONE,
            )

        if has_api and initialized and has_wallet:
            return ProbeResult(
                adapter="X402Signer",
                state=AdapterState.HEALTHY,
                detail="x402 payment signer initialized with active agent wallet.",
                error_category=ErrorCategory.NONE,
            )

        if has_api and initialized and not has_wallet:
            return ProbeResult(
                adapter="X402Signer",
                state=AdapterState.DISABLED,
                detail="x402 payment signing disabled (no agent wallet found).",
                error_category=ErrorCategory.NONE,
            )

        return ProbeResult(
            adapter="X402Signer",
            state=AdapterState.DEGRADED,
            detail="x402 payment signer configured but not initialized.",
            error_category=ErrorCategory.DEPENDENCY_UNAVAILABLE,
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

    def to_dict(self) -> dict[str, Any]:
        return {
            "overall": self.overall.value if isinstance(self.overall, enum.Enum) else str(self.overall),
            "adapters": [r.to_dict() for r in self.adapters],
            "checked_at": self.checked_at.isoformat(),
        }

    @property
    def has_degraded(self) -> bool:
        """Return True if any probe reported degraded or timeout state."""
        return any(
            r.state in (AdapterState.DEGRADED, AdapterState.TIMEOUT)
            for r in self.adapters
        )

    @property
    def degraded_adapters(self) -> list[ProbeResult]:
        """Return list of degraded or timed-out adapter probes."""
        return [
            r
            for r in self.adapters
            if r.state in (AdapterState.DEGRADED, AdapterState.TIMEOUT)
        ]


_STATE_SEVERITY: dict[AdapterState, int] = {
    AdapterState.HEALTHY: 0,
    AdapterState.DISABLED: 1,
    AdapterState.DEGRADED: 2,
    AdapterState.TIMEOUT: 3,
}


def _worst(states: list[AdapterState]) -> AdapterState:
    if not states:
        return AdapterState.DISABLED
    return max(states, key=lambda s: _STATE_SEVERITY.get(s, 1))


async def _safe_probe_coro(
    probe_obj: AdapterProbe, timeout_sec: float, adapter_n: str
) -> ProbeResult:
    """Safely invoke probe_obj.probe() with timeout and error capture."""
    try:
        res = probe_obj.probe()
        if asyncio.iscoroutine(res) or hasattr(res, "__await__"):
            return await asyncio.wait_for(res, timeout=timeout_sec)
        elif isinstance(res, ProbeResult):
            return res
        else:
            return ProbeResult(
                adapter=adapter_n,
                state=AdapterState.HEALTHY,
                detail=str(res),
                error_category=ErrorCategory.NONE,
            )
    except asyncio.TimeoutError:
        return ProbeResult(
            adapter=adapter_n,
            state=AdapterState.TIMEOUT,
            detail=f"Probe did not complete within {timeout_sec}s",
            error_category=ErrorCategory.TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        err_type = type(exc).__name__
        return ProbeResult(
            adapter=adapter_n,
            state=AdapterState.DEGRADED,
            detail=_sanitize_health_detail(f"Probe raised an unexpected error: {err_type}"),
            error_category=ErrorCategory.INTERNAL_ERROR,
        )


class AdapterHealthReporter:
    """Runs all adapter probes and returns an aggregate :class:`HealthReport`.

    Parameters
    ----------
    registry:
        Optional :class:`~talos_agent.adapters.registry.AdapterRegistry` whose
        registered adapters are probed.
    browser:
        Optional :class:`~talos_agent.browser.session.BrowserSession` to
        include as a standalone probe.
    payments:
        Optional payment adapter, list of payment adapters, or dict of payment probes.
    stellar_kit:
        Optional :class:`~talos_agent.payments.stellar_kit.StellarKit` instance.
    x402_signer:
        Optional :class:`~talos_agent.payments.x402_signer.X402Signer` instance.
    timeout:
        Per-probe timeout in seconds (default: :data:`PROBE_TIMEOUT_SECONDS`).
    """

    def __init__(
        self,
        registry=None,
        browser=None,
        payments=None,
        stellar_kit=None,
        x402_signer=None,
        timeout: float = PROBE_TIMEOUT_SECONDS,
    ) -> None:
        self._registry = registry
        self._browser = browser
        self._payments = payments
        self._stellar_kit = stellar_kit
        self._x402_signer = x402_signer
        self._timeout = timeout

    async def report(self) -> HealthReport:
        """Run all probes concurrently and return a :class:`HealthReport`.

        Guarantees that a failing or hanging probe never crashes the report.
        """
        probes: list[tuple[str, AdapterProbe]] = []

        if self._registry is not None:
            adapters_dict = getattr(self._registry, "_adapters", {})
            for adapter in adapters_dict.values():
                name = getattr(adapter, "channel_name", "").lower()
                if name == "discord":
                    probes.append(("Discord", DiscordProbe(adapter)))
                elif name == "telegram":
                    probes.append(("Telegram", TelegramProbe(adapter)))
                elif name == "x":
                    probes.append(("X", XProbe(adapter)))
                elif hasattr(adapter, "probe") and callable(adapter.probe):
                    probes.append((getattr(adapter, "channel_name", "custom"), adapter))

        if self._browser is not None:
            probes.append(("BrowserSession", BrowserSessionProbe(self._browser)))

        # Process payment components
        if self._stellar_kit is not None:
            probes.append(("StellarPayment", StellarPaymentProbe(self._stellar_kit)))

        if self._x402_signer is not None:
            probes.append(("X402Signer", X402PaymentProbe(self._x402_signer)))

        if self._payments is not None:
            if isinstance(self._payments, (list, tuple, set)):
                for p in self._payments:
                    p_name = type(p).__name__
                    if "Stellar" in p_name:
                        probes.append(("StellarPayment", StellarPaymentProbe(p)))
                    elif "402" in p_name or "Signer" in p_name:
                        probes.append(("X402Signer", X402PaymentProbe(p)))
                    elif hasattr(p, "probe") and callable(p.probe):
                        probes.append((getattr(p, "channel_name", p_name), p))
            elif isinstance(self._payments, dict):
                for p_key, p_val in self._payments.items():
                    if hasattr(p_val, "probe") and callable(p_val.probe):
                        probes.append((p_key, p_val))
                    elif "stellar" in p_key.lower():
                        probes.append((p_key, StellarPaymentProbe(p_val)))
                    elif "x402" in p_key.lower() or "signer" in p_key.lower():
                        probes.append((p_key, X402PaymentProbe(p_val)))
            else:
                p = self._payments
                p_name = type(p).__name__
                if "Stellar" in p_name:
                    probes.append(("StellarPayment", StellarPaymentProbe(p)))
                elif "402" in p_name or "Signer" in p_name:
                    probes.append(("X402Signer", X402PaymentProbe(p)))
                elif hasattr(p, "probe") and callable(p.probe):
                    probes.append((getattr(p, "channel_name", p_name), p))

        results: list[ProbeResult] = []
        if probes:
            coros = [
                _safe_probe_coro(probe, self._timeout, name)
                for name, probe in probes
            ]
            raw = await asyncio.gather(*coros, return_exceptions=True)
            for (name, _), outcome in zip(probes, raw):
                if isinstance(outcome, BaseException):
                    err_type = type(outcome).__name__
                    results.append(
                        ProbeResult(
                            adapter=name,
                            state=AdapterState.DEGRADED,
                            detail=_sanitize_health_detail(
                                f"Probe raised an unexpected error: {err_type}"
                            ),
                            error_category=ErrorCategory.INTERNAL_ERROR,
                        )
                    )
                else:
                    results.append(outcome)

        overall = _worst([r.state for r in results])
        return HealthReport(overall=overall, adapters=results)
