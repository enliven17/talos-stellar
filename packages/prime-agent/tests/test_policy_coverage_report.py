"""Tests for policy coverage collected from recorded dry-run traces."""

from __future__ import annotations

from talos_agent.policy import (
    Policy,
    PolicyDecision,
    PolicyEngine,
    PolicyRule,
    PolicySimulator,
    Severity,
)
from talos_agent.policy.schema import MatchCondition


def _simulator() -> PolicySimulator:
    engine = PolicyEngine()
    engine.enabled = True
    engine.load([
        Policy(
            name="payments",
            rules=(
                PolicyRule(
                    rule_id="amount-guard",
                    description="Escalate large payments",
                    conditions=(MatchCondition("params.amount", "gt", 10),),
                    decision=PolicyDecision.ESCALATE,
                    severity=Severity.HIGH,
                    reason="large payment",
                ),
                PolicyRule(
                    rule_id="currency-guard",
                    description="Reject unsupported currency",
                    conditions=(MatchCondition("params.currency", "eq", "USD"),),
                    decision=PolicyDecision.DENY,
                    severity=Severity.HIGH,
                    reason="unsupported currency",
                ),
            ),
        ),
    ])
    return PolicySimulator(engine)


def test_simulation_preserves_redacted_trace_for_recording():
    result = _simulator().simulate(
        "pay",
        {"amount": 25, "currency": "USD", "api_key": "secret"},
    )

    assert result.trace is not None
    assert result.trace.steps[0].matched is True
    assert result.trace.steps[0].conditions[0].observed == "25"
    assert result.to_dict()["trace"]["steps"][0]["conditions"][0]["observed"] == "25"


def test_coverage_reports_both_branches_from_serialized_redacted_cycles():
    sim = _simulator()
    records = sim.simulate_batch([
        {"action": "pay", "params": {"amount": 5, "currency": "EUR"}},
        {"action": "pay", "params": {"amount": 25, "currency": "EUR"}},
    ])

    report = sim.coverage_report(records)

    assert report.cycle_count == 2
    assert report.observed_rules == (
        "payments/amount-guard",
        "payments/currency-guard",
    )
    assert report.exercised_branches == (
        "payments/amount-guard:matched",
        "payments/amount-guard:not_matched",
        "payments/currency-guard:not_matched",
    )
    assert report.unexercised_branches == ("payments/currency-guard:matched",)
    assert report.percentage == 75.0


def test_short_circuit_keeps_later_rule_unobserved():
    engine = PolicyEngine()
    engine.enabled = True
    engine.load([
        Policy(
            name="payments",
            rules=(
                PolicyRule(
                    rule_id="block-all",
                    description="Block this action",
                    conditions=(MatchCondition("action", "eq", "blocked"),),
                    decision=PolicyDecision.DENY,
                    severity=Severity.BLOCKER,
                ),
                PolicyRule(
                    rule_id="after-block",
                    description="A rule that was not reached",
                    conditions=(MatchCondition("action", "eq", "blocked"),),
                ),
            ),
        ),
    ])
    sim = PolicySimulator(engine)

    report = sim.report_coverage(sim.simulate_batch([{"action": "blocked"}]))

    assert report.observed_rules == ("payments/block-all",)
    assert report.unobserved_rules == ("payments/after-block",)
    assert report.observed_branch_count == 1
    assert report.percentage == 100.0
