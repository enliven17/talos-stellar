"""Permission manifests for executable agent tools.

Every tool declares, up front, what it is allowed to touch: which data it
reads, which hosts it talks to, what it may do with the wallet, and which
side effects it produces. The registry validates that declaration at
registration time and enforces it at call time.

Design notes
------------
* **Fail closed on capability, open on rollout.** A tool that declares a
  capability it was not granted is denied. A tool that declares *nothing* is
  denied only once enforcement is switched on — see :class:`EnforcementMode`.
  The default mode is ``AUDIT``, so an existing deployment observes what
  *would* be denied before anything actually is.
* **Grants are a ceiling, not a wish.** The effective permission set is the
  intersection of what the manifest declares and what the operator granted.
  Widening a manifest can never widen what an agent can actually do.
* **No secrets in the audit trail.** Records carry the tool name, the decision,
  and the capability that triggered it — never argument values.

This module has no dependency on the tool registry, so it can be imported by
policy code, tests, and tooling without pulling in the agent runtime.
"""

from __future__ import annotations

import enum
import fnmatch
import json
import logging
import time
from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Iterable, Mapping, Sequence

logger = logging.getLogger(__name__)


# ── Capability vocabulary ────────────────────────────────────────────────────


class DataScope(str, enum.Enum):
    """What persistent data a tool may reach."""

    NONE = "data.none"
    READ_LOCAL = "data.read_local"        # local agent DB (history, notes)
    WRITE_LOCAL = "data.write_local"
    READ_REMOTE = "data.read_remote"      # Talos Web API, owned records
    WRITE_REMOTE = "data.write_remote"
    READ_SECRETS = "data.read_secrets"    # credentials, keys — always privileged


class NetworkScope(str, enum.Enum):
    """How a tool may reach the network."""

    NONE = "network.none"
    HTTP = "network.http"                 # server-to-server HTTP(S)
    BROWSER = "network.browser"           # full headless browser session


class WalletScope(str, enum.Enum):
    """What a tool may do with agent funds."""

    NONE = "wallet.none"
    READ = "wallet.read"                  # balances, account info
    TRANSFER = "wallet.transfer"          # move value out
    TOKEN_ISSUE = "wallet.token_issue"    # mint / airdrop


class SideEffect(str, enum.Enum):
    """Externally visible consequences."""

    NONE = "side_effect.none"
    PUBLISH = "side_effect.publish"       # posts to a public channel
    COMMERCE = "side_effect.commerce"     # creates paid obligations
    STATE_CHANGE = "side_effect.state"    # mutates protocol/registry state


#: Capabilities that can never be granted implicitly — an operator must opt in.
PRIVILEGED: frozenset[str] = frozenset(
    {
        DataScope.READ_SECRETS.value,
        WalletScope.TRANSFER.value,
        WalletScope.TOKEN_ISSUE.value,
        SideEffect.COMMERCE.value,
        SideEffect.STATE_CHANGE.value,
    }
)


class ManifestValidationError(ValueError):
    """A manifest is internally inconsistent or references unknown capabilities."""


class PermissionDenied(PermissionError):
    """Runtime check refused a tool call. Carries a stable ``code``."""

    def __init__(self, code: str, message: str, tool: str, capability: str | None = None):
        super().__init__(message)
        self.code = code
        self.tool = tool
        self.capability = capability

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": str(self),
            "code": self.code,
            "tool": self.tool,
            "capability": self.capability,
        }


