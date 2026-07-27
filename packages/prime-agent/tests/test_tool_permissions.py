"""Tests for tool permission manifests — validation, grants, enforcement, audit."""

from __future__ import annotations

import asyncio
from decimal import Decimal

import pytest

from talos_agent.tools.permissions import (
    CODE_APPROVAL_REQUIRED,
    CODE_HOST_DENIED,
    CODE_NOT_GRANTED,
    CODE_SPEND_EXCEEDED,
    CODE_UNDECLARED,
    LEGACY_GRANTS,
    NO_GRANTS,
    UNDECLARED,
    DataScope,
    EnforcementMode,
    ManifestValidationError,
    NetworkScope,
    PermissionEnforcer,
    PermissionGrants,
    SideEffect,
    ToolPermissions,
    WalletScope,
    summarize_manifests,
)
from talos_agent.tools.registry import ToolRegistry


# ── Manifest validation ──────────────────────────────────────────────────────


def test_network_scope_requires_host_allowlist():
    manifest = ToolPermissions(network=(NetworkScope.HTTP,))
    with pytest.raises(ManifestValidationError, match="host allowlist"):
        manifest.validate("fetch_thing")


def test_hosts_without_network_scope_rejected():
    manifest = ToolPermissions(hosts=("example.com",))
    with pytest.raises(ManifestValidationError, match="no network scope"):
        manifest.validate("fetch_thing")


def test_transfer_requires_positive_spend_ceiling():
    manifest = ToolPermissions(wallet=(WalletScope.TRANSFER,))
    with pytest.raises(ManifestValidationError, match="max_spend_usd"):
        manifest.validate("pay")

    ToolPermissions(
        wallet=(WalletScope.TRANSFER,), max_spend_usd=Decimal("10")
    ).validate("pay")


def test_mixing_none_with_concrete_scope_rejected():
    manifest = ToolPermissions(data=(DataScope.NONE, DataScope.READ_LOCAL))
    with pytest.raises(ManifestValidationError, match="mixes an explicit .none"):
        manifest.validate("mixed")


def test_host_pattern_must_be_bare_hostname():
    manifest = ToolPermissions(network=(NetworkScope.HTTP,), hosts=("https://x.com/path",))
    with pytest.raises(ManifestValidationError, match="invalid host pattern"):
        manifest.validate("fetch")


def test_capabilities_excludes_none_members():
    manifest = ToolPermissions(
        data=(DataScope.READ_LOCAL,),
        network=(NetworkScope.NONE,),
        wallet=(WalletScope.NONE,),
    )
    assert manifest.capabilities() == frozenset({"data.read_local"})
    assert manifest.is_read_only()
    assert not manifest.is_privileged()


def test_privileged_detection():
    manifest = ToolPermissions(
        network=(NetworkScope.HTTP,),
        hosts=("*.stellar.org",),
        wallet=(WalletScope.TRANSFER,),
        max_spend_usd=Decimal("5"),
    )
    manifest.validate("transfer")
    assert manifest.is_privileged()
    assert not manifest.is_read_only()


# ── Enforcement ──────────────────────────────────────────────────────────────


def _enforcer(mode=EnforcementMode.ENFORCE, grants=None) -> PermissionEnforcer:
    records: list[dict] = []
    enf = PermissionEnforcer(
        grants=grants if grants is not None else LEGACY_GRANTS,
        mode=mode,
        audit_sink=records.append,
    )
    enf.records = records  # type: ignore[attr-defined]
    return enf


def test_undeclared_tool_denied_under_enforce():
    enf = _enforcer()
    enf.register("mystery_tool", None)

    decision = enf.check("mystery_tool", {})
    assert not decision.allowed
    assert decision.code == CODE_UNDECLARED


def test_undeclared_tool_allowed_but_flagged_under_audit():
    enf = _enforcer(mode=EnforcementMode.AUDIT)
    enf.register("mystery_tool", None)

    decision = enf.check("mystery_tool", {})
    assert decision.allowed
    assert decision.would_deny
    assert decision.code == CODE_UNDECLARED


def test_off_mode_skips_evaluation_entirely():
    enf = _enforcer(mode=EnforcementMode.OFF)
    enf.register("mystery_tool", None)

    decision = enf.check("mystery_tool", {})
    assert decision.allowed
    assert not decision.would_deny
    assert enf.records == []  # type: ignore[attr-defined]


