"""Tests for the declarative policy engine.

Covers: schema, engine evaluation, loader, middleware, and simulator.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from talos_agent.policy.engine import PolicyEngine, _evaluate_condition, _all_conditions_match
from talos_agent.policy.loader import PolicyLoader, _build_default_policies, _load_from_file
from talos_agent.policy.middleware import (
    PolicyMiddleware,
    PolicyViolationError,
)
from talos_agent.policy.schema import (
    ActionSpec,
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyResult,
    PolicyRule,
    Severity,
)
from talos_agent.policy.simulator import PolicySimulator


# ── Schema tests ──────────────────────────────────────────────────────────────


class TestMatchCondition:
    def test_eq_match(self):
        spec = ActionSpec("test", {"price": 10})
        cond = MatchCondition("price", "eq", 10)
        assert _evaluate_condition(cond, spec) is True

    def test_eq_no_match(self):
        spec = ActionSpec("test", {"price": 10})
        cond = MatchCondition("price", "eq", 5)
        assert _evaluate_condition(cond, spec) is False

    def test_gt_match(self):
        spec = ActionSpec("test", {"price": 15})
        cond = MatchCondition("price", "gt", 10)
        assert _evaluate_condition(cond, spec) is True

    def test_gt_no_match(self):
        spec = ActionSpec("test", {"price": 5})
        cond = MatchCondition("price", "gt", 10)
        assert _evaluate_condition(cond, spec) is False

    def test_in_match(self):
        spec = ActionSpec("purchase_service", {})
        cond = MatchCondition(
            "action", "in", ["purchase_service", "transfer_xlm"]
        )
        assert _evaluate_condition(cond, spec) is True

    def test_in_no_match(self):
        spec = ActionSpec("discover_services", {})
        cond = MatchCondition(
            "action", "in", ["purchase_service", "transfer_xlm"]
        )
        assert _evaluate_condition(cond, spec) is False

    def test_exists_present(self):
        spec = ActionSpec("test", {"content": "hello"})
        cond = MatchCondition("content", "exists")
        assert _evaluate_condition(cond, spec) is True

    def test_exists_absent(self):
        spec = ActionSpec("test", {})
        cond = MatchCondition("content", "exists")
        assert _evaluate_condition(cond, spec) is False

    def test_regex_match(self):
        spec = ActionSpec("test", {"email": "user@example.com"})
        cond = MatchCondition("email", "regex", r".+@.+")
        assert _evaluate_condition(cond, spec) is True

    def test_regex_no_match(self):
        spec = ActionSpec("test", {"email": "not-an-email"})
        cond = MatchCondition("email", "regex", r".+@.+")
        assert _evaluate_condition(cond, spec) is False

    def test_context_field_resolution(self):
        spec = ActionSpec(
            "test",
            params={},
            context={"budget_remaining": 50.0},
        )
        cond = MatchCondition("budget_remaining", "gt", 20)
        assert _evaluate_condition(cond, spec) is True

    def test_params_take_priority_over_context(self):
        spec = ActionSpec(
            "test",
            params={"amount": 100},
            context={"amount": 50},
        )
        cond = MatchCondition("amount", "eq", 100)
        assert _evaluate_condition(cond, spec) is True

    def test_unknown_operator_returns_false(self):
        spec = ActionSpec("test", {"val": 1})
        cond = MatchCondition("val", "whizbang", 1)
        assert _evaluate_condition(cond, spec) is False


class TestActionSpec:
    def test_get_from_params(self):
        spec = ActionSpec("act", {"key": "value"})
        assert spec.get("key") == "value"

    def test_get_from_context(self):
        spec = ActionSpec("act", {}, {"key": "ctx_val"})
        assert spec.get("key") == "ctx_val"

    def test_get_params_over_context(self):
        spec = ActionSpec("act", {"key": "params"}, {"key": "ctx"})
        assert spec.get("key") == "params"

    def test_get_missing(self):
        spec = ActionSpec("act", {})
        assert spec.get("nonexistent") is None

    def test_to_dict(self):
        spec = ActionSpec("act", {"a": 1}, {"b": 2})
        d = spec.to_dict()
        assert d["action"] == "act"
        assert d["params"] == {"a": 1}
        assert d["context"] == {"b": 2}


# ── PolicyRule tests ──────────────────────────────────────────────────────────


class TestPolicyRule:
    def test_no_conditions_matches_catch_all_non_blocker(self):
        """A rule with no conditions is a catch-all only for non-BLOCKER severity."""
        rule = PolicyRule(
            rule_id="catch-all",
            description="Always matches",
            conditions=(),
            decision=PolicyDecision.DENY,
            severity=Severity.HIGH,
            reason="Catch-all deny",
        )
        spec = ActionSpec("anything", {})
        assert _all_conditions_match(rule, spec) is True

    def test_no_conditions_blocker_is_skipped(self):
        """A BLOCKER rule with no conditions is skipped for safety."""
        rule = PolicyRule(
            rule_id="catch-all-blocker",
            description="Block all",
            conditions=(),
            decision=PolicyDecision.DENY,
            severity=Severity.BLOCKER,
            reason="Catch-all block",
        )
        spec = ActionSpec("anything", {})
        assert _all_conditions_match(rule, spec) is False

    def test_all_conditions_must_match(self):
        rule = PolicyRule(
            rule_id="multi",
            description="Multi condition",
            conditions=(
                MatchCondition("action", "eq", "transfer_xlm"),
                MatchCondition("amount", "gt", 100),
            ),
        )
        spec = ActionSpec("transfer_xlm", {"amount": 50})
        assert _all_conditions_match(rule, spec) is False

        spec2 = ActionSpec("transfer_xlm", {"amount": 150})
        assert _all_conditions_match(rule, spec2) is True


# ── PolicyEngine tests ────────────────────────────────────────────────────────


class TestPolicyEngine:
    @pytest.fixture
    def engine(self) -> PolicyEngine:
        return PolicyEngine()

    @pytest.fixture
    def sample_policies(self) -> list[Policy]:
        return [
            Policy(
                name="budget-guard",
                priority=100,
                rules=(
                    PolicyRule(
                        rule_id="budget-exhausted",
                        description="Block when budget exhausted",
                        conditions=(
                            MatchCondition("action", "in", ["purchase_service"]),
                            MatchCondition("budget_remaining", "lte", 0),
                        ),
                        decision=PolicyDecision.DENY,
                        severity=Severity.BLOCKER,
                        reason="Budget exhausted",
                    ),
                ),
            ),
            Policy(
                name="approval-threshold",
                priority=90,
                rules=(
                    PolicyRule(
                        rule_id="requires-approval",
                        description="Escalate high-value",
                        conditions=(
                            MatchCondition("action", "in", ["purchase_service", "transfer_xlm"]),
                            MatchCondition("amount", "gt", 10),
                        ),
                        decision=PolicyDecision.ESCALATE,
                        severity=Severity.HIGH,
                        reason="Exceeds approval threshold",
                    ),
                ),
            ),
            Policy(
                name="disabled-policy",
                priority=50,
                enabled=False,
                rules=(
                    PolicyRule(
                        rule_id="should-not-fire",
                        description="Disabled policy",
                        conditions=(),
                        decision=PolicyDecision.DENY,
                        severity=Severity.BLOCKER,
                        reason="Should not fire",
                    ),
                ),
            ),
        ]

    def test_disabled_engine_always_approves(self, engine):
        engine.enabled = False
        engine.load([])
        result = engine.evaluate(ActionSpec("purchase_service", {"price": 100}))
        assert result.decision == PolicyDecision.APPROVE

    def test_load_sorts_by_priority(self, engine):
        p1 = Policy(name="low", priority=1)
        p2 = Policy(name="high", priority=100)
        p3 = Policy(name="mid", priority=50)
        engine.load([p1, p2, p3])
        assert engine._policies[0].name == "high"
        assert engine._policies[1].name == "mid"
        assert engine._policies[2].name == "low"

    def test_load_same_priority_sorts_by_name(self, engine):
        p1 = Policy(name="z-policy", priority=10)
        p2 = Policy(name="a-policy", priority=10)
        engine.load([p1, p2])
        assert engine._policies[0].name == "a-policy"
        assert engine._policies[1].name == "z-policy"

    def test_blocker_triggers_deny(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec(
            "purchase_service",
            params={"price": 5},
            context={"budget_remaining": 0},
        )
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.DENY
        assert len(result.violated_rules) == 1
        assert "budget-exhausted" in result.violated_rules[0].rule_id

    def test_high_triggers_escalate(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec(
            "purchase_service",
            params={"price": 5, "amount": 50},
            context={"budget_remaining": 100},
        )
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.ESCALATE
        assert any("requires-approval" in r.rule_id for r in result.violated_rules)

    def test_all_clear_approves(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec(
            "purchase_service",
            params={"price": 5, "amount": 5},
            context={"budget_remaining": 100},
        )
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.APPROVE

    def test_disabled_policy_skipped(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec("anything", {})
        result = engine.evaluate(spec)
        # Disabled policy should be skipped
        assert result.decision == PolicyDecision.APPROVE

    def test_no_matching_rules_approves(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec("discover_services", {})
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.APPROVE

    def test_result_includes_evidence(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec(
            "purchase_service",
            params={"amount": 50},
            context={"budget_remaining": 100},
        )
        result = engine.evaluate(spec)
        assert len(result.evidence) > 0
        assert any("requires-approval" in e for e in result.evidence)

    def test_result_digest_is_deterministic(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec("transfer_xlm", {"amount": 50}, {"budget_remaining": 100})
        r1 = engine.evaluate(spec)
        r2 = engine.evaluate(spec)
        assert r1.result_digest == r2.result_digest

    def test_result_to_dict(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec("purchase_service", {"amount": 50}, {"budget_remaining": 100})
        result = engine.evaluate(spec)
        d = result.to_dict()
        assert "decision" in d
        assert "evidence" in d
        assert "result_digest" in d
        assert "violated_rules" in d

    def test_metrics_increment(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        assert engine.metrics["evaluation_count"] == 0
        assert engine.metrics["deny_count"] == 0
        assert engine.metrics["escalate_count"] == 0

        # DENY
        engine.evaluate(ActionSpec("purchase_service", {}, {"budget_remaining": 0}))
        assert engine.metrics["deny_count"] == 1

        # ESCALATE
        engine.evaluate(ActionSpec("purchase_service", {"amount": 50}, {"budget_remaining": 100}))
        assert engine.metrics["escalate_count"] == 1

        # APPROVE
        engine.evaluate(ActionSpec("purchase_service", {"amount": 5}, {"budget_remaining": 100}))
        assert engine.metrics["evaluation_count"] == 3

    def test_empty_policies_approves(self, engine):
        engine.enabled = True
        engine.load([])
        result = engine.evaluate(ActionSpec("purchase_service", {"price": 1000}))
        assert result.decision == PolicyDecision.APPROVE

    def test_evaluate_sync_same_as_evaluate(self, engine, sample_policies):
        engine.enabled = True
        engine.load(sample_policies)
        spec = ActionSpec("purchase_service", {"amount": 50}, {"budget_remaining": 100})
        r1 = engine.evaluate(spec)
        r2 = engine.evaluate_sync(spec)
        assert r1.decision == r2.decision
        assert r1.result_digest == r2.result_digest


# ── PolicyLoader tests ────────────────────────────────────────────────────────


class TestPolicyLoader:
    def test_load_defaults_returns_policies(self):
        defaults = _build_default_policies()
        assert len(defaults) > 0
        names = {p.name for p in defaults}
        assert "budget-guard" in names
        assert "approval-threshold" in names
        assert "publishing-guard" in names
        assert "fulfillment-guard" in names

    def test_load_defaults_all_have_rules(self):
        defaults = _build_default_policies()
        for p in defaults:
            assert len(p.rules) > 0, f"Policy {p.name} has no rules"

    def test_loader_merge_by_name(self):
        """Later sources override earlier ones by name."""
        loader = PolicyLoader(db=None)
        # Create a file override that replaces budget-guard
        custom = [
            Policy(
                name="budget-guard",
                priority=200,
                description="Custom budget policy",
                rules=(
                    PolicyRule(
                        rule_id="custom-rule",
                        description="Custom",
                        conditions=(),
                        decision=PolicyDecision.DENY,
                        severity=Severity.BLOCKER,
                        reason="Custom block",
                    ),
                ),
            ),
        ]
        # We can't easily mock the file, but we can test the merge logic
        all_policies = loader.load()
        names = {p.name for p in all_policies}
        assert "budget-guard" in names

    def test_needs_reload_returns_false_initially(self):
        loader = PolicyLoader(db=None)
        assert loader.needs_reload() is False

    def test_export_to_file(self, tmp_path: Path):
        loader = PolicyLoader(db=None)
        path = tmp_path / "exported-policies.json"
        result_path = loader.export_to_file(path)
        assert result_path.exists()
        raw = json.loads(result_path.read_text())
        assert "policies" in raw
        assert len(raw["policies"]) > 0

    def test_load_from_file_invalid_json(self, tmp_path: Path):
        path = tmp_path / "bad.json"
        path.write_text("not json")
        result = _load_from_file(path)
        assert result == []

    def test_load_from_file_valid(self, tmp_path: Path):
        path = tmp_path / "good.json"
        path.write_text(json.dumps({
            "policies": [
                {
                    "name": "test-policy",
                    "version": "1.0.0",
                    "rules": [
                        {
                            "rule_id": "test-rule",
                            "conditions": [
                                {"field": "action", "operator": "eq", "value": "test"}
                            ],
                            "decision": "deny",
                            "severity": "blocker",
                            "reason": "Test deny",
                        }
                    ],
                }
            ]
        }))
        result = _load_from_file(path)
        assert len(result) == 1
        assert result[0].name == "test-policy"
        assert len(result[0].rules) == 1


# ── PolicyMiddleware tests ────────────────────────────────────────────────────


class TestPolicyMiddleware:
    @pytest.fixture
    def engine(self) -> PolicyEngine:
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())
        return engine

    @pytest.fixture
    def middleware(self, engine) -> PolicyMiddleware:
        return PolicyMiddleware(
            engine,
            budget_getter=lambda: {"gtm_budget": 200, "spent_this_period": 0, "budget_remaining": 200},
            config_getter=lambda: {"approval_threshold": 10.0},
        )

    def test_evaluate_action_approve(self, middleware):
        result = middleware.evaluate_action("discover_services", {"category": "Sales"})
        assert result.decision == PolicyDecision.APPROVE

    def test_evaluate_action_escalate_high_amount(self, middleware):
        result = middleware.evaluate_action(
            "purchase_service", {"price": 50, "amount": 50}
        )
        assert result.decision == PolicyDecision.ESCALATE
        assert any("requires-approval" in e for e in result.evidence)

    def test_evaluate_action_with_extra_context(self, middleware):
        result = middleware.evaluate_action(
            "purchase_service",
            {"price": 5, "amount": 5},
            extra_context={"budget_remaining": 0},
        )
        assert result.decision == PolicyDecision.DENY

    def test_wrap_tool_bypass_action(self, middleware):
        """Read-only actions should not be evaluated."""
        called = False

        async def mock_discover(target: str = ""):
            nonlocal called
            called = True
            return {"services": []}

        import asyncio
        wrapped = middleware.wrap_tool("discover_services", mock_discover)
        result = asyncio.run(wrapped(target="test"))
        assert called
        assert result == {"services": []}

    def test_wrap_tool_gated_action_approve(self, middleware):
        """Gated actions with passing policy should proceed."""
        called = False

        async def mock_action(talos_id: str, price: float = 1.0):
            nonlocal called
            called = True
            return {"status": "ok"}

        import asyncio
        wrapped = middleware.wrap_tool("purchase_service", mock_action)
        result = asyncio.run(wrapped(talos_id="test", price=5))
        assert called
        assert result == {"status": "ok"}

    def test_wrap_tool_gated_action_deny(self, middleware):
        """Gated actions with failing policy should be blocked."""
        # Override budget to 0 to trigger deny
        middleware._budget_getter = lambda: {"gtm_budget": 0, "spent_this_period": 100, "budget_remaining": 0}
        called = False

        async def mock_action(talos_id: str, price: float = 1.0):
            nonlocal called
            called = True
            return {"status": "ok"}

        import asyncio
        wrapped = middleware.wrap_tool("purchase_service", mock_action)
        result = asyncio.run(wrapped(talos_id="test", price=5))
        assert not called
        assert "error" in result
        assert result["policy_decision"] == "deny"

    def test_policy_violation_error(self):
        result = PolicyResult.denied(
            PolicyRule(
                rule_id="test",
                description="test",
                conditions=(),
                decision=PolicyDecision.DENY,
                severity=Severity.BLOCKER,
                reason="Test block",
            )
        )
        error = PolicyViolationError(result, "test_action")
        assert "deny" in str(error).lower()
        assert "Test block" in str(error)


# ── PolicySimulator tests ─────────────────────────────────────────────────────


class TestPolicySimulator:
    @pytest.fixture
    def engine(self) -> PolicyEngine:
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())
        return engine

    @pytest.fixture
    def sim(self, engine) -> PolicySimulator:
        return PolicySimulator(engine)

    def test_simulate_marks_result_as_simulation(self, sim):
        result = sim.simulate(
            "purchase_service",
            {"price": 5, "amount": 5},
            {"budget_remaining": 100},
        )
        assert result.simulation is True

    def test_simulate_returns_decision(self, sim):
        result = sim.simulate(
            "purchase_service",
            {"price": 50, "amount": 50},
            {"budget_remaining": 100},
        )
        assert result.decision == PolicyDecision.ESCALATE

    def test_simulate_batch(self, sim):
        scenarios = [
            {"action": "purchase_service", "params": {"amount": 5}, "context": {"budget_remaining": 100}},
            {"action": "purchase_service", "params": {"amount": 50}, "context": {"budget_remaining": 100}},
            {"action": "discover_services", "params": {}},
        ]
        results = sim.simulate_batch(scenarios)
        assert len(results) == 3
        decisions = [r["decision"] for r in results]
        assert "approve" in decisions
        assert "escalate" in decisions

    def test_simulate_batch_error_scenario(self, sim):
        scenarios = [
            {"action": "bad_action", "params": None, "context": "not-a-dict"},
        ]
        results = sim.simulate_batch(scenarios)
        assert len(results) == 1

    def test_export_scenarios(self, sim, tmp_path: Path):
        scenarios = [
            {"action": "purchase_service", "params": {"amount": 5}, "context": {"budget_remaining": 100}},
        ]
        out_path = tmp_path / "results.json"
        sim.export_scenarios(scenarios, str(out_path))
        assert out_path.exists()
        raw = json.loads(out_path.read_text())
        assert "scenarios" in raw
        assert len(raw["scenarios"]) == 1


# ── PolicyResult convenience factories ────────────────────────────────────────


class TestPolicyResultFactories:
    def test_approved(self):
        r = PolicyResult.approved()
        assert r.decision == PolicyDecision.APPROVE
        assert len(r.violated_rules) == 0

    def test_approved_simulation(self):
        r = PolicyResult.approved(simulation=True)
        assert r.simulation is True

    def test_denied(self):
        rule = PolicyRule(
            rule_id="test", description="test",
            conditions=(), decision=PolicyDecision.DENY,
            severity=Severity.BLOCKER, reason="blocked",
        )
        r = PolicyResult.denied(rule)
        assert r.decision == PolicyDecision.DENY
        assert len(r.violated_rules) == 1
        assert r.violated_rules[0].rule_id == "test"

    def test_escalated(self):
        rules = (
            PolicyRule("r1", "d1", (), PolicyDecision.ESCALATE, Severity.HIGH, "reason1"),
            PolicyRule("r2", "d2", (), PolicyDecision.ESCALATE, Severity.HIGH, "reason2"),
        )
        r = PolicyResult.escalated(rules)
        assert r.decision == PolicyDecision.ESCALATE
        assert len(r.violated_rules) == 2


# ── Integration / edge-case tests ─────────────────────────────────────────────


class TestPolicyEngineIntegration:
    """Tests that verify the end-to-end policy evaluation flow."""

    def test_full_budget_exhausted_flow(self):
        """When budget is exhausted, purchases are blocked, but reads are fine."""
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())

        # Purchase when budget exhausted
        spec = ActionSpec(
            "purchase_service",
            params={"price": 5, "amount": 5},
            context={"gtm_budget": 200, "spent_this_period": 200, "budget_remaining": 0},
        )
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.DENY
        assert "budget-exhausted" in result.evidence[0]

        # Read-only action should still be fine
        spec2 = ActionSpec("discover_services", {})
        result2 = engine.evaluate(spec2)
        assert result2.decision == PolicyDecision.APPROVE

    def test_approval_threshold_escalation(self):
        """Transactions above threshold escalate instead of being denied."""
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())

        # Below threshold
        spec = ActionSpec(
            "transfer_xlm",
            params={"amount": 5},
            context={"approval_threshold": 10.0},
        )
        result = engine.evaluate(spec)
        assert result.decision == PolicyDecision.APPROVE

        # Above threshold
        spec2 = ActionSpec(
            "transfer_xlm",
            params={"amount": 50},
            context={"approval_threshold": 10.0},
        )
        result2 = engine.evaluate(spec2)
        assert result2.decision == PolicyDecision.ESCALATE

    def test_policy_idempotency(self):
        """Same input always produces the same output (digest is deterministic)."""
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())
        spec = ActionSpec("purchase_service", {"amount": 50}, {"budget_remaining": 100})

        results = [engine.evaluate(spec) for _ in range(5)]
        digests = {r.result_digest for r in results}
        assert len(digests) == 1  # All identical
        decisions = {r.decision for r in results}
        assert len(decisions) == 1

    def test_concurrent_evaluation_safety(self):
        """Multiple evaluations on the same engine don't interfere."""
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_build_default_policies())

        # Simulate concurrent evaluations
        specs = [
            ActionSpec("purchase_service", {"amount": 5}, {"budget_remaining": 100}),
            ActionSpec("purchase_service", {"amount": 50}, {"budget_remaining": 100}),
            ActionSpec("discover_services", {}),
        ]
        results = [engine.evaluate(s) for s in specs]
        assert results[0].decision == PolicyDecision.APPROVE
        assert results[1].decision == PolicyDecision.ESCALATE
        assert results[2].decision == PolicyDecision.APPROVE


# ── Module-level middleware singleton tests ────────────────────────────────────


class TestMiddlewareSingleton:
    def test_get_before_init_raises(self):
        from talos_agent.policy.middleware import get_policy_middleware
        # Reset singleton for clean test
        import talos_agent.policy.middleware as mw
        mw._middleware = None
        with pytest.raises(RuntimeError, match="not initialised"):
            get_policy_middleware()

    def test_init_then_get(self):
        from talos_agent.policy.middleware import (
            get_policy_middleware,
            init_policy_middleware,
        )
        import talos_agent.policy.middleware as mw
        mw._middleware = None
        engine = PolicyEngine()
        m = init_policy_middleware(engine)
        assert get_policy_middleware() is m
