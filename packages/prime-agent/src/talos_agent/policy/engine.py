"""Deterministic policy evaluation engine.

The :class:`PolicyEngine` evaluates a set of :class:`Policy` objects against
an :class:`ActionSpec` and returns a :class:`PolicyResult`.  Evaluation is
**pure** — no I/O, no side effects, fully deterministic for the same inputs.

Policy evaluation order
-----------------------
1. Policies are sorted by (``priority`` descending, ``name`` ascending).
2. Disabled policies are skipped.
3. For each enabled policy, every rule is evaluated in insertion order.
4. The first **BLOCKER** that matches short-circuits with ``DENY``.
5. All **HIGH** matches accumulate; if any match, the result is ``ESCALATE``.
6. **MEDIUM/LOW** violations are recorded in ``evidence`` but do not change the decision.
7. If no rules match or only MEDIUM/LOW rules match, the result is ``APPROVE``.

Every evaluation produces an explainable :class:`PolicyDecisionTrace` so
operators can see *why* a decision was made without leaking secrets.

Concurrency safety
------------------
The engine is stateless after construction (it holds only the loaded policies,
which are replaced atomically via :meth:`load`).  Callers are responsible for
serialising calls to :meth:`load` if concurrency is needed.
"""

from __future__ import annotations

import logging
from typing import Any

from talos_agent.policy.schema import (
    ActionSpec,
    ConditionTrace,
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyDecisionTrace,
    PolicyResult,
    PolicyRule,
    RuleTraceStep,
    Severity,
    redact_trace_value,
)

logger = logging.getLogger(__name__)

# ── Condition evaluation helpers ──────────────────────────────────────────────


def _evaluate_condition(condition: MatchCondition, spec: ActionSpec) -> bool:
    """Evaluate a single match condition against the action spec.

    Returns ``True`` if the condition is satisfied.
    """
    actual = spec.get(condition.field) if condition.field else None
    expected = condition.value
    op = condition.operator

    if op == "exists":
        return actual is not None

    if actual is None:
        return False

    if op == "eq":
        return actual == expected
    elif op == "neq":
        return actual != expected
    elif op in ("gt", "gte", "lt", "lte"):
        try:
            if expected is None:
                return False  # can't compare without a value
            a = float(actual)
            e = float(expected)
            if op == "gt":
                return a > e
            elif op == "gte":
                return a >= e
            elif op == "lt":
                return a < e
            elif op == "lte":
                return a <= e
        except (TypeError, ValueError):
            return False
    elif op == "in":
        try:
            return actual in expected
        except TypeError:
            return False
    elif op == "not_in":
        try:
            return actual not in expected
        except TypeError:
            return True  # if can't test membership, assume not in
    elif op == "regex":
        import re

        try:
            return bool(re.search(str(expected), str(actual)))
        except re.error:
            return False

    # Unknown operator — fail closed (condition does not match)
    logger.debug("Unknown condition operator: %s (rule will not match)", op)
    return False


def _trace_condition(condition: MatchCondition, spec: ActionSpec) -> ConditionTrace:
    """Build a privacy-safe condition trace for one evaluation."""
    matched = _evaluate_condition(condition, spec)
    observed_raw = spec.get(condition.field) if condition.field else None
    return ConditionTrace(
        field=condition.field,
        operator=condition.operator,
        matched=matched,
        observed=redact_trace_value(condition.field, observed_raw),
        expected=redact_trace_value(condition.field, condition.value),
    )


def _all_conditions_match(rule: PolicyRule, spec: ActionSpec) -> bool:
    """Return ``True`` if every condition in *rule* matches *spec*.

    A rule with no conditions is treated as a catch-all only when its
    severity is not BLOCKER.  BLOCKER rules must have at least one
    explicit condition to guard against accidental global denial.
    """
    if not rule.conditions:
        if rule.severity == Severity.BLOCKER:
            logger.warning(
                "BLOCKER rule '%s' has no conditions — skipped (catch-all safety). "
                "Add at least one condition or lower severity.",
                rule.rule_id,
            )
            return False
        # Non-BLOCKER rules with no conditions act as catch-all (by design)
        return True
    return all(_evaluate_condition(c, spec) for c in rule.conditions)


def _build_summary(
    decision: PolicyDecision,
    *,
    short_circuited: bool,
    matched_steps: list[RuleTraceStep],
    engine_enabled: bool,
) -> str:
    if not engine_enabled:
        return "Policy engine disabled; action approved without rule evaluation."
    if short_circuited and matched_steps:
        step = matched_steps[-1]
        return (
            f"DENIED by BLOCKER rule {step.policy}/{step.rule_id}: "
            f"{step.reason or step.rule_id}"
        )
    if decision == PolicyDecision.ESCALATE and matched_steps:
        ids = ", ".join(f"{s.policy}/{s.rule_id}" for s in matched_steps if s.matched)
        return f"ESCALATE due to matching rule(s): {ids}"
    if decision == PolicyDecision.APPROVE:
        advisory = [s for s in matched_steps if s.matched]
        if advisory:
            ids = ", ".join(f"{s.policy}/{s.rule_id}" for s in advisory)
            return f"APPROVE with advisory matches: {ids}"
        return "APPROVE; no matching policy rules."
    return f"decision={decision.value}"