def test_ungranted_capability_denied():
    enf = _enforcer(grants=PermissionGrants(capabilities=frozenset({"data.read_local"})))
    enf.register(
        "writer",
        ToolPermissions(data=(DataScope.WRITE_LOCAL,)),
    )

    decision = enf.check("writer", {})
    assert not decision.allowed
    assert decision.code == CODE_NOT_GRANTED
    assert decision.capability == "data.write_local"


def test_host_outside_grant_denied():
    enf = _enforcer(
        grants=PermissionGrants(
            capabilities=frozenset({"network.http"}),
            hosts=("*.stellar.org",),
        )
    )
    enf.register(
        "fetch_evil",
        ToolPermissions(network=(NetworkScope.HTTP,), hosts=("evil.example",)),
    )

    decision = enf.check("fetch_evil", {})
    assert not decision.allowed
    assert decision.code == CODE_HOST_DENIED


def test_host_glob_matches_grant():
    enf = _enforcer(
        grants=PermissionGrants(
            capabilities=frozenset({"network.http"}),
            hosts=("*.stellar.org",),
        )
    )
    enf.register(
        "fetch_horizon",
        ToolPermissions(network=(NetworkScope.HTTP,), hosts=("horizon.stellar.org",)),
    )

    assert enf.check("fetch_horizon", {}).allowed


def test_spend_ceiling_is_the_smaller_of_manifest_and_grant():
    enf = _enforcer(
        grants=PermissionGrants(
            capabilities=frozenset(
                {"network.http", "wallet.transfer", "side_effect.state"}
            ),
            hosts=("*.stellar.org",),
            max_spend_usd=Decimal("25"),
        )
    )
    enf.register(
        "pay",
        ToolPermissions(
            network=(NetworkScope.HTTP,),
            hosts=("horizon.stellar.org",),
            wallet=(WalletScope.TRANSFER,),
            side_effects=(SideEffect.STATE_CHANGE,),
            max_spend_usd=Decimal("1000"),
        ),
    )

    # Grant ceiling (25) wins over the manifest's 1000.
    assert enf.check("pay", {"amount": "20"}).allowed

    denied = enf.check("pay", {"amount": "30"})
    assert not denied.allowed
    assert denied.code == CODE_SPEND_EXCEEDED


def test_missing_amount_leaves_spend_check_inert():
    enf = _enforcer(
        grants=PermissionGrants(
            capabilities=frozenset({"wallet.transfer"}),
            max_spend_usd=Decimal("1"),
        )
    )
    enf.register(
        "pay",
        ToolPermissions(wallet=(WalletScope.TRANSFER,), max_spend_usd=Decimal("1")),
    )

    # No amount to compare — the check does not guess.
    assert enf.check("pay", {}).allowed


def test_approval_required_until_approved():
    enf = _enforcer(grants=PermissionGrants(capabilities=frozenset({"data.read_local"})))
    enf.register(
        "sensitive",
        ToolPermissions(data=(DataScope.READ_LOCAL,), requires_approval=True),
    )

    denied = enf.check("sensitive", {})
    assert not denied.allowed
    assert denied.code == CODE_APPROVAL_REQUIRED
    assert denied.requires_approval

    assert enf.check("sensitive", {}, approved=True).allowed


def test_escalate_grant_forces_approval_for_granted_capability():
    enf = _enforcer(
        grants=PermissionGrants(
            capabilities=frozenset({"side_effect.publish"}),
            escalate=frozenset({"side_effect.publish"}),
        )
    )
    enf.register("post", ToolPermissions(side_effects=(SideEffect.PUBLISH,)))

    assert enf.check("post", {}).code == CODE_APPROVAL_REQUIRED
    assert enf.check("post", {}, approved=True).allowed


# ── Audit trail ──────────────────────────────────────────────────────────────


def test_audit_record_omits_argument_values():
    enf = _enforcer()
    enf.register("post", ToolPermissions(side_effects=(SideEffect.PUBLISH,)))

    enf.check("post", {"content": "super secret draft", "amount": "999"})

    record = enf.records[-1]  # type: ignore[attr-defined]
    serialized = str(record)
    assert "super secret draft" not in serialized
    assert "999" not in serialized
    assert record["tool"] == "post"
    assert "declared" in record


