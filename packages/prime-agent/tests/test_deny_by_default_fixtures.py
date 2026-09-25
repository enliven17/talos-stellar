"""Deny-by-default regression fixtures for tool permissions and adapter sandboxing.

The cases live as data under ``tests/fixtures/policy/deny_by_default/`` so that
contributors can add a regression by appending a JSON object, and operators can
read the file as a catalogue of what the runtime refuses and why. This module
only interprets the fixtures; it deliberately contains no per-case logic.

Every fixture runs against dependency-free fakes: no network, no secrets store,
and only a throwaway SQLite file for the sandbox's invocation store.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from talos_agent.adapters.capability import (
    AdapterResourceLimits,
    AdapterSandbox,
    CapabilityDeniedError,
    CapabilityGuard,
    ManifestValidationError as AdapterManifestValidationError,
    SandboxedHTTPClient,
    default_manifests,
    load_manifests,
)
from talos_agent.db import LocalDB
from talos_agent.tools import permissions as perms
from talos_agent.tools.permissions import (
    LEGACY_GRANTS,
    LEGACY_TOOL_MANIFESTS,
    NO_GRANTS,
    DataScope,
    EnforcementMode,
    NetworkScope,
    PermissionEnforcer,
    PermissionGrants,
    SideEffect,
    ToolPermissions,
    WalletScope,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "policy" / "deny_by_default"
SUPPORTED_SCHEMA_VERSION = 1

#: Planted in every tool call's arguments and every secret lookup. It must never
#: surface in a decision, an audit record, an exception message, or a log line.
CANARY = "SCANARYDONOTLOG7Q4ZV2XK"


def _load(name: str) -> dict[str, Any]:
    data = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
    assert data.get("schema_version") == SUPPORTED_SCHEMA_VERSION, (
        f"{name}: unsupported fixture schema_version {data.get('schema_version')!r}"
    )
    return data


TOOL_FIXTURES = _load("tool_permissions.json")
ADAPTER_FIXTURES = _load("adapter_capabilities.json")


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [c["id"] for c in cases]


# ── Fixture hygiene ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "cases",
    [
        TOOL_FIXTURES["cases"],
        ADAPTER_FIXTURES["cases"],
        ADAPTER_FIXTURES["invalid_manifests"],
    ],
    ids=["tool_permissions", "adapter_cases", "adapter_invalid_manifests"],
)
def test_fixture_ids_are_unique_and_slugged(cases: list[dict[str, Any]]):
    ids = _ids(cases)
    assert len(ids) == len(set(ids)), "duplicate fixture id"
    for case_id in ids:
        assert case_id and case_id == case_id.strip().lower()
        assert " " not in case_id


def test_fixtures_contain_no_secret_material():
    """Fixtures are committed; nothing in them may look like a Stellar seed."""
    for name in ("tool_permissions.json", "adapter_capabilities.json"):
        text = (FIXTURE_DIR / name).read_text(encoding="utf-8")
        for token in text.replace('"', " ").split():
            assert not (
                len(token) == 56 and token.startswith("S") and token.isalnum()
            ), f"{name} contains something shaped like a Stellar secret seed"


def test_every_denial_code_has_a_fixture():
    """Adding a new denial code without a regression fixture fails here."""
    codes = {
        value
        for name, value in vars(perms).items()
        if name.startswith("CODE_") and isinstance(value, str)
    }
    covered = {c["expect"]["code"] for c in TOOL_FIXTURES["cases"]}
    assert codes <= covered, f"denial codes without fixtures: {sorted(codes - covered)}"


def test_fixtures_are_majority_negative():
    """The corpus exists to pin denials; positives are controls, not the point."""
    cases = TOOL_FIXTURES["cases"]
    denied = [
        c for c in cases if not c["expect"]["allowed"] or c["expect"].get("would_deny")
    ]
    assert len(denied) * 2 > len(cases)


# ── Tool permission fixtures ─────────────────────────────────────────────────

_SCOPE_ENUMS = {
    "data": DataScope,
    "network": NetworkScope,
    "wallet": WalletScope,
    "side_effects": SideEffect,
}


def _build_manifest(spec: dict[str, Any] | None, tool: str) -> ToolPermissions | None:
    if spec is None:
        return None
    if "legacy" in spec:
        assert spec["legacy"] in LEGACY_TOOL_MANIFESTS, f"{tool}: unknown legacy tool"
        return LEGACY_TOOL_MANIFESTS[spec["legacy"]]
    kwargs: dict[str, Any] = {}
    for axis, enum_cls in _SCOPE_ENUMS.items():
        if axis in spec:
            kwargs[axis] = tuple(enum_cls(v) for v in spec[axis])
    if "hosts" in spec:
        kwargs["hosts"] = tuple(spec["hosts"])
    if "max_spend_usd" in spec:
        kwargs["max_spend_usd"] = Decimal(spec["max_spend_usd"])
    if "requires_approval" in spec:
        kwargs["requires_approval"] = bool(spec["requires_approval"])
    return ToolPermissions(**kwargs)


def _build_grants(spec: str | dict[str, Any]) -> PermissionGrants:
    if spec == "NO_GRANTS":
        return NO_GRANTS
    if spec == "LEGACY_GRANTS":
        return LEGACY_GRANTS
    assert isinstance(spec, dict), f"unknown grants alias {spec!r}"
    return PermissionGrants.from_mapping(spec)


@pytest.mark.parametrize(
    "case", TOOL_FIXTURES["cases"], ids=_ids(TOOL_FIXTURES["cases"])
)
def test_tool_permission_fixture(
    case: dict[str, Any], caplog: pytest.LogCaptureFixture
):
    records: list[dict[str, Any]] = []
    enforcer = PermissionEnforcer(
        grants=_build_grants(case["grants"]),
        mode=EnforcementMode(case.get("mode", "enforce")),
        audit_sink=records.append,
    )
    tool = case["tool"]
    with caplog.at_level("DEBUG"):
        enforcer.register(tool, _build_manifest(case["manifest"], tool))
        arguments = {**case.get("arguments", {}), "memo": CANARY}
        decision = enforcer.check(tool, arguments, approved=case.get("approved", False))

    expect = case["expect"]
    assert decision.allowed is expect["allowed"], decision.reason
    assert decision.code == expect["code"], decision.reason
    assert decision.capability == expect["capability"]
    assert decision.would_deny is expect.get("would_deny", False)
    assert decision.requires_approval is expect.get("requires_approval", False)
    assert decision.tool == tool

    # A denial always explains itself without echoing the caller's arguments.
    if not decision.allowed or decision.would_deny:
        assert decision.reason
    rendered = json.dumps([decision.to_dict(), records], default=str)
    assert CANARY not in rendered
    assert CANARY not in caplog.text

    # OFF short-circuits before the audit sink; every other mode audits once.
    if enforcer.mode is EnforcementMode.OFF:
        assert records == []
    else:
        assert len(records) == 1
        assert records[0]["code"] == expect["code"]
        assert records[0]["mode"] == enforcer.mode.value


def test_audit_sink_failure_does_not_turn_denial_into_allow():
    def exploding_sink(_record: dict[str, Any]) -> None:
        raise RuntimeError(f"sink down {CANARY}")

    enforcer = PermissionEnforcer(
        mode=EnforcementMode.ENFORCE, audit_sink=exploding_sink
    )
    enforcer.register("mystery_tool", None)
    decision = enforcer.check("mystery_tool", {"memo": CANARY})
    assert not decision.allowed
    assert decision.code == perms.CODE_UNDECLARED


def test_denial_is_stable_across_repeated_checks():
    """Retrying a denied call must not eventually succeed (no hidden counters)."""
    enforcer = PermissionEnforcer(
        mode=EnforcementMode.ENFORCE, audit_sink=lambda _r: None
    )
    enforcer.register("mystery_tool", None)
    decisions = {enforcer.check("mystery_tool").code for _ in range(25)}
    assert decisions == {perms.CODE_UNDECLARED}


def test_unregistered_tool_is_treated_as_undeclared():
    enforcer = PermissionEnforcer(
        grants=LEGACY_GRANTS, mode=EnforcementMode.ENFORCE, audit_sink=lambda _r: None
    )
    decision = enforcer.check("never_registered")
    assert not decision.allowed
    assert decision.code == perms.CODE_UNDECLARED


# ── Adapter capability fixtures ──────────────────────────────────────────────


def _secret_resolver(name: str) -> str:
    # Every resolvable secret is the canary, so any leak is detectable.
    return f"{name}:{CANARY}"


def _manifests_for(case: dict[str, Any], root: Path):
    raw = case["overrides"].replace("{root}", str(root))
    return load_manifests(raw, defaults=default_manifests(AdapterResourceLimits()))


def _run_check(
    sandbox: AdapterSandbox, adapter: str, check: dict[str, Any], root: Path
) -> None:
    kind = check["kind"]
    if kind == "manifest":
        sandbox.manifest(adapter)
    elif kind == "secret":
        value = sandbox.secrets(adapter).get(check["name"])
        assert value == _secret_resolver(check["name"])
    elif kind == "network":
        SandboxedHTTPClient(sandbox.manifest(adapter))._authorize(
            check["method"], check["url"]
        )
    elif kind == "tool":
        CapabilityGuard(sandbox.manifest(adapter)).authorize_tool(check["name"])
    elif kind == "path":
        path = check["path"].replace("{root}", str(root))
        CapabilityGuard(sandbox.manifest(adapter)).authorize_path(
            path, write=check.get("write", False)
        )
    else:  # pragma: no cover - guards against typos in fixtures
        raise AssertionError(f"unknown check kind {kind!r}")


def _adapter_checks() -> list[Any]:
    params = []
    for case in ADAPTER_FIXTURES["cases"]:
        for index, check in enumerate(case["checks"]):
            label = check.get("name") or check.get("url") or check.get("path") or ""
            params.append(
                pytest.param(
                    case,
                    check,
                    id=f"{case['id']}[{index}:{check['kind']}:{check['expect']}:{label}]",
                )
            )
    return params


@pytest.mark.parametrize(("case", "check"), _adapter_checks())
def test_adapter_capability_fixture(
    case: dict[str, Any],
    check: dict[str, Any],
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
):
    root = tmp_path.resolve()
    (root / "in").mkdir()
    sandbox = AdapterSandbox(
        manifests=_manifests_for(case, root),
        db=LocalDB(path=tmp_path / "sandbox.db"),
        secret_resolver=_secret_resolver,
    )

    assert check["expect"] in ("allow", "deny")
    with caplog.at_level("DEBUG"):
        if check["expect"] == "deny":
            with pytest.raises(CapabilityDeniedError) as excinfo:
                _run_check(sandbox, case["adapter"], check, root)
            message = str(excinfo.value)
            assert message
            assert CANARY not in message
            if check["kind"] == "network" and check["url"]:
                # Denial messages name the capability, not the destination.
                assert check["url"] not in message
        else:
            _run_check(sandbox, case["adapter"], check, root)
    assert CANARY not in caplog.text


@pytest.mark.parametrize(
    "case",
    ADAPTER_FIXTURES["invalid_manifests"],
    ids=_ids(ADAPTER_FIXTURES["invalid_manifests"]),
)
def test_invalid_adapter_manifest_is_rejected(case: dict[str, Any]):
    defaults = default_manifests(AdapterResourceLimits())
    with pytest.raises(AdapterManifestValidationError):
        load_manifests(case["raw"], defaults=defaults)


def test_oversized_adapter_manifest_is_rejected():
    raw = json.dumps({"custom": {"operations": ["post"], "secrets": ["a" * 100] * 700}})
    assert len(raw.encode("utf-8")) > 65536
    with pytest.raises(AdapterManifestValidationError, match="exceeds"):
        load_manifests(raw, defaults=default_manifests(AdapterResourceLimits()))


@pytest.mark.parametrize("raw", ["", "   ", "\n"])
def test_blank_adapter_overrides_keep_reviewed_defaults(raw: str):
    defaults = default_manifests(AdapterResourceLimits())
    assert load_manifests(raw, defaults=defaults) == defaults


def test_rejected_override_does_not_partially_apply():
    """A bad second adapter must not leave the first one's grants in effect."""
    defaults = default_manifests(AdapterResourceLimits())
    raw = json.dumps(
        {
            "custom": {"operations": ["post"], "secrets": ["telegram_bot_token"]},
            "broken": {"network": [{"host": "*"}]},
        }
    )
    with pytest.raises(AdapterManifestValidationError):
        load_manifests(raw, defaults=defaults)
    assert "custom" not in defaults
