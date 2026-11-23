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
import math
import re
from datetime import datetime, timezone
from typing import Any

from talos_agent.policy.actions import KNOWN_ACTIONS
from talos_agent.policy.schema import (
    ActionSpec,
    ConditionTrace,
    MatchCondition,
    Policy,
    PolicyException,
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
        try:
            return bool(re.search(str(expected), str(actual)))
        except re.error:
            return False
    elif op == "glob":
        return _match_glob(expected, str(actual))

    # Unknown operator — fail closed (condition does not match)
    logger.debug("Unknown condition operator: %s (rule will not match)", op)
    return False


def _match_glob(pattern: str, text: str) -> bool:
    """Match text against a validated policy glob pattern."""
    return compile_glob(pattern).fullmatch(text) is not None


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
        self._exceptions: dict[tuple[str, str], PolicyException] = {}
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
        seen_rule_ids: dict[str, str] = {}
        for policy in policies:
            for rule in policy.rules:
                rule_id = rule.rule_id.strip()
                if not rule_id:
                    raise ValueError(
                        f"Policy '{policy.name}' contains a rule with an empty rule identifier"
                    )
                if rule_id in seen_rule_ids:
                    raise ValueError(
                        f"Duplicate rule identifier '{rule_id}' in policies "
                        f"'{seen_rule_ids[rule_id]}' and '{policy.name}'"
                    )
                seen_rule_ids[rule_id] = policy.name

        self._policies = tuple(
            sorted(
                policies,
                key=lambda p: (-p.priority, p.name),
            )
        )
        self._exceptions = {
            (policy.name, exception.rule_id): exception
            for policy in self._policies
            for exception in policy.exceptions
        }
        logger.info(
            "PolicyEngine loaded %d policies (%d enabled)",
            len(self._policies),
            sum(1 for p in self._policies if p.enabled),
        )

    def reload(self, policies: list[Policy]) -> None:
        """Validate and simulate a candidate before replacing the active set.

        A failed candidate leaves the current policy snapshot untouched.
        """
        try:
            candidate = tuple(
                sorted(policies, key=lambda p: (-p.priority, p.name))
            )
            self._validate_candidate(candidate)
        except PolicyReloadError:
            raise
        except (AttributeError, TypeError, ValueError) as exc:
            raise PolicyReloadError(f"Invalid policy candidate: {exc}") from exc

        staged_engine = PolicyEngine()
        staged_engine.enabled = True
        staged_engine._policies = candidate

        try:
            from talos_agent.policy.simulator import PolicySimulator

            result = PolicySimulator(staged_engine).simulate(
                "__policy_reload_validation__"
            )
        except Exception as exc:
            raise PolicyReloadError("Policy candidate simulation failed") from exc

        if not result.simulation:
            raise PolicyReloadError("Policy candidate did not complete in simulation mode")

        self._policies = candidate
        logger.info(
            "PolicyEngine reloaded %d policies (%d enabled)",
            len(self._policies),
            sum(1 for p in self._policies if p.enabled),
        )

    @staticmethod
    def _validate_candidate(policies: tuple[Policy, ...]) -> None:
        supported_operators = {
            "eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in",
            "exists", "regex", "glob",
        }
        for policy in policies:
            if not isinstance(policy, Policy):
                raise PolicyReloadError("Candidate entries must be Policy instances")
            if not isinstance(policy.name, str) or not policy.name.strip():
                raise PolicyReloadError("Policy names must be non-empty strings")
            if not isinstance(policy.rules, tuple):
                raise PolicyReloadError(f"Policy '{policy.name}' rules must be a tuple")
            for rule in policy.rules:
                if not isinstance(rule, PolicyRule):
                    raise PolicyReloadError(
                        f"Policy '{policy.name}' rules must be PolicyRule instances"
                    )
                if not isinstance(rule.decision, PolicyDecision):
                    raise PolicyReloadError(
                        f"Rule '{rule.rule_id}' has an invalid decision"
                    )
                if not isinstance(rule.severity, Severity):
                    raise PolicyReloadError(
                        f"Rule '{rule.rule_id}' has an invalid severity"
                    )
                for condition in rule.conditions:
                    if not isinstance(condition, MatchCondition):
                        raise PolicyReloadError(
                            f"Rule '{rule.rule_id}' conditions must be MatchCondition instances"
                        )
                    if not isinstance(condition.field, str) or not condition.field:
                        raise PolicyReloadError(
                            f"Rule '{rule.rule_id}' has an empty condition field"
                        )
                    if condition.operator not in supported_operators:
                        raise PolicyReloadError(
                            f"Rule '{rule.rule_id}' uses unsupported operator "
                            f"'{condition.operator}'"
                        )
                    if condition.operator == "regex":
                        try:
                            re.compile(str(condition.value))
                        except re.error as exc:
                            raise PolicyReloadError(
                                f"Rule '{rule.rule_id}' has an invalid regex condition"
                            ) from exc
                    elif condition.operator in {"gt", "gte", "lt", "lte"}:
                        try:
                            numeric_value = float(condition.value)
                        except (TypeError, ValueError) as exc:
                            raise PolicyReloadError(
                                f"Rule '{rule.rule_id}' has an invalid numeric condition"
                            ) from exc
                        if not math.isfinite(numeric_value):
                            raise PolicyReloadError(
                                f"Rule '{rule.rule_id}' has a non-finite numeric condition"
                            )
                    elif condition.operator in {"in", "not_in"} and not isinstance(
                        condition.value, (str, list, tuple, dict, set, frozenset)
                    ):
                        raise PolicyReloadError(
                            f"Rule '{rule.rule_id}' has an invalid membership condition"
                        )

    # ── Evaluation ────────────────────────────────────────────────────────

    def evaluate(
        self,
        spec: ActionSpec,
        *,
        now: datetime | None = None,
    ) -> PolicyResult:
        """Evaluate all loaded policies against *spec* and return a decision.

        Evaluation is pure and deterministic.  The result includes a SHA-256
        digest of the decision payload for audit trail purposes and an
        explainable :class:`PolicyDecisionTrace`.

        Unknown action categories are denied before policy evaluation, even
        when the engine is disabled. Known actions are approved when disabled.
        """
        self._evaluation_count += 1
        evaluation_time = now or datetime.now(timezone.utc)
        if evaluation_time.tzinfo is None or evaluation_time.utcoffset() is None:
            raise ValueError("policy evaluation now must be timezone-aware")

        if spec.action not in KNOWN_ACTIONS:
            reason = (
                f"Unknown policy action category: {spec.action or '<empty>'}; "
                "action denied."
            )
            self._deny_count += 1
            trace = PolicyDecisionTrace(
                action=spec.action,
                decision=PolicyDecision.DENY.value,
                engine_enabled=self._enabled,
                summary=reason,
            )
            return PolicyResult(
                decision=PolicyDecision.DENY,
                evidence=(reason,),
                trace=trace,
            )

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

                exception = self._exceptions.get((policy.name, rule.rule_id))
                if exception is not None:
                    if exception.is_active(evaluation_time):
                        all_results[-1]["exception"] = "applied"
                        steps.append(
                            RuleTraceStep(
                                policy=policy.name,
                                rule_id=rule.rule_id,
                                severity=rule.severity.value,
                                matched=True,
                                decision="not_applicable",
                                reason="Time-bounded policy exception applied",
                                conditions=cond_traces,
                                effect="exception_applied",
                            )
                        )
                        evidence.append(
                            f"[{policy.name}/{rule.rule_id}] exception applied "
                            f"by {exception.actor}: {exception.reason}"
                        )
                        continue
                    all_results[-1]["exception"] = "expired"
                    evidence.append(
                        f"[{policy.name}/{rule.rule_id}] exception expired; "
                        "original policy effect enforced"
                    )

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


class PolicyReloadError(ValueError):
    """Raised when a policy reload candidate cannot be safely activated."""