# ── Engine ────────────────────────────────────────────────────────────────────


class PolicyEngine:
    """Stateless, deterministic policy evaluator.

    Usage::

        engine = PolicyEngine()
        engine.load(policies_from_config)
        spec = ActionSpec("purchase_service", {"price": 15.0}, {"budget": 200})
        result = engine.evaluate(spec)
        if result.decision == PolicyDecision.APPROVE:
            await execute_action()
        print(result.explain())  # privacy-safe decision trace
    """

    def __init__(self) -> None:
        self._policies: tuple[Policy, ...] = ()
        self._enabled: bool = False
        self._evaluation_count: int = 0
        self._deny_count: int = 0
        self._escalate_count: int = 0

    # ── Configuration ─────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        """Whether the policy engine is active."""
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = value

    @property
    def policies(self) -> tuple[Policy, ...]:
        """The currently loaded policies (immutable snapshot)."""
        return self._policies

    @property
    def policy_count(self) -> int:
        """Number of loaded policies (including disabled ones)."""
        return len(self._policies)

    @property
    def metrics(self) -> dict[str, int]:
        """Expose internal counters for observability."""
        return {
            "evaluation_count": self._evaluation_count,
            "deny_count": self._deny_count,
            "escalate_count": self._escalate_count,
        }

    # ── Loading ───────────────────────────────────────────────────────────

    def load(self, policies: list[Policy]) -> None:
        """Atomically replace all loaded policies.

        Policies are sorted by (priority descending, name ascending) and
        stored as an immutable tuple so readers see a consistent snapshot.
        """
        self._policies = tuple(
            sorted(
                policies,
                key=lambda p: (-p.priority, p.name),
            )
        )
        logger.info(
            "PolicyEngine loaded %d policies (%d enabled)",
            len(self._policies),
            sum(1 for p in self._policies if p.enabled),
        )

    # ── Evaluation ────────────────────────────────────────────────────────

    def evaluate(self, spec: ActionSpec) -> PolicyResult:
        """Evaluate all loaded policies against *spec* and return a decision.

        Evaluation is pure and deterministic.  The result includes a SHA-256
        digest of the decision payload for audit trail purposes and an
        explainable :class:`PolicyDecisionTrace`.

        When the engine is **disabled**, this method always returns
        ``APPROVE`` with an evidence note and a disabled-engine trace.
        """
        self._evaluation_count += 1

        if not self._enabled:
            trace = PolicyDecisionTrace.disabled(spec.action)
            return PolicyResult(
                decision=PolicyDecision.APPROVE,
                evidence=("policy_engine_disabled",),
                trace=trace,
            )

        violated: list[PolicyRule] = []
        all_results: list[dict[str, Any]] = []
        evidence: list[str] = []
        steps: list[RuleTraceStep] = []
        matched_steps: list[RuleTraceStep] = []

        for policy in self._policies:
            if not policy.enabled:
                # Record a single skipped-policy marker for explainability.
                steps.append(
                    RuleTraceStep(
                        policy=policy.name,
                        rule_id="*",
                        severity="n/a",
                        matched=False,
                        decision="not_applicable",
                        reason="Policy disabled",
                        conditions=(),
                        effect="skipped_disabled_policy",
                    )
                )
                continue

            for rule in policy.rules:
                # Catch-all BLOCKER safety: record explicit skip in the trace.
                if not rule.conditions and rule.severity == Severity.BLOCKER:
                    cond_traces: tuple[ConditionTrace, ...] = ()
                    matches = False
                    effect = "catch_all_blocker_skipped"
                    logger.warning(
                        "BLOCKER rule '%s' has no conditions — skipped (catch-all safety). "
                        "Add at least one condition or lower severity.",
                        rule.rule_id,
                    )
                else:
                    cond_traces = tuple(
                        _trace_condition(c, spec) for c in rule.conditions
                    )
                    matches = _all_conditions_match(rule, spec)
                    effect = "continue"

                rule_result = {
                    "policy": policy.name,
                    "rule_id": rule.rule_id,
                    "matched": matches,
                    "decision": rule.decision.value if matches else "not_applicable",
                    "severity": rule.severity.value,
                }
                all_results.append(rule_result)

                if not matches:
                    steps.append(
                        RuleTraceStep(
                            policy=policy.name,
                            rule_id=rule.rule_id,
                            severity=rule.severity.value,
                            matched=False,
                            decision="not_applicable",
                            reason=rule.reason,
                            conditions=cond_traces,
                            effect=effect if effect != "continue" else "continue",
                        )
                    )
                    continue

                # Rule matched — record violation
                violated.append(rule)
                evidence_line = (
                    f"[{policy.name}/{rule.rule_id}] {rule.reason} "
                    f"(severity={rule.severity.value}, decision={rule.decision.value})"
                )
                evidence.append(evidence_line)

                # BLOCKER → immediate DENY (short-circuit)
                if rule.severity == Severity.BLOCKER:
                    effect = "short_circuit_deny"
                    step = RuleTraceStep(
                        policy=policy.name,
                        rule_id=rule.rule_id,
                        severity=rule.severity.value,
                        matched=True,
                        decision=rule.decision.value,
                        reason=rule.reason,
                        conditions=cond_traces,
                        effect=effect,
                    )
                    steps.append(step)
                    matched_steps.append(step)
                    self._deny_count += 1
                    summary = _build_summary(
                        PolicyDecision.DENY,
                        short_circuited=True,
                        matched_steps=matched_steps,
                        engine_enabled=True,
                    )
                    trace = PolicyDecisionTrace(
                        action=spec.action,
                        decision=PolicyDecision.DENY.value,
                        engine_enabled=True,
                        short_circuited=True,
                        steps=tuple(steps),
                        summary=summary,
                    )
                    return PolicyResult.denied(
                        rule,
                        trace=trace,
                        all_results=tuple(all_results),
                        evidence=tuple(evidence),
                    )

                effect = "record"
                step = RuleTraceStep(
                    policy=policy.name,
                    rule_id=rule.rule_id,
                    severity=rule.severity.value,
                    matched=True,
                    decision=rule.decision.value,
                    reason=rule.reason,
                    conditions=cond_traces,
                    effect=effect,
                )
                steps.append(step)
                matched_steps.append(step)

        # Determine aggregate decision
        escalated_rules = tuple(
            r for r in violated if r.decision in (PolicyDecision.ESCALATE, PolicyDecision.DENY)
            and r.severity == Severity.HIGH
        )

        if escalated_rules:
            self._escalate_count += 1
            summary = _build_summary(
                PolicyDecision.ESCALATE,
                short_circuited=False,
                matched_steps=matched_steps,
                engine_enabled=True,
            )
            trace = PolicyDecisionTrace(
                action=spec.action,
                decision=PolicyDecision.ESCALATE.value,
                engine_enabled=True,
                short_circuited=False,
                steps=tuple(steps),
                summary=summary,
            )
            return PolicyResult(
                decision=PolicyDecision.ESCALATE,
                violated_rules=escalated_rules,
                all_results=tuple(all_results),
                evidence=tuple(evidence),
                trace=trace,
            )

        # Check if any non-BLOCKER DENY rules matched (MEDIUM severity)
        deny_rules = tuple(
            r for r in violated if r.decision == PolicyDecision.DENY
            and r.severity != Severity.BLOCKER
        )
        if deny_rules:
            # MEDIUM deny rules are treated as escalations
            # (they're advisory denials, not hard blocks)
            self._escalate_count += 1
            summary = _build_summary(
                PolicyDecision.ESCALATE,
                short_circuited=False,
                matched_steps=matched_steps,
                engine_enabled=True,
            )
            trace = PolicyDecisionTrace(
                action=spec.action,
                decision=PolicyDecision.ESCALATE.value,
                engine_enabled=True,
                short_circuited=False,
                steps=tuple(steps),
                summary=summary,
            )
            return PolicyResult(
                decision=PolicyDecision.ESCALATE,
                violated_rules=deny_rules,
                all_results=tuple(all_results),
                evidence=tuple(evidence),
                trace=trace,
            )

        # Only MEDIUM/LOW or no matches → APPROVE
        summary = _build_summary(
            PolicyDecision.APPROVE,
            short_circuited=False,
            matched_steps=matched_steps,
            engine_enabled=True,
        )
        trace = PolicyDecisionTrace(
            action=spec.action,
            decision=PolicyDecision.APPROVE.value,
            engine_enabled=True,
            short_circuited=False,
            steps=tuple(steps),
            summary=summary,
        )
        return PolicyResult(
            decision=PolicyDecision.APPROVE,
            all_results=tuple(all_results),
            evidence=tuple(evidence),
            trace=trace,
        )

    def evaluate_sync(self, spec: ActionSpec) -> PolicyResult:
        """Synchronous alias for :meth:`evaluate`.

        The engine is inherently synchronous; this method exists so
        callers don't need to remember that ``evaluate`` doesn't need
        ``await``.
        """
        return self.evaluate(spec)
