"""Tests for explainable policy decision traces.

Covers positive, negative, boundary, and regression cases for
PolicyDecisionTrace generation, privacy redaction, and middleware
exposure of decision_trace payloads.
"""

from __future__ import annotations

import pytest

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.middleware import PolicyMiddleware
from talos_agent.policy.schema import (
    ActionSpec,
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyDecisionTrace,
    PolicyRule,
    Severity,
    redact_trace_value,
)


def _sample_policies() -> list[Policy]:
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
                        MatchCondition(
                            "action",
                            "in",
                            ["purchase_service", "transfer_xlm"],
                        ),
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
                    severity=Severity.HIGH,
                    reason="Should not fire",
                ),
            ),
        ),
    ]


class TestRedactTraceValue:
    def test_redacts_secret_shaped_fields(self):
        assert redact_trace_value("api_key", "sk-live-secret") == "[redacted]"
        assert redact_trace_value("seed", "SSECRETSEED") == "[redacted]"
        assert redact_trace_value("payment_proof", "proof-xyz") == "[redacted]"
        assert redact_trace_value("private_key", "S...") == "[redacted]"

    def test_preserves_safe_numeric_and_bool(self):
        assert redact_trace_value("amount", 42.5) == "42.5"
        assert redact_trace_value("ok", True) == "true"

    def test_truncates_long_strings(self):
        out = redact_trace_value("note", "x" * 200)
        assert out is not None
        assert len(out) <= 64
        assert out.endswith("...")

    def test_none_stays_none(self):
        assert redact_trace_value("amount", None) is None


