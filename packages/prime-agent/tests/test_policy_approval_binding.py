"""Tests for binding approved action execution to the exact simulated policy digest.

Validates issue #1418:
- Persist canonical action and policy identities with approval.
- Reject execution when either changed after review.
- Support deterministic action digests, policy engine digests, and approval storage.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from talos_agent.db import LocalDB
from talos_agent.policy import (
    ActionDigestMismatchError,
    ActionSpec,
    ApprovalBindingError,
    ApprovalStatusError,
    MatchCondition,
    Policy,
    PolicyApproval,
    PolicyApprovalStore,
    PolicyDecision,
    PolicyDigestMismatchError,
    PolicyEngine,
    PolicyRule,
    PolicySimulator,
    Severity,
    compute_action_digest,
)


def _make_sample_rule(
    rule_id: str = "transfer-limit",
    threshold: float = 100.0,
    decision: PolicyDecision = PolicyDecision.ESCALATE,
    severity: Severity = Severity.HIGH,
) -> PolicyRule:
    return PolicyRule(
        rule_id=rule_id,
        description=f"Limit transfers to {threshold}",
        conditions=(
            MatchCondition(field="action", operator="eq", value="transfer_xlm"),
            MatchCondition(field="params.amount", operator="gt", value=threshold),
        ),
        decision=decision,
        severity=severity,
        reason=f"Transfer exceeds {threshold} XLM",
    )


def _make_engine(threshold: float = 100.0, enabled: bool = True) -> PolicyEngine:
    engine = PolicyEngine()
    engine.enabled = enabled
    policy = Policy(
        name="transfer-policy",
        version="1.0.0",
        priority=50,
        rules=(_make_sample_rule(threshold=threshold),),
    )
    engine.load([policy])
    return engine


# ── Canonical Action Digest Tests ─────────────────────────────────────────────


def test_compute_action_digest_deterministic():
    digest1 = compute_action_digest("transfer_xlm", {"amount": 50, "to": "GB123"}, {"budget": 1000})
    digest2 = compute_action_digest("transfer_xlm", {"amount": 50, "to": "GB123"}, {"budget": 1000})
    assert digest1 == digest2
    assert len(digest1) == 64


def test_action_digest_differs_on_param_change():
    digest1 = compute_action_digest("transfer_xlm", {"amount": 50, "to": "GB123"})
    digest2 = compute_action_digest("transfer_xlm", {"amount": 500, "to": "GB123"})
    assert digest1 != digest2


def test_action_digest_differs_on_action_change():
    digest1 = compute_action_digest("transfer_xlm", {"amount": 50})
    digest2 = compute_action_digest("airdrop_pulse", {"amount": 50})
    assert digest1 != digest2


def test_action_digest_independent_of_param_order():
    digest1 = compute_action_digest("action_a", {"x": 1, "y": 2, "z": 3})
    digest2 = compute_action_digest("action_a", {"z": 3, "x": 1, "y": 2})
    assert digest1 == digest2


def test_action_spec_auto_computes_action_digest():
    spec = ActionSpec(action="purchase_service", params={"price": 25.0})
    assert spec.action_digest != ""
    expected = compute_action_digest("purchase_service", {"price": 25.0}, {})
    assert spec.action_digest == expected


# ── Canonical Policy Engine Digest Tests ──────────────────────────────────────


def test_policy_digest_deterministic():
    engine1 = _make_engine(threshold=100.0)
    engine2 = _make_engine(threshold=100.0)
    assert engine1.policy_digest == engine2.policy_digest
    assert len(engine1.policy_digest) == 64


def test_policy_digest_changes_on_rule_threshold_change():
    engine1 = _make_engine(threshold=100.0)
    engine2 = _make_engine(threshold=200.0)
    assert engine1.policy_digest != engine2.policy_digest


def test_policy_digest_changes_on_new_rule():
    engine = _make_engine(threshold=100.0)
    initial_digest = engine.policy_digest

    new_rule = PolicyRule(
        rule_id="airdrop-limit",
        description="Limit airdrop",
        conditions=(MatchCondition(field="action", operator="eq", value="airdrop_pulse"),),
        decision=PolicyDecision.DENY,
        severity=Severity.BLOCKER,
        reason="No airdrops",
    )
    updated_policy = Policy(
        name="transfer-policy",
        version="1.0.0",
        priority=50,
        rules=(_make_sample_rule(threshold=100.0), new_rule),
    )
    engine.load([updated_policy])
    assert engine.policy_digest != initial_digest


def test_policy_digest_changes_on_policy_disabled():
    engine = _make_engine(threshold=100.0)
    initial_digest = engine.policy_digest

    disabled_policy = Policy(
        name="transfer-policy",
        version="1.0.0",
        priority=50,
        enabled=False,
        rules=(_make_sample_rule(threshold=100.0),),
    )
    engine.load([disabled_policy])
    assert engine.policy_digest != initial_digest


def test_policy_digest_changes_on_priority_change():
    engine = _make_engine(threshold=100.0)
    initial_digest = engine.policy_digest

    reprioritized = Policy(
        name="transfer-policy",
        version="1.0.0",
        priority=100,
        rules=(_make_sample_rule(threshold=100.0),),
    )
    engine.load([reprioritized])
    assert engine.policy_digest != initial_digest


# ── Simulator Approval Binding Tests ──────────────────────────────────────────


def test_simulator_create_approval_binds_exact_digests():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    action = "transfer_xlm"
    params = {"amount": 150.0, "to": "G_RECIPIENT"}
    sim_result, approval = sim.create_approval(
        action=action,
        params=params,
        approval_id="app-1234",
    )

    assert sim_result.simulation is True
    assert sim_result.decision == PolicyDecision.ESCALATE
    assert approval.approval_id == "app-1234"
    assert approval.action == action
    assert approval.params == params
    assert approval.action_digest == sim_result.action_digest
    assert approval.policy_digest == engine.policy_digest
    assert approval.simulated_result_digest == sim_result.result_digest
    assert approval.status == "pending"


# ── Verification and Rejection on Tampering / Change Tests ────────────────────


def test_verify_approved_execution_happy_path():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    action = "transfer_xlm"
    params = {"amount": 150.0, "to": "G_RECIPIENT"}
    _, approval = sim.create_approval(action, params)

    # Reviewer approves
    approval.approve(decided_by="admin_alice", reason="Approved for dividend distribution")
    assert approval.is_approved

    # Execution matches exact action, params, and policy
    spec = ActionSpec(action=action, params=params)
    assert engine.verify_approved_execution(approval, spec) is True
    assert sim.verify_execution(approval, action, params) is True


def test_verify_approved_execution_rejects_unapproved_status():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)
    action = "transfer_xlm"
    params = {"amount": 150.0}

    # Status remains pending
    _, approval = sim.create_approval(action, params)
    assert approval.status == "pending"

    spec = ActionSpec(action=action, params=params)
    with pytest.raises(ApprovalStatusError) as exc_info:
        engine.verify_approved_execution(approval, spec)
    assert "cannot be executed with status 'pending'" in str(exc_info.value)
    assert engine.verify_approved_execution(approval, spec, raise_on_mismatch=False) is False

    # Reviewer rejected
    approval.reject(decided_by="admin_bob", reason="Too high")
    assert approval.status == "rejected"
    with pytest.raises(ApprovalStatusError) as exc_info:
        engine.verify_approved_execution(approval, spec)
    assert "cannot be executed with status 'rejected'" in str(exc_info.value)


def test_verify_approved_execution_rejects_action_name_tampering():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    _, approval = sim.create_approval("transfer_xlm", {"amount": 150.0})
    approval.approve(decided_by="operator")

    # Attacker tries to execute different action under the same approval
    tampered_spec = ActionSpec("airdrop_pulse", {"amount": 150.0})
    with pytest.raises(ActionDigestMismatchError) as exc_info:
        engine.verify_approved_execution(approval, tampered_spec)
    assert "Action or parameters changed after review" in str(exc_info.value)
    assert engine.verify_approved_execution(approval, tampered_spec, raise_on_mismatch=False) is False


def test_verify_approved_execution_rejects_param_tampering():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    _, approval = sim.create_approval("transfer_xlm", {"amount": 150.0, "to": "G_LEGIT"})
    approval.approve(decided_by="operator")

    # Attacker modifies amount from 150 to 1500
    tampered_spec = ActionSpec("transfer_xlm", {"amount": 1500.0, "to": "G_LEGIT"})
    with pytest.raises(ActionDigestMismatchError) as exc_info:
        engine.verify_approved_execution(approval, tampered_spec)
    assert "Action or parameters changed after review" in str(exc_info.value)
    assert engine.verify_approved_execution(approval, tampered_spec, raise_on_mismatch=False) is False

    # Attacker modifies recipient address
    tampered_recipient = ActionSpec("transfer_xlm", {"amount": 150.0, "to": "G_ATTACKER"})
    with pytest.raises(ActionDigestMismatchError):
        engine.verify_approved_execution(approval, tampered_recipient)


def test_verify_approved_execution_rejects_policy_modified_after_review():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    action = "transfer_xlm"
    params = {"amount": 150.0}
    _, approval = sim.create_approval(action, params)
    approval.approve(decided_by="operator")

    # An administrator tightened policy threshold to 50 after simulation/review
    tightened_policy = Policy(
        name="transfer-policy",
        version="1.0.0",
        priority=50,
        rules=(_make_sample_rule(threshold=50.0),),
    )
    engine.load([tightened_policy])

    spec = ActionSpec(action=action, params=params)
    with pytest.raises(PolicyDigestMismatchError) as exc_info:
        engine.verify_approved_execution(approval, spec)
    assert "Policies changed after review" in str(exc_info.value)
    assert engine.verify_approved_execution(approval, spec, raise_on_mismatch=False) is False
    assert issubclass(PolicyDigestMismatchError, ApprovalBindingError)


# ── evaluate_approved Decision and Evidence Tests ─────────────────────────────


def test_evaluate_approved_returns_approved_on_valid_match():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)
    action = "transfer_xlm"
    params = {"amount": 150.0}

    _, approval = sim.create_approval(action, params, approval_id="app-valid")
    approval.approve(decided_by="operator")

    spec = ActionSpec(action, params)
    result = engine.evaluate_approved(approval, spec)

    assert result.decision == PolicyDecision.APPROVE
    assert any("Approved execution verified" in ev for ev in result.evidence)
    assert result.policy_digest == engine.policy_digest
    assert result.action_digest == spec.action_digest


def test_evaluate_approved_returns_denied_on_action_mismatch():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    _, approval = sim.create_approval("transfer_xlm", {"amount": 50.0}, approval_id="app-tamper")
    approval.approve(decided_by="operator")

    tampered_spec = ActionSpec("transfer_xlm", {"amount": 500.0})
    result = engine.evaluate_approved(approval, tampered_spec)

    assert result.decision == PolicyDecision.DENY
    assert any("action_digest_mismatch" in ev for ev in result.evidence)


def test_evaluate_approved_returns_denied_on_policy_mismatch():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    _, approval = sim.create_approval("transfer_xlm", {"amount": 50.0}, approval_id="app-policy-change")
    approval.approve(decided_by="operator")

    # Modify policy
    engine.load([Policy(name="transfer-policy", rules=())])

    spec = ActionSpec("transfer_xlm", {"amount": 50.0})
    result = engine.evaluate_approved(approval, spec)

    assert result.decision == PolicyDecision.DENY
    assert any("policy_digest_mismatch" in ev for ev in result.evidence)


def test_evaluate_approved_returns_denied_on_unapproved_status():
    engine = _make_engine(threshold=100.0)
    sim = PolicySimulator(engine)

    _, approval = sim.create_approval("transfer_xlm", {"amount": 50.0}, approval_id="app-pending")
    spec = ActionSpec("transfer_xlm", {"amount": 50.0})

    result = engine.evaluate_approved(approval, spec)
    assert result.decision == PolicyDecision.DENY
    assert any("approval_status_invalid" in ev for ev in result.evidence)


# ── Persistence and Roundtrip Tests ───────────────────────────────────────────


def test_policy_approval_serialization_roundtrip():
    approval = PolicyApproval(
        approval_id="app-roundtrip-1",
        action="purchase_service",
        params={"service": "research", "budget": 20.0},
        context={"caller": "agent-1"},
        policy_digest="a" * 64,
        simulated_result_digest="b" * 64,
        decision=PolicyDecision.ESCALATE,
        status="approved",
        decided_by="patron_99",
        reason="Approved for trial",
        metadata={"priority": "high"},
    )
    d = approval.to_dict()
    restored = PolicyApproval.from_dict(d)

    assert restored.approval_id == approval.approval_id
    assert restored.action == approval.action
    assert restored.params == approval.params
    assert restored.context == approval.context
    assert restored.action_digest == approval.action_digest
    assert restored.policy_digest == approval.policy_digest
    assert restored.simulated_result_digest == approval.simulated_result_digest
    assert restored.decision == approval.decision
    assert restored.status == approval.status
    assert restored.decided_by == approval.decided_by
    assert restored.reason == approval.reason
    assert restored.metadata == approval.metadata


def test_policy_approval_store_in_memory():
    store = PolicyApprovalStore()
    approval = PolicyApproval(
        approval_id="app-mem-1",
        action="transfer_xlm",
        params={"amount": 42.0},
        policy_digest="c" * 64,
        status="pending",
    )
    store.save(approval)

    fetched = store.get("app-mem-1")
    assert fetched is not None
    assert fetched.approval_id == "app-mem-1"
    assert fetched.action_digest == approval.action_digest

    assert len(store.list_pending()) == 1
    updated = store.update_status("app-mem-1", "approved", decided_by="admin_carol", reason="looks good")
    assert updated is not None
    assert updated.status == "approved"
    assert updated.decided_by == "admin_carol"
    assert len(store.list_pending()) == 0


def test_localdb_policy_approval_persistence():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test_approvals.db"
        db = LocalDB(db_path)
        try:
            approval = PolicyApproval(
                approval_id="app-db-1",
                action="transfer_xlm",
                params={"amount": 75.0, "to": "G_TEST"},
                policy_digest="d" * 64,
                simulated_result_digest="e" * 64,
                status="pending",
                reason="Waiting for review",
            )
            db.save_policy_approval(approval)

            # Retrieve and verify all digests and parameters are persisted
            restored = db.get_policy_approval("app-db-1")
            assert restored is not None
            assert restored.approval_id == "app-db-1"
            assert restored.action == "transfer_xlm"
            assert restored.params == {"amount": 75.0, "to": "G_TEST"}
            assert restored.action_digest == approval.action_digest
            assert restored.policy_digest == "d" * 64
            assert restored.simulated_result_digest == "e" * 64
            assert restored.status == "pending"

            # Update approval status to approved and verify
            db.update_approval_status("app-db-1", "approved")
            restored2 = db.get_policy_approval("app-db-1")
            assert restored2 is not None
            assert restored2.status == "approved"

            # Store with DB backend
            store = PolicyApprovalStore(db=db)
            store_fetched = store.get("app-db-1")
            assert store_fetched is not None
            assert store_fetched.action_digest == approval.action_digest
        finally:
            db.close()
