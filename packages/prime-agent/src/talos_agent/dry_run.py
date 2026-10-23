"""Dry-run mode for the Talos prime-agent (Issue #976).

When ``TALOS_DRY_RUN=1`` (or ``Settings.dry_run`` is ``True``) the agent runs
full cycles without issuing any outbound write requests.  Every side-effecting
call is intercepted by a *recorder* that:

1. **Records** the suppressed effect (method name + redacted arguments).
2. **Returns** a synthetic success response so the rest of the cycle
   continues normally.
3. **Logs** the suppressed effect at INFO level with redacted arguments so
   operators can see what *would* have happened.

Read-only calls (GET / balance queries / status checks) are **not** affected.

## What is wrapped

| Layer                | Write operations suppressed                          |
|----------------------|------------------------------------------------------|
| ``TalosAPIClient``   | ``request_transfer``, ``create_approval``,           |
|                      | ``submit_commerce``, ``register_service``,           |
|                      | ``log_activity``, ``report_revenue``,                |
|                      | ``update_status``, ``submit_job_result``,            |
|                      | ``create_agent_wallet``, ``claim_job``,              |
|                      | ``release_job``, ``heartbeat_job``                   |
| ``BaseSocialAdapter``| ``post``, ``reply``                                  |
| ``StellarKit``       | ``transfer_xlm``                                     |

## Inconsistent-flag guard

Dry-run is incompatible with any flag that implies a real production
destination.  At startup, ``check_dry_run_conflicts`` raises
``DryRunConflictError`` if production-only flags are set alongside dry-run.
Currently guarded flags (document additions in the docstring below):

- ``TALOS_API_KEY`` set to a production key pattern (starts with ``tls_``).
  *Rationale*: real API keys imply real write targets.
- ``TALOS_DURABLE_JOB_EFFECTS_ENABLED=1``.
  *Rationale*: durable effects write to external storage.

Operators who understand the risk and genuinely need dry-run + production keys
(e.g. for read audits) can set ``TALOS_DRY_RUN_ALLOW_PRODUCTION_KEYS=1`` to
bypass this guard.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from talos_agent.redact import redact_json_value

log = logging.getLogger(__name__)


# ── Errors ────────────────────────────────────────────────────────────────────


class DryRunConflictError(RuntimeError):
    """Raised at startup when dry-run is combined with production-only flags."""


# ── Suppressed-effect record ──────────────────────────────────────────────────


@dataclass
class SuppressedEffect:
    """One captured write operation that was blocked by dry-run mode."""

    layer: str          # "api_client" | "social_adapter" | "stellar_kit"
    method: str         # e.g. "request_transfer"
    redacted_args: dict = field(default_factory=dict)  # safe-to-log copy

    def to_dict(self) -> dict:
        return {
            "layer": self.layer,
            "method": self.method,
            "redacted_args": self.redacted_args,
        }


# ── Recorder ─────────────────────────────────────────────────────────────────


class DryRunRecorder:
    """Accumulates suppressed effects for the current agent cycle.

    A new recorder should be created per cycle (or per test).  The recorded
    effects can be read via :attr:`effects` and logged via
    :meth:`log_summary`.
    """

    def __init__(self) -> None:
        self._effects: list[SuppressedEffect] = []

    @property
    def effects(self) -> list[SuppressedEffect]:
        return list(self._effects)

    def record(self, layer: str, method: str, kwargs: dict) -> None:
        """Record a suppressed effect with redacted arguments."""
        safe = redact_json_value(kwargs) if kwargs else {}
        if not isinstance(safe, dict):
            safe = {}
        effect = SuppressedEffect(layer=layer, method=method, redacted_args=safe)
        self._effects.append(effect)
        log.info(
            "dry-run: suppressed %s.%s %s",
            layer,
            method,
            safe,
        )

    def log_summary(self) -> None:
        """Log a human-readable summary of all suppressed effects."""
        if not self._effects:
            log.info("dry-run: no side effects were suppressed this cycle")
            return
        log.info(
            "dry-run: %d effect(s) suppressed this cycle:", len(self._effects)
        )
        for i, eff in enumerate(self._effects, 1):
            log.info("  [%d] %s.%s %s", i, eff.layer, eff.method, eff.redacted_args)

    def to_status_dict(self) -> dict:
        """Return a status-ready summary for ``talos-agent status``."""
        return {
            "dry_run": True,
            "suppressed_effect_count": len(self._effects),
            "suppressed_effects": [e.to_dict() for e in self._effects],
        }


# ── API-client wrapper ────────────────────────────────────────────────────────

# Names of TalosAPIClient methods that perform outbound writes.
_API_WRITE_METHODS: frozenset[str] = frozenset(
    [
        "request_transfer",
        "create_approval",
        "submit_commerce",
        "register_service",
        "log_activity",
        "report_revenue",
        "update_status",
        "submit_job_result",
        "create_agent_wallet",
        "claim_job",
        "release_job",
        "heartbeat_job",
    ]
)

# Synthetic return values for each intercepted method so callers receive a
# plausible response and can continue the cycle without crashing.
_API_SYNTHETIC_RESPONSES: dict[str, Any] = {
    "request_transfer": {"status": "dry_run", "tx_hash": None},
    "create_approval": {"id": "dry-run-approval-id", "status": "dry_run"},
    "submit_commerce": {"status": "dry_run"},
    "register_service": {"status": "dry_run"},
    "log_activity": {"id": "dry-run-activity-id", "status": "dry_run"},
    "report_revenue": {"status": "dry_run"},
    "update_status": None,
    "submit_job_result": {"status": "dry_run"},
    "create_agent_wallet": {"walletId": "dry-run-wallet", "status": "dry_run"},
    "claim_job": {"fencingToken": 0, "status": "dry_run"},
    "release_job": {"status": "dry_run"},
    "heartbeat_job": {"status": "dry_run"},
}


def wrap_api_client(api: Any, recorder: DryRunRecorder) -> Any:
    """Return a proxy over *api* that intercepts all write methods.

    Read-only methods (``_get``, ``get_*``, ``discover_*``, etc.) are
    forwarded to the real client unchanged.
    """
    return _APIClientProxy(api, recorder)


class _APIClientProxy:
    """Transparent proxy that intercepts write methods for dry-run."""

    def __init__(self, real: Any, recorder: DryRunRecorder) -> None:
        self._real = real
        self._recorder = recorder

    def __getattr__(self, name: str) -> Any:
        real_attr = getattr(self._real, name)
        if name not in _API_WRITE_METHODS:
            return real_attr

        async def _intercepted(**kwargs: Any) -> Any:
            self._recorder.record("api_client", name, kwargs)
            return _API_SYNTHETIC_RESPONSES.get(name)

        return _intercepted


# ── Social-adapter wrapper ────────────────────────────────────────────────────

from talos_agent.adapters.base import BaseSocialAdapter, PublishResult  # noqa: E402


def wrap_social_adapter(adapter: BaseSocialAdapter, recorder: DryRunRecorder) -> BaseSocialAdapter:
    """Wrap a social adapter so that ``post`` and ``reply`` are suppressed."""
    return _SocialAdapterProxy(adapter, recorder)  # type: ignore[return-value]


class _SocialAdapterProxy:
    """Delegates all methods to the real adapter except post/reply."""

    def __init__(self, real: BaseSocialAdapter, recorder: DryRunRecorder) -> None:
        self._real = real
        self._recorder = recorder

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    async def post(self, content: str, **kwargs: Any) -> PublishResult:
        channel = getattr(self._real, "channel_name", "unknown")
        self._recorder.record(
            "social_adapter",
            f"{channel}.post",
            {"content_len": len(content), **{k: v for k, v in kwargs.items() if k != "trace_context"}},
        )
        return PublishResult(
            status="dry_run",
            channel=channel,
            content=content,
            post_id="dry-run-post-id",
        )

    async def reply(self, target_url: str, content: str, **kwargs: Any) -> PublishResult:
        channel = getattr(self._real, "channel_name", "unknown")
        self._recorder.record(
            "social_adapter",
            f"{channel}.reply",
            {"target_url": target_url, "content_len": len(content)},
        )
        return PublishResult(
            status="dry_run",
            channel=channel,
            content=content,
            post_id="dry-run-reply-id",
        )


# ── StellarKit wrapper ────────────────────────────────────────────────────────


def wrap_stellar_kit(kit: Any, recorder: DryRunRecorder) -> Any:
    """Wrap a StellarKit instance so that ``transfer_xlm`` is suppressed."""
    return _StellarKitProxy(kit, recorder)


class _StellarKitProxy:
    """Delegates all methods to the real StellarKit except transfer_xlm."""

    def __init__(self, real: Any, recorder: DryRunRecorder) -> None:
        self._real = real
        self._recorder = recorder

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    async def transfer_xlm(self, to_account: str, amount: Any) -> dict:
        self._recorder.record(
            "stellar_kit",
            "transfer_xlm",
            {"to_account": to_account, "amount": amount},
        )
        return {"status": "dry_run", "to": to_account, "amount": str(amount)}


# ── Conflict check ────────────────────────────────────────────────────────────

_PRODUCTION_KEY_PREFIX = "tls_"


def check_dry_run_conflicts(settings: Any) -> None:
    """Raise :class:`DryRunConflictError` if dry-run is on with conflicting flags.

    Call this during agent startup *before* any network connections are made.

    Guarded conflicts (extend this list and its docstring as new flags are added):

    - ``talos_api_key`` starting with ``"tls_"``: implies a production API key.
    - ``talos_durable_job_effects_enabled=True``: durable effects write to
      external storage and are incompatible with dry-run.

    Override: set ``TALOS_DRY_RUN_ALLOW_PRODUCTION_KEYS=1`` to bypass the
    production-key guard when you genuinely need dry-run with a real key (e.g.
    read-only audits using the same environment).
    """
    if not getattr(settings, "dry_run", False):
        return

    allow_prod_keys = getattr(settings, "dry_run_allow_production_keys", False)

    api_key: str = getattr(settings, "talos_api_key", "") or ""
    if not allow_prod_keys and api_key.startswith(_PRODUCTION_KEY_PREFIX):
        raise DryRunConflictError(
            "TALOS_DRY_RUN=1 is incompatible with a production API key "
            f"(key starts with '{_PRODUCTION_KEY_PREFIX}'). "
            "Set TALOS_DRY_RUN_ALLOW_PRODUCTION_KEYS=1 to override this guard."
        )

    if getattr(settings, "talos_durable_job_effects_enabled", False):
        raise DryRunConflictError(
            "TALOS_DRY_RUN=1 is incompatible with "
            "TALOS_DURABLE_JOB_EFFECTS_ENABLED=1. "
            "Durable job effects write to external storage. "
            "Disable durable effects before running in dry-run mode."
        )