class TestDecisionTracePositive:
    def test_approve_emits_trace_with_steps(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        result = engine.evaluate(
            ActionSpec(
                "purchase_service",
                {"amount": 5},
                {"budget_remaining": 100},
            )
        )
        assert result.decision == PolicyDecision.APPROVE
        assert result.trace is not None
        assert result.trace.engine_enabled is True
        assert result.trace.short_circuited is False
        assert result.trace.decision == "approve"
        assert "APPROVE" in result.trace.summary
        assert any(s.effect == "skipped_disabled_policy" for s in result.trace.steps)
        explanation = result.explain()
        assert "purchase_service" in explanation
        assert "decision=approve" in explanation

    def test_escalate_trace_lists_matching_rule(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        result = engine.evaluate(
            ActionSpec(
                "transfer_xlm",
                {"amount": 50},
                {"budget_remaining": 100},
            )
        )
        assert result.decision == PolicyDecision.ESCALATE
        assert result.trace is not None
        assert result.trace.decision == "escalate"
        assert "requires-approval" in result.trace.summary
        matched = [s for s in result.trace.steps if s.matched]
        assert len(matched) == 1
        assert matched[0].rule_id == "requires-approval"
        assert matched[0].effect == "record"
        assert matched[0].conditions
        assert all(isinstance(c.matched, bool) for c in matched[0].conditions)


class TestDecisionTraceNegative:
    def test_blocker_short_circuit_still_emits_full_trace(self):
        """Regression: BLOCKER path previously dropped all_results / traces."""
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        result = engine.evaluate(
            ActionSpec(
                "purchase_service",
                {"amount": 5},
                {"budget_remaining": 0},
            )
        )
        assert result.decision == PolicyDecision.DENY
        assert result.trace is not None
        assert result.trace.short_circuited is True
        assert result.trace.decision == "deny"
        assert "budget-exhausted" in result.trace.summary
        assert result.all_results, "BLOCKER deny must retain all_results"
        assert any(s.effect == "short_circuit_deny" for s in result.trace.steps)
        # Digest remains stable / present
        assert len(result.result_digest) == 64

    def test_disabled_engine_trace(self):
        engine = PolicyEngine()
        engine.enabled = False
        result = engine.evaluate(ActionSpec("purchase_service", {"amount": 999}))
        assert result.decision == PolicyDecision.APPROVE
        assert result.trace is not None
        assert result.trace.engine_enabled is False
        assert result.trace.steps == ()
        assert "disabled" in result.trace.summary.lower()


class TestDecisionTraceBoundary:
    def test_malformed_missing_action_still_traces(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        result = engine.evaluate(ActionSpec("", {}))
        assert result.trace is not None
        assert result.trace.action == ""
        assert result.decision == PolicyDecision.APPROVE

    def test_empty_policies_trace(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load([])
        result = engine.evaluate(ActionSpec("transfer_xlm", {"amount": 1}))
        assert result.decision == PolicyDecision.APPROVE
        assert result.trace is not None
        assert result.trace.steps == ()
        assert "no matching" in result.trace.summary.lower()

    def test_catch_all_blocker_skipped_recorded(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(
            [
                Policy(
                    name="unsafe",
                    priority=1,
                    rules=(
                        PolicyRule(
                            rule_id="blanket",
                            description="Bad catch-all",
                            conditions=(),
                            decision=PolicyDecision.DENY,
                            severity=Severity.BLOCKER,
                            reason="Should never blanket-deny",
                        ),
                    ),
                )
            ]
        )
        result = engine.evaluate(ActionSpec("transfer_xlm", {"amount": 1}))
        assert result.decision == PolicyDecision.APPROVE
        assert result.trace is not None
        assert any(
            s.effect == "catch_all_blocker_skipped" for s in result.trace.steps
        )


class TestDecisionTracePrivacy:
    def test_secret_fields_never_appear_in_trace(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(
            [
                Policy(
                    name="secret-guard",
                    priority=10,
                    rules=(
                        PolicyRule(
                            rule_id="has-api-key",
                            description="Match when api_key present",
                            conditions=(
                                MatchCondition("api_key", "exists"),
                            ),
                            decision=PolicyDecision.ESCALATE,
                            severity=Severity.HIGH,
                            reason="API key present",
                        ),
                    ),
                )
            ]
        )
        secret = "sk-live-DO-NOT-LEAK-12345"
        result = engine.evaluate(
            ActionSpec("purchase_service", {"api_key": secret, "amount": 1})
        )
        assert result.decision == PolicyDecision.ESCALATE
        blob = result.explain() + str(result.trace.to_dict())
        assert "DO-NOT-LEAK" not in blob
        assert secret not in blob
        assert "[redacted]" in blob

    def test_to_dict_includes_trace(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        result = engine.evaluate(
            ActionSpec("discover_services", {}, {"budget_remaining": 10})
        )
        d = result.to_dict()
        assert "trace" in d
        assert d["trace"]["decision"] == "approve"
        assert "steps" in d["trace"]


class TestMiddlewareDecisionTrace:
    @pytest.mark.asyncio
    async def test_deny_payload_includes_decision_trace(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        mw = PolicyMiddleware(engine, budget_getter=lambda: {"budget_remaining": 0})

        async def purchase_service(price: float = 1.0) -> dict:
            return {"ok": True}

        wrapped = mw.wrap_tool("purchase_service", purchase_service)
        out = await wrapped(price=1.0)
        assert out["policy_decision"] == "deny"
        assert "decision_trace" in out
        assert out["decision_trace"]["short_circuited"] is True
        assert "explanation" in out
        assert "Budget exhausted" in out["explanation"] or "budget" in out[
            "decision_trace"
        ]["summary"].lower()

    @pytest.mark.asyncio
    async def test_escalate_payload_includes_decision_trace(self):
        engine = PolicyEngine()
        engine.enabled = True
        engine.load(_sample_policies())
        mw = PolicyMiddleware(
            engine, budget_getter=lambda: {"budget_remaining": 100}
        )

        async def transfer_xlm(amount: float = 50.0) -> dict:
            return {"ok": True}

        wrapped = mw.wrap_tool("transfer_xlm", transfer_xlm)
        out = await wrapped(amount=50.0)
        assert out["policy_decision"] == "escalate"
        assert "decision_trace" in out
        assert out["decision_trace"]["decision"] == "escalate"


class TestTraceDataclassHelpers:
    def test_disabled_factory(self):
        t = PolicyDecisionTrace.disabled("noop")
        assert t.action == "noop"
        assert t.engine_enabled is False
        assert t.decision == "approve"