def test_audit_sink_failure_never_breaks_the_check():
    def exploding_sink(_record):
        raise RuntimeError("aggregator down")

    enf = PermissionEnforcer(
        grants=LEGACY_GRANTS, mode=EnforcementMode.ENFORCE, audit_sink=exploding_sink
    )
    enf.register("reader", ToolPermissions(data=(DataScope.READ_LOCAL,)))

    assert enf.check("reader", {}).allowed


# ── Grants parsing ───────────────────────────────────────────────────────────


def test_grants_from_mapping_ignores_unknown_keys():
    grants = PermissionGrants.from_mapping(
        {
            "capabilities": ["network.http"],
            "hosts": ["*.example.com"],
            "max_spend_usd": "12.50",
            "some_future_key": {"nested": True},
        }
    )
    assert grants.capabilities == frozenset({"network.http"})
    assert grants.max_spend_usd == Decimal("12.50")
    assert grants.allows_host("api.example.com")
    assert not grants.allows_host("api.evil.com")


def test_grants_from_mapping_tolerates_bad_spend_value():
    grants = PermissionGrants.from_mapping({"max_spend_usd": "not-a-number"})
    assert grants.max_spend_usd == Decimal("0")


# ── Registry integration (real boundary) ─────────────────────────────────────


def test_registry_denies_undeclared_tool_at_execute():
    reg = ToolRegistry()
    reg.set_permission_enforcer(
        PermissionEnforcer(grants=NO_GRANTS, mode=EnforcementMode.ENFORCE)
    )

    reg.register("nope", "undeclared tool", lambda: {"ok": True}, {}, None)

    result = asyncio.run(reg.execute("nope", {}))
    assert result["code"] == CODE_UNDECLARED
    assert result["tool"] == "nope"


def test_registry_allows_granted_tool_at_execute():
    reg = ToolRegistry()
    reg.set_permission_enforcer(
        PermissionEnforcer(
            grants=PermissionGrants(capabilities=frozenset({"data.read_local"})),
            mode=EnforcementMode.ENFORCE,
        )
    )

    reg.register(
        "reader",
        "reads local state",
        lambda: {"ok": True},
        {},
        ToolPermissions(data=(DataScope.READ_LOCAL,)),
    )

    assert asyncio.run(reg.execute("reader", {})) == {"ok": True}


def test_registry_rejects_invalid_manifest_at_registration():
    reg = ToolRegistry()
    with pytest.raises(ManifestValidationError):
        reg.register(
            "bad",
            "declares network with no hosts",
            lambda: None,
            {},
            ToolPermissions(network=(NetworkScope.HTTP,)),
        )


def test_swapping_enforcer_revalidates_existing_tools():
    reg = ToolRegistry()
    reg.register(
        "reader",
        "reads local state",
        lambda: {"ok": True},
        {},
        ToolPermissions(data=(DataScope.READ_LOCAL,)),
    )

    # Tools register at import time, before grants are known; swapping the
    # enforcer must re-resolve every manifest rather than losing them.
    strict = PermissionEnforcer(grants=NO_GRANTS, mode=EnforcementMode.ENFORCE)
    reg.set_permission_enforcer(strict)

    assert strict.manifest_for("reader").capabilities() == frozenset({"data.read_local"})
    assert not strict.check("reader", {}).allowed


def test_legacy_table_covers_pre_manifest_tools():
    enf = _enforcer()
    resolved = enf.register("transfer_xlm", None)

    assert resolved is not UNDECLARED
    assert resolved.is_privileged()
    assert enf.undeclared_tools() == []


def test_summarize_manifests_partitions_by_risk():
    summary = summarize_manifests(
        {
            "reader": ToolPermissions(data=(DataScope.READ_LOCAL,)),
            "payer": ToolPermissions(
                wallet=(WalletScope.TRANSFER,), max_spend_usd=Decimal("5")
            ),
            "unknown": UNDECLARED,
        }
    )
    assert summary["total"] == 3
    assert summary["privileged"] == ["payer"]
    assert "reader" in summary["read_only"]
    assert summary["undeclared"] == ["unknown"]