# ── Manifest ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ToolPermissions:
    """The declared permission surface of one tool.

    Parameters
    ----------
    data:
        Data scopes the tool reads or writes.
    network:
        Network scopes the tool uses.
    hosts:
        Hostname patterns (``fnmatch`` syntax, e.g. ``api.stellar.org``,
        ``*.talos.xyz``) the tool may contact. Required whenever a network
        scope other than ``NONE`` is declared — "any host" is not expressible,
        by design.
    wallet:
        Wallet scopes the tool exercises.
    side_effects:
        Externally visible consequences.
    max_spend_usd:
        Hard per-call ceiling for tools declaring ``wallet.transfer``. Required
        for those tools and ignored for all others.
    requires_approval:
        Force a human approval before every call, regardless of grants.
    """

    data: tuple[DataScope, ...] = (DataScope.NONE,)
    network: tuple[NetworkScope, ...] = (NetworkScope.NONE,)
    hosts: tuple[str, ...] = ()
    wallet: tuple[WalletScope, ...] = (WalletScope.NONE,)
    side_effects: tuple[SideEffect, ...] = (SideEffect.NONE,)
    max_spend_usd: Decimal | None = None
    requires_approval: bool = False

    # ── Derived views ────────────────────────────────────────────────────

    def capabilities(self) -> frozenset[str]:
        """Every declared capability as a flat set of stable string ids."""
        return frozenset(
            c.value
            for group in (self.data, self.network, self.wallet, self.side_effects)
            for c in group
            if not c.value.endswith(".none")
        )

    def is_privileged(self) -> bool:
        return bool(self.capabilities() & PRIVILEGED)

    def is_read_only(self) -> bool:
        writes = {
            DataScope.WRITE_LOCAL.value,
            DataScope.WRITE_REMOTE.value,
        }
        caps = self.capabilities()
        return not (caps & writes) and not (caps & PRIVILEGED) and not any(
            e is not SideEffect.NONE for e in self.side_effects
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "data": [d.value for d in self.data],
            "network": [n.value for n in self.network],
            "hosts": list(self.hosts),
            "wallet": [w.value for w in self.wallet],
            "side_effects": [s.value for s in self.side_effects],
            "max_spend_usd": str(self.max_spend_usd) if self.max_spend_usd is not None else None,
            "requires_approval": self.requires_approval,
        }

    # ── Validation ───────────────────────────────────────────────────────

    def validate(self, tool_name: str) -> None:
        """Reject a manifest that cannot be enforced. Called at registration."""
        if not self.data or not self.network or not self.wallet or not self.side_effects:
            raise ManifestValidationError(
                f"{tool_name}: every manifest axis must declare at least one value "
                "(use the explicit .NONE member rather than an empty tuple)"
            )

        uses_network = any(n is not NetworkScope.NONE for n in self.network)
        if uses_network and not self.hosts:
            raise ManifestValidationError(
                f"{tool_name}: declares a network scope but no host allowlist; "
                "'any host' is not expressible"
            )
        if not uses_network and self.hosts:
            raise ManifestValidationError(
                f"{tool_name}: declares hosts but no network scope"
            )

        for host in self.hosts:
            if not host or host.strip() != host or "/" in host:
                raise ManifestValidationError(
                    f"{tool_name}: invalid host pattern {host!r} (bare hostname or glob only)"
                )

        transfers = WalletScope.TRANSFER in self.wallet
        if transfers and (self.max_spend_usd is None or self.max_spend_usd <= 0):
            raise ManifestValidationError(
                f"{tool_name}: declares wallet.transfer and must set a positive max_spend_usd"
            )
        if self.max_spend_usd is not None and self.max_spend_usd < 0:
            raise ManifestValidationError(f"{tool_name}: max_spend_usd must not be negative")

        # A mixed NONE + concrete declaration is almost always a mistake and
        # would silently read as "no capability" in `capabilities()`.
        for axis_name, axis in (
            ("data", self.data),
            ("network", self.network),
            ("wallet", self.wallet),
            ("side_effects", self.side_effects),
        ):
            values = [a.value for a in axis]
            if len(values) > 1 and any(v.endswith(".none") for v in values):
                raise ManifestValidationError(
                    f"{tool_name}: {axis_name} mixes an explicit .none with concrete scopes"
                )


#: Manifest applied to a tool that has not declared one. Grants nothing.
UNDECLARED = ToolPermissions()


def read_only(
    *,
    data: Sequence[DataScope] = (DataScope.READ_LOCAL,),
    network: Sequence[NetworkScope] = (NetworkScope.NONE,),
    hosts: Sequence[str] = (),
) -> ToolPermissions:
    """Shorthand for the common "reads something, changes nothing" manifest."""
    return ToolPermissions(
        data=tuple(data),
        network=tuple(network),
        hosts=tuple(hosts),
    )


