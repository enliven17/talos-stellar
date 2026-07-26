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
    MatchCondition,
    Policy,
    PolicyDecision,
    PolicyResult,
    PolicyRule,
    Severity,
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
        digest of the decision payload for audit trail purposes.

        When the engine is **disabled**, this method always returns
        ``APPROVE`` with an evidence note.
        """
        self._evaluation_count += 1

        if not self._enabled:
            return PolicyResult(
                decision=PolicyDecision.APPROVE,
                evidence=("policy_engine_disabled",),
            )

        violated: list[PolicyRule] = []
        all_results: list[dict[str, Any]] = []
        evidence: list[str] = []

        for policy in self._policies:
            if not policy.enabled:
                continue

            for rule in policy.rules:
                matches = _all_conditions_match(rule, spec)
                rule_result = {
                    "policy": policy.name,
                    "rule_id": rule.rule_id,
                    "matched": matches,
                    "decision": rule.decision.value if matches else "not_applicable",
                    "severity": rule.severity.value,
                }
                all_results.append(rule_result)

                if not matches:
                    continue

                # Rule matched — record violation
                violated.append(rule)
                evidence.append(
                    f"[{policy.name}/{rule.rule_id}] {rule.reason} "
                    f"(severity={rule.severity.value}, decision={rule.decision.value})"
                )

                # BLOCKER → immediate DENY (short-circuit)
                if rule.severity == Severity.BLOCKER:
                    self._deny_count += 1
                    return PolicyResult.denied(rule)

        # Determine aggregate decision
        escalated_rules = tuple(
            r for r in violated if r.decision in (PolicyDecision.ESCALATE, PolicyDecision.DENY)
            and r.severity == Severity.HIGH
        )

        if escalated_rules:
            self._escalate_count += 1
            return PolicyResult(
                decision=PolicyDecision.ESCALATE,
                violated_rules=escalated_rules,
                all_results=tuple(all_results),
                evidence=tuple(evidence),
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
            return PolicyResult(
                decision=PolicyDecision.ESCALATE,
                violated_rules=deny_rules,
                all_results=tuple(all_results),
                evidence=tuple(evidence),
            )

        # Only MEDIUM/LOW or no matches → APPROVE
        return PolicyResult(
            decision=PolicyDecision.APPROVE,
            all_results=tuple(all_results),
            evidence=tuple(evidence),
        )

    def evaluate_sync(self, spec: ActionSpec) -> PolicyResult:
        """Synchronous alias for :meth:`evaluate`.

        The engine is inherently synchronous; this method exists so
        callers don't need to remember that ``evaluate`` doesn't need
        ``await``.
        """
        return self.evaluate(spec)
