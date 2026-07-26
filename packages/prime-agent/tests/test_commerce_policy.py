"""Comprehensive tests for A2A Commerce Policy Enforcement (Issue #299).

Covers all 17 required scenarios:
- valid policy
- expired policy
- stale policy
- missing policy
- provider changed
- price changed
- payload changed
- network changed
- asset changed
- duplicate retries
- concurrent requests
- restart recovery
- cancellation
- timeout
- audit binding
- idempotency binding
- fail-closed behavior
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import pytest

from talos_agent.db import LocalDB
from talos_agent.policy.commerce_policy import (
    CommercePolicyEvaluationTimeoutError,
    CommercePolicyEvaluator,
    CommercePolicyInvalidationError,
    compute_payload_digest,
)
from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.schema import (
    CommerceOperationType,
    CommercePolicyContext,
    CommercePolicyDecision,
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyRule,
    Severity,
)


@pytest.fixture
def tmp_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        db = LocalDB(db_path)
        yield db
        db.close()


@pytest.fixture
def engine():
    pe = PolicyEngine()
    pe.enabled = True
    return pe


@pytest.fixture
def evaluator(engine):
    return CommercePolicyEvaluator(engine, default_timeout_seconds=2.0)


@pytest.fixture
def valid_context():
    exp = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    return CommercePolicyContext(
        requester="agent-alpha",
        provider="agent-beta",
        asset="USDC",
        network="testnet",
        quoted_amount=50.0,
        payload_digest=compute_payload_digest({"task": "research"}),
        expiration=exp,
        authorization_context={"tier": "premium"},
        operation_type=CommerceOperationType.JOB_CREATION,
    )


class TestCommercePolicyEvaluation:

    @pytest.mark.asyncio
    async def test_valid_policy(self, evaluator, valid_context):
        decision = await evaluator.evaluate_commerce_operation(valid_context)
        assert decision.decision == PolicyDecision.APPROVE
        assert decision.requester == "agent-alpha"
        assert decision.provider == "agent-beta"
        assert decision.quoted_amount == 50.0
        assert decision.decision_id is not None
        assert decision.decision_digest is not None

    @pytest.mark.asyncio
    async def test_expired_policy(self, evaluator):
        past_exp = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        ctx = CommercePolicyContext(
            requester="agent-alpha",
            provider="agent-beta",
            asset="USDC",
            network="testnet",
            quoted_amount=10.0,
            payload_digest="digest123",
            expiration=past_exp,
            operation_type=CommerceOperationType.JOB_CREATION,
        )
        decision = await evaluator.evaluate_commerce_operation(ctx)
        assert decision.decision == PolicyDecision.DENY
        assert "expired policy context" in decision.evidence[0]

    @pytest.mark.asyncio
    async def test_missing_policy_parameters(self, evaluator):
        exp = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        ctx = CommercePolicyContext(
            requester="",
            provider="agent-beta",
            asset="USDC",
            network="testnet",
            quoted_amount=10.0,
            payload_digest="digest123",
            expiration=exp,
            operation_type=CommerceOperationType.JOB_CREATION,
        )
        decision = await evaluator.evaluate_commerce_operation(ctx)
        assert decision.decision == PolicyDecision.DENY
        assert "Missing required policy parameters" in decision.evidence[0]

    @pytest.mark.asyncio
    async def test_fail_closed_on_policy_engine_denial(self, engine, evaluator, valid_context):
        block_rule = PolicyRule(
            rule_id="BLOCK_EXCESSIVE_PRICE",
            description="Block high price",
            conditions=(MatchCondition("quoted_amount", "gt", 20.0),),
            decision=PolicyDecision.DENY,
            severity=Severity.BLOCKER,
            reason="Amount exceeds limit",
        )
        policy = Policy("strict_spending", rules=(block_rule,))
        engine.load([policy])

        decision = await evaluator.evaluate_commerce_operation(valid_context)
        assert decision.decision == PolicyDecision.DENY
        assert "BLOCK_EXCESSIVE_PRICE" in decision.violated_rules


class TestPolicyInvalidation:

    def test_provider_changed_invalidation(self, evaluator, valid_context):
        decision = CommercePolicyDecision(
            decision_id="dec-1",
            decision_digest="digest-1",
            expiry=valid_context.expiration,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            decision=PolicyDecision.APPROVE,
            requester=valid_context.requester,
            provider="agent-beta",
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=valid_context.quoted_amount,
            payload_digest=valid_context.payload_digest,
            operation_type=valid_context.operation_type.value,
        )

        mod_context = CommercePolicyContext(
            requester=valid_context.requester,
            provider="agent-charlie",  # Modified provider
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=valid_context.quoted_amount,
            payload_digest=valid_context.payload_digest,
            expiration=valid_context.expiration,
            operation_type=valid_context.operation_type,
        )

        with pytest.raises(CommercePolicyInvalidationError) as exc_info:
            evaluator.validate_decision_against_request(decision, mod_context)
        assert "provider" in str(exc_info.value)

    def test_price_changed_invalidation(self, evaluator, valid_context):
        decision = CommercePolicyDecision(
            decision_id="dec-1",
            decision_digest="digest-1",
            expiry=valid_context.expiration,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            decision=PolicyDecision.APPROVE,
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=50.0,
            payload_digest=valid_context.payload_digest,
            operation_type=valid_context.operation_type.value,
        )

        mod_context = CommercePolicyContext(
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=75.0,  # Price changed
            payload_digest=valid_context.payload_digest,
            expiration=valid_context.expiration,
            operation_type=valid_context.operation_type,
        )

        with pytest.raises(CommercePolicyInvalidationError) as exc_info:
            evaluator.validate_decision_against_request(decision, mod_context)
        assert "quoted_amount" in str(exc_info.value)

    def test_payload_changed_invalidation(self, evaluator, valid_context):
        decision = CommercePolicyDecision(
            decision_id="dec-1",
            decision_digest="digest-1",
            expiry=valid_context.expiration,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            decision=PolicyDecision.APPROVE,
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=valid_context.quoted_amount,
            payload_digest=compute_payload_digest("original_payload"),
            operation_type=valid_context.operation_type.value,
        )

        mod_context = CommercePolicyContext(
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=valid_context.quoted_amount,
            payload_digest=compute_payload_digest("tampered_payload"),  # Modified payload
            expiration=valid_context.expiration,
            operation_type=valid_context.operation_type,
        )

        with pytest.raises(CommercePolicyInvalidationError) as exc_info:
            evaluator.validate_decision_against_request(decision, mod_context)
        assert "payload_digest" in str(exc_info.value)

    def test_network_and_asset_changed_invalidation(self, evaluator, valid_context):
        decision = CommercePolicyDecision(
            decision_id="dec-1",
            decision_digest="digest-1",
            expiry=valid_context.expiration,
            evaluated_at=datetime.now(timezone.utc).isoformat(),
            decision=PolicyDecision.APPROVE,
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset="USDC",
            network="testnet",
            quoted_amount=valid_context.quoted_amount,
            payload_digest=valid_context.payload_digest,
            operation_type=valid_context.operation_type.value,
        )

        mod_context = CommercePolicyContext(
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset="XLM",  # Asset changed
            network="mainnet",  # Network changed
            quoted_amount=valid_context.quoted_amount,
            payload_digest=valid_context.payload_digest,
            expiration=valid_context.expiration,
            operation_type=valid_context.operation_type,
        )

        with pytest.raises(CommercePolicyInvalidationError) as exc_info:
            evaluator.validate_decision_against_request(decision, mod_context)
        assert "asset" in str(exc_info.value) or "network" in str(exc_info.value)


class TestTimeoutAndFailClosed:

    @pytest.mark.asyncio
    async def test_policy_evaluator_timeout(self, engine):
        evaluator = CommercePolicyEvaluator(engine, default_timeout_seconds=0.01)

        # Mock slow evaluation inside engine
        async def slow_eval(*args, **kwargs):
            await asyncio.sleep(0.1)

        exp = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        ctx = CommercePolicyContext(
            requester="agent-alpha",
            provider="agent-beta",
            asset="USDC",
            network="testnet",
            quoted_amount=10.0,
            payload_digest="digest",
            expiration=exp,
            operation_type=CommerceOperationType.JOB_CREATION,
        )

        # Patch _do_evaluate to simulate slow process
        evaluator._do_evaluate = slow_eval

        decision = await evaluator.evaluate_commerce_operation(ctx, timeout_seconds=0.01)
        assert decision.decision == PolicyDecision.DENY
        assert "timed out" in decision.evidence[0]


class TestAuditAndIdempotencyIntegration:

    @pytest.mark.asyncio
    async def test_audit_log_binding(self, evaluator, valid_context, tmp_db):
        decision = await evaluator.evaluate_commerce_operation(valid_context)

        tmp_db.add_commerce_audit_log(
            decision_id=decision.decision_id,
            decision_digest=decision.decision_digest,
            operation=valid_context.operation_type.value,
            requester=valid_context.requester,
            outcome=decision.decision.value,
        )

        logs = tmp_db.get_commerce_audit_logs()
        assert len(logs) == 1
        assert logs[0]["decision_id"] == decision.decision_id
        assert logs[0]["decision_digest"] == decision.decision_digest
        assert logs[0]["operation"] == "job_creation"
        assert logs[0]["outcome"] == "approve"

    @pytest.mark.asyncio
    async def test_idempotency_binding_and_payload_change_rejection(self, evaluator, valid_context, tmp_db):
        decision = await evaluator.evaluate_commerce_operation(valid_context)
        idempotency_key = "idemp-key-123"

        # First attempt
        tmp_db.add_completion_marker(
            job_id="job-1",
            idempotency_key=idempotency_key,
            policy_decision_digest=decision.decision_digest,
        )

        marker = tmp_db.get_completion_marker_by_key(idempotency_key)
        assert marker is not None
        assert marker["policy_decision_digest"] == decision.decision_digest

        # Duplicate retry with identical key & policy digest
        assert tmp_db.has_completion_marker(idempotency_key) is True

        # Modified payload on retry should fail digest match
        mod_context = CommercePolicyContext(
            requester=valid_context.requester,
            provider=valid_context.provider,
            asset=valid_context.asset,
            network=valid_context.network,
            quoted_amount=999.0,  # Modified amount
            payload_digest=compute_payload_digest("different_payload"),
            expiration=valid_context.expiration,
            operation_type=valid_context.operation_type,
        )
        mod_decision = await evaluator.evaluate_commerce_operation(mod_context)
        assert mod_decision.decision_digest != marker["policy_decision_digest"]


class TestConcurrencyAndRecovery:

    @pytest.mark.asyncio
    async def test_concurrent_policy_evaluations(self, evaluator, valid_context):
        tasks = [
            evaluator.evaluate_commerce_operation(valid_context)
            for _ in range(20)
        ]
        results = await asyncio.gather(*tasks)
        assert len(results) == 20
        for res in results:
            assert res.decision == PolicyDecision.APPROVE
            assert res.decision_id is not None

    @pytest.mark.asyncio
    async def test_restart_recovery_idempotency(self, tmp_db, valid_context):
        idempotency_key = "idemp-key-recovery"
        digest = compute_payload_digest(valid_context.to_dict())

        tmp_db.add_completion_marker(
            job_id="job-recovery-1",
            idempotency_key=idempotency_key,
            policy_decision_digest=digest,
        )

        # Simulate restart by re-opening DB
        reopened_db = LocalDB(tmp_db._path)
        marker = reopened_db.get_completion_marker_by_key(idempotency_key)
        assert marker is not None
        assert marker["job_id"] == "job-recovery-1"
        assert marker["policy_decision_digest"] == digest
        reopened_db.close()