# ── Grants ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PermissionGrants:
    """What the operator has actually approved for this agent.

    This is the mapping between a governance-level approval and the runtime
    check. It is intentionally coarse: capability ids plus two numeric bounds.
    """

    capabilities: frozenset[str] = frozenset()
    hosts: tuple[str, ...] = ()
    max_spend_usd: Decimal = Decimal("0")
    #: Capabilities the operator wants to see escalated even when granted.
    escalate: frozenset[str] = frozenset()

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> PermissionGrants:
        """Build grants from config/JSON. Unknown keys are ignored, not fatal —
        a newer manifest vocabulary must not break an older deployment."""
        try:
            cap = Decimal(str(raw.get("max_spend_usd", "0")))
        except (InvalidOperation, TypeError):
            cap = Decimal("0")

        return cls(
            capabilities=frozenset(str(c) for c in raw.get("capabilities", ())),
            hosts=tuple(str(h) for h in raw.get("hosts", ())),
            max_spend_usd=cap,
            escalate=frozenset(str(c) for c in raw.get("escalate", ())),
        )

    def allows_host(self, host: str) -> bool:
        return any(fnmatch.fnmatch(host, pattern) for pattern in self.hosts)


#: Grants that permit nothing. The safe default for an unconfigured agent.
NO_GRANTS = PermissionGrants()

#: Grants that mirror the pre-manifest behaviour, for the migration window only.
LEGACY_GRANTS = PermissionGrants(
    capabilities=frozenset(
        {
            DataScope.READ_LOCAL.value,
            DataScope.WRITE_LOCAL.value,
            DataScope.READ_REMOTE.value,
            DataScope.WRITE_REMOTE.value,
            NetworkScope.HTTP.value,
            NetworkScope.BROWSER.value,
            WalletScope.READ.value,
        }
    ),
    hosts=("*",),
)


# ── Enforcement ──────────────────────────────────────────────────────────────


class EnforcementMode(str, enum.Enum):
    """How the runtime reacts to a permission violation.

    ``OFF``     — no checks at all (emergency switch).
    ``AUDIT``   — evaluate and record, but always allow. **Default.**
    ``ENFORCE`` — deny on violation.
    """

    OFF = "off"
    AUDIT = "audit"
    ENFORCE = "enforce"


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    code: str
    reason: str
    tool: str
    capability: str | None = None
    requires_approval: bool = False
    #: True when the decision was downgraded to "allow" by AUDIT mode.
    would_deny: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "code": self.code,
            "reason": self.reason,
            "tool": self.tool,
            "capability": self.capability,
            "requires_approval": self.requires_approval,
            "would_deny": self.would_deny,
        }


ALLOWED = "PERMISSION_OK"
CODE_UNDECLARED = "PERMISSION_MANIFEST_MISSING"
CODE_NOT_GRANTED = "PERMISSION_NOT_GRANTED"
CODE_HOST_DENIED = "PERMISSION_HOST_NOT_ALLOWED"
CODE_SPEND_EXCEEDED = "PERMISSION_SPEND_LIMIT_EXCEEDED"
CODE_APPROVAL_REQUIRED = "PERMISSION_APPROVAL_REQUIRED"


AuditSink = Callable[[dict[str, Any]], None]


def _default_audit_sink(record: dict[str, Any]) -> None:
    logger.info("tool_permission %s", json.dumps(record, sort_keys=True, default=str))


@dataclass
class PermissionEnforcer:
    """Validates manifests at registration and evaluates them at call time."""

    grants: PermissionGrants = NO_GRANTS
    mode: EnforcementMode = EnforcementMode.AUDIT
    audit_sink: AuditSink = _default_audit_sink
    _manifests: dict[str, ToolPermissions] = field(default_factory=dict)

    # ── Registration ─────────────────────────────────────────────────────

    def register(self, tool_name: str, manifest: ToolPermissions | None) -> ToolPermissions:
        """Validate and record a tool's manifest.

        A tool with no manifest falls back to the legacy table when one exists
        for its name, and to :data:`UNDECLARED` otherwise. Raises
        :class:`ManifestValidationError` for a declared-but-invalid manifest so
        the failure surfaces at import time, not on first call.
        """
        resolved = manifest or LEGACY_TOOL_MANIFESTS.get(tool_name) or UNDECLARED
        resolved.validate(tool_name)
        self._manifests[tool_name] = resolved

        if manifest is None and tool_name not in LEGACY_TOOL_MANIFESTS:
            logger.warning(
                "tool %s registered without a permission manifest; it will be denied "
                "under EnforcementMode.ENFORCE",
                tool_name,
            )
        return resolved

    def manifest_for(self, tool_name: str) -> ToolPermissions:
        return self._manifests.get(tool_name, UNDECLARED)

    def undeclared_tools(self) -> list[str]:
        """Tools still running on the empty manifest — the migration backlog."""
        return sorted(n for n, m in self._manifests.items() if m is UNDECLARED)

    # ── Runtime check ────────────────────────────────────────────────────

    def check(
        self,
        tool_name: str,
        arguments: Mapping[str, Any] | None = None,
        *,
        approved: bool = False,
    ) -> PermissionDecision:
        """Evaluate one call. Never raises for a policy outcome — returns a
        decision the caller renders or enforces."""
        if self.mode is EnforcementMode.OFF:
            return PermissionDecision(True, ALLOWED, "enforcement disabled", tool_name)

        manifest = self.manifest_for(tool_name)
        decision = self._evaluate(tool_name, manifest, arguments or {}, approved)

        # AUDIT records the true outcome but does not act on it.
        if not decision.allowed and self.mode is EnforcementMode.AUDIT:
            decision = replace(decision, allowed=True, would_deny=True)

        self._audit(tool_name, manifest, decision)
        return decision

    def _evaluate(
        self,
        tool_name: str,
        manifest: ToolPermissions,
        arguments: Mapping[str, Any],
        approved: bool,
    ) -> PermissionDecision:
        if manifest is UNDECLARED:
            return PermissionDecision(
                False,
                CODE_UNDECLARED,
                f"{tool_name} has no permission manifest",
                tool_name,
            )

        declared = manifest.capabilities()
        missing = sorted(declared - self.grants.capabilities)
        if missing:
            return PermissionDecision(
                False,
                CODE_NOT_GRANTED,
                f"{tool_name} requires ungranted capability {missing[0]}",
                tool_name,
                capability=missing[0],
            )

        # Hosts: the manifest's allowlist must itself be covered by the grant.
        for host in manifest.hosts:
            if not self.grants.allows_host(host):
                return PermissionDecision(
                    False,
                    CODE_HOST_DENIED,
                    f"{tool_name} may contact {host}, which the operator has not allowed",
                    tool_name,
                    capability=host,
                )

        # Spend: the smaller of the manifest ceiling and the grant ceiling wins.
        if WalletScope.TRANSFER in manifest.wallet:
            requested = _extract_amount(arguments)
            ceiling = min(
                manifest.max_spend_usd or Decimal("0"),
                self.grants.max_spend_usd,
            )
            if requested is not None and requested > ceiling:
                return PermissionDecision(
                    False,
                    CODE_SPEND_EXCEEDED,
                    f"{tool_name} requested {requested} above the {ceiling} ceiling",
                    tool_name,
                    capability=WalletScope.TRANSFER.value,
                )

        needs_approval = manifest.requires_approval or bool(declared & self.grants.escalate)
        if needs_approval and not approved:
            return PermissionDecision(
                False,
                CODE_APPROVAL_REQUIRED,
                f"{tool_name} requires human approval before execution",
                tool_name,
                requires_approval=True,
            )

        return PermissionDecision(True, ALLOWED, "granted", tool_name)

    def _audit(
        self, tool_name: str, manifest: ToolPermissions, decision: PermissionDecision
    ) -> None:
        # Argument values are never recorded — only the manifest surface and the
        # outcome, so the audit trail is safe to ship to a log aggregator.
        record = {
            "ts": time.time(),
            "tool": tool_name,
            "mode": self.mode.value,
            "declared": sorted(manifest.capabilities()),
            "privileged": manifest.is_privileged(),
            **decision.to_dict(),
        }
        try:
            self.audit_sink(record)
        except Exception:  # an audit failure must never break a tool call
            logger.exception("permission audit sink failed for %s", tool_name)


def _extract_amount(arguments: Mapping[str, Any]) -> Decimal | None:
    """Best-effort read of a spend amount from tool arguments.

    Returns ``None`` when no amount is present, which leaves the spend check
    inert rather than guessing — the policy engine remains the authority on
    amounts it can see.
    """
    for key in ("amount", "amount_usd", "price", "value"):
        if key in arguments:
            try:
                return Decimal(str(arguments[key]))
            except (InvalidOperation, TypeError, ValueError):
                return None
    return None


# ── Legacy migration table ───────────────────────────────────────────────────
#
# Tools that predate manifests are classified here rather than by editing forty
# call sites. A tool listed here behaves exactly as it did before under AUDIT
# mode and is correctly constrained under ENFORCE. New tools must declare their
# manifest inline via `@tool(..., permissions=...)`; this table is frozen and
# should shrink over time, not grow.

_TALOS_HOSTS = ("*.talos.xyz", "localhost", "127.0.0.1")
_STELLAR_HOSTS = ("horizon.stellar.org", "horizon-testnet.stellar.org", "*.stellar.org")

LEGACY_TOOL_MANIFESTS: dict[str, ToolPermissions] = {
    # ── browser ──────────────────────────────────────────────────────────
    "search_web": ToolPermissions(
        data=(DataScope.NONE,),
        network=(NetworkScope.BROWSER,),
        hosts=("*",),
    ),
    "browse_page": ToolPermissions(
        data=(DataScope.NONE,),
        network=(NetworkScope.BROWSER,),
        hosts=("*",),
    ),
    "post_to_x": ToolPermissions(
        network=(NetworkScope.BROWSER,),
        hosts=("x.com", "twitter.com"),
        side_effects=(SideEffect.PUBLISH,),
    ),
    "reply_on_x": ToolPermissions(
        network=(NetworkScope.BROWSER,),
        hosts=("x.com", "twitter.com"),
        side_effects=(SideEffect.PUBLISH,),
    ),
    "check_x_mentions": ToolPermissions(
        network=(NetworkScope.BROWSER,),
        hosts=("x.com", "twitter.com"),
    ),
    "search_x": ToolPermissions(
        network=(NetworkScope.BROWSER,),
        hosts=("x.com", "twitter.com"),
    ),
    # ── internal (local DB only) ─────────────────────────────────────────
    "get_content_history": read_only(),
    "get_schedule_status": read_only(),
    "get_active_playbook": read_only(),
    "save_research_notes": ToolPermissions(data=(DataScope.WRITE_LOCAL,)),
    "record_post": ToolPermissions(data=(DataScope.WRITE_LOCAL,)),
    "get_learnings": read_only(),
    "get_audience_insights": read_only(),
    # ── web API ──────────────────────────────────────────────────────────
    "report_activity": ToolPermissions(
        data=(DataScope.WRITE_REMOTE,),
        network=(NetworkScope.HTTP,),
        hosts=_TALOS_HOSTS,
    ),
    "check_approval": ToolPermissions(
        data=(DataScope.READ_REMOTE,),
        network=(NetworkScope.HTTP,),
        hosts=_TALOS_HOSTS,
    ),
    "report_revenue": ToolPermissions(
        data=(DataScope.WRITE_REMOTE,),
        network=(NetworkScope.HTTP,),
        hosts=_TALOS_HOSTS,
    ),
    # ── stellar ──────────────────────────────────────────────────────────
    "get_xlm_balance": ToolPermissions(
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.READ,),
    ),
    "get_pulse_balance": ToolPermissions(
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.READ,),
    ),
    "transfer_xlm": ToolPermissions(
        data=(DataScope.WRITE_REMOTE,),
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.TRANSFER,),
        side_effects=(SideEffect.STATE_CHANGE,),
        max_spend_usd=Decimal("1000"),
        requires_approval=True,
    ),
    "execute_approved_transfer": ToolPermissions(
        data=(DataScope.WRITE_REMOTE,),
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.TRANSFER,),
        side_effects=(SideEffect.STATE_CHANGE,),
        max_spend_usd=Decimal("10000"),
    ),
    "create_pulse_token": ToolPermissions(
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.TOKEN_ISSUE,),
        side_effects=(SideEffect.STATE_CHANGE,),
        requires_approval=True,
    ),
    "airdrop_pulse": ToolPermissions(
        network=(NetworkScope.HTTP,),
        hosts=_STELLAR_HOSTS,
        wallet=(WalletScope.TOKEN_ISSUE,),
        side_effects=(SideEffect.STATE_CHANGE,),
        requires_approval=True,
    ),
}


def summarize_manifests(
    manifests: Mapping[str, ToolPermissions] | Iterable[tuple[str, ToolPermissions]],
) -> dict[str, Any]:
    """Operator-facing summary — what the fleet is allowed to do, at a glance."""
    items = list(manifests.items() if isinstance(manifests, Mapping) else manifests)
    return {
        "total": len(items),
        "privileged": sorted(n for n, m in items if m.is_privileged()),
        "read_only": sorted(n for n, m in items if m.is_read_only()),
        "undeclared": sorted(n for n, m in items if m is UNDECLARED),
    }
