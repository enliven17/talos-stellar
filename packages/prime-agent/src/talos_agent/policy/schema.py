"""Typed schema for declarative policy rules and evaluation results.

All policy rules, actions, and decisions are defined here as dataclasses
and enums.  This module has zero runtime dependencies beyond the standard
library so it can be imported anywhere without circular imports.
"""

from __future__ import annotations

import enum
import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


# ── Enums ─────────────────────────────────────────────────────────────────────


class Severity(str, enum.Enum):
    """How critical a policy violation is.

    - **BLOCKER**: Action must never proceed (e.g. budget exhausted).
    - **HIGH**: Action requires explicit human approval.
    - **MEDIUM**: Action is flagged but proceeds with a warning (advisory).
    - **LOW**: Informational only; does not affect the decision.
    """

    BLOCKER = "blocker"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class PolicyDecision(str, enum.Enum):
    """The decision produced by evaluating a policy set against an action.

    - **APPROVE**: All checks passed; action may proceed autonomously.
    - **ESCALATE**: Action requires human approval before proceeding.
    - **DENY**: Action is blocked; it must not be executed.
    """

    APPROVE = "approve"
    ESCALATE = "escalate"
    DENY = "deny"


# ── Privacy helpers for decision traces ───────────────────────────────────────

# Deny-by-key: secret-shaped field names are never emitted into traces.
_SECRET_KEY_PATTERN = re.compile(
    r"(api[_-]?key|authorization|auth|secret|password|token|private[_-]?key|"
    r"seed|mnemonic|signature|x-payment|payment[_-]?proof|cookie|passwd|credential)",
    re.IGNORECASE,
)
_MAX_TRACE_VALUE_LEN = 64


def _is_secret_field(name: str) -> bool:
    return bool(_SECRET_KEY_PATTERN.search(name or ""))


def redact_trace_value(field_name: str, value: Any) -> str | None:
    """Return a privacy-safe string representation of *value* for traces.

    Secrets, seeds, payment proofs, and sensitive media references are never
    returned.  Non-secret values are truncated.  ``None`` when the value
    itself is missing (or fully redacted as absent).
    """
    if value is None:
        return None
    if _is_secret_field(field_name):
        return "[redacted]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        parts = []
        for item in list(value)[:8]:
            parts.append(redact_trace_value(field_name, item) or "?")
        rendered = "[" + ", ".join(parts) + ("…" if len(value) > 8 else "") + "]"
        return rendered[:_MAX_TRACE_VALUE_LEN]
    text = str(value)
    if len(text) > _MAX_TRACE_VALUE_LEN:
        return text[: _MAX_TRACE_VALUE_LEN - 3] + "..."
    return text


# ── Dataclasses ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MatchCondition:
    """A single condition that must be satisfied for a policy rule to fire.

    Conditions support the following operators:

    - ``eq``, ``neq``: equality / inequality
    - ``gt``, ``gte``, ``lt``, ``lte``: numeric comparisons
    - ``in``, ``not_in``: set membership
    - ``exists``: field is present and non-null (value ignored)
    - ``regex``: field matches the regex pattern in ``value``
    """

    field: str
    operator: str = "eq"
    value: Any = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> MatchCondition:
        return cls(
            field=d.get("field", ""),
            operator=d.get("operator", "eq"),
            value=d.get("value"),
        )


@dataclass(frozen=True)
class PolicyRule:
    """A single policy rule composed of match conditions and an effect.

    **When** all ``conditions`` match (AND logic), **then**:

    - ``decision`` overrides the outcome (DENY or ESCALATE)
    - ``severity`` indicates how critical this rule is
    - ``reason`` is human-readable and included in the evaluation evidence
    - ``rule_id`` is a stable identifier used for rule-level overrides
    """

    rule_id: str
    description: str
    conditions: tuple[MatchCondition, ...] = ()
    decision: PolicyDecision = PolicyDecision.DENY
    severity: Severity = Severity.HIGH
    reason: str = ""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PolicyRule:
        return cls(
            rule_id=d.get("rule_id", ""),
            description=d.get("description", ""),
            conditions=tuple(
                MatchCondition.from_dict(c)
                for c in d.get("conditions", [])
            ),
            decision=PolicyDecision(d.get("decision", "deny")),
            severity=Severity(d.get("severity", "high")),
            reason=d.get("reason", ""),
        )


@dataclass(frozen=True)
class Policy:
    """A named collection of policy rules with metadata.

    Policies are versioned and include a ``priority`` for conflict
    resolution: higher-priority policies are evaluated first and their
    decisions take precedence.

    ``enabled`` can be set to ``False`` to disable a policy without
    removing it from the ruleset.
    """

    name: str
    version: str = "1.0.0"
    description: str = ""
    rules: tuple[PolicyRule, ...] = ()
    priority: int = 0
    enabled: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Policy:
        return cls(
            name=d.get("name", ""),
            version=d.get("version", "1.0.0"),
            description=d.get("description", ""),
            rules=tuple(PolicyRule.from_dict(r) for r in d.get("rules", [])),
            priority=int(d.get("priority", 0)),
            enabled=bool(d.get("enabled", True)),
        )


@dataclass(frozen=True)
class ActionSpec:
    """A fully-specified action presented to the policy engine.

    An ``ActionSpec`` is the input to :meth:`PolicyEngine.evaluate`.
    It fully describes the action being taken so policies can match
    on any field.
    """

    action: str
    """Name of the action / tool being evaluated (e.g. ``purchase_service``)."""

    params: dict[str, Any] = field(default_factory=dict)
    """Key-value parameters passed to the action."""

    context: dict[str, Any] = field(default_factory=dict)
    """Additional context: budget state, config values, etc."""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ActionSpec:
        return cls(
            action=d.get("action", ""),
            params=d.get("params", {}),
            context=d.get("context", {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def get(self, field: str) -> Any:
        """Resolve a dotted field path against action name, params, then context.

        Example: ``spec.get("action")`` returns the top-level action name.
        ``spec.get("price")`` checks ``params.price`` first,
        then ``context.price``.
        """
        # Top-level fields
        if field == "action":
            return self.action
        # Check params first, then context
        for source in (self.params, self.context):
            if field in source:
                return source[field]
        # Support dotted paths (e.g. "context.budget_remaining")
        parts = field.split(".")
        # If first part is "context" or "params", resolve from that source
        if parts[0] in ("context", "params"):
            source_name = parts[0]
            source = self.context if source_name == "context" else self.params
            val = source
            try:
                for part in parts[1:]:
                    if isinstance(val, dict):
                        val = val[part]
                    else:
                        val = getattr(val, part, None)
                if val is not None:
                    return val
            except (KeyError, AttributeError, TypeError):
                pass
            return None
        # Otherwise search both
        for source in (self.params, self.context):
            val = source
            try:
                for part in parts:
                    if isinstance(val, dict):
                        val = val[part]
                    else:
                        val = getattr(val, part, None)
                if val is not None:
                    return val
            except (KeyError, AttributeError, TypeError):
                continue
        return None


# ── Explainable decision traces ───────────────────────────────────────────────


@dataclass(frozen=True)
class ConditionTrace:
    """Privacy-safe record of a single condition evaluation."""

    field: str
    operator: str
    matched: bool
    observed: str | None = None
    expected: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "operator": self.operator,
            "matched": self.matched,
            "observed": self.observed,
            "expected": self.expected,
        }

    def explain(self) -> str:
        obs = self.observed if self.observed is not None else "<missing>"
        exp = self.expected if self.expected is not None else "<n/a>"
        status = "matched" if self.matched else "no-match"
        return (
            f"{self.field} {self.operator} {exp} "
            f"(observed={obs}, {status})"
        )


@dataclass(frozen=True)
class RuleTraceStep:
    """One step in a policy decision trace (one rule evaluation)."""

    policy: str
    rule_id: str
    severity: str
    matched: bool
    decision: str
    reason: str = ""
    conditions: tuple[ConditionTrace, ...] = ()
    effect: str = "continue"
    """What the engine did after this step.

    Common values: ``continue``, ``record``, ``short_circuit_deny``,
    ``skipped_disabled_policy``, ``catch_all_blocker_skipped``.
    """

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy,
            "rule_id": self.rule_id,
            "severity": self.severity,
            "matched": self.matched,
            "decision": self.decision,
            "reason": self.reason,
            "conditions": [c.to_dict() for c in self.conditions],
            "effect": self.effect,
        }

    def explain(self) -> str:
        conds = "; ".join(c.explain() for c in self.conditions) or "(no conditions)"
        return (
            f"[{self.policy}/{self.rule_id}] matched={self.matched} "
            f"severity={self.severity} decision={self.decision} "
            f"effect={self.effect} :: {conds}"
        )


@dataclass(frozen=True)
class PolicyDecisionTrace:
    """Explainable, privacy-safe record of a full policy evaluation.

    Operators and contributors can inspect ``steps`` and ``summary`` to
    understand *why* the engine approved, escalated, or denied an action
    without seeing secrets, seeds, or payment proofs.
    """

    action: str
    decision: str
    engine_enabled: bool = True
    short_circuited: bool = False
    steps: tuple[RuleTraceStep, ...] = ()
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "decision": self.decision,
            "engine_enabled": self.engine_enabled,
            "short_circuited": self.short_circuited,
            "steps": [s.to_dict() for s in self.steps],
            "summary": self.summary,
        }

    def explain(self) -> str:
        """Multi-line human-readable explanation of the decision."""
        lines = [
            f"action={self.action} decision={self.decision} "
            f"enabled={self.engine_enabled} short_circuited={self.short_circuited}",
        ]
        if self.summary:
            lines.append(f"summary: {self.summary}")
        for step in self.steps:
            lines.append(f"  - {step.explain()}")
        return "\n".join(lines)

    @classmethod
    def disabled(cls, action: str) -> PolicyDecisionTrace:
        return cls(
            action=action,
            decision=PolicyDecision.APPROVE.value,
            engine_enabled=False,
            short_circuited=False,
            steps=(),
            summary="Policy engine disabled; action approved without rule evaluation.",
        )


@dataclass(frozen=True)
class PolicyResult:
    """The result of evaluating a set of policies against an action.

    Attributes
    ----------
    decision:
        Aggregate decision across all matching policies.
    violated_rules:
        Rules that matched and produced a non-APPROVE decision.
    all_results:
        All individual rule evaluation results, including passing ones.
    evidence:
        Human-readable explanation of each matching rule and its effect.
    evaluated_at:
        ISO-8601 UTC timestamp of evaluation.
    result_digest:
        SHA-256 of the canonical result payload; useful for audit logging.
    simulation:
        ``True`` when this result came from the :class:`PolicySimulator`
        and no enforcement should occur.
    trace:
        Explainable, privacy-safe decision trace for operators and audit.
    """

    decision: PolicyDecision
    violated_rules: tuple[PolicyRule, ...] = ()
    all_results: tuple[dict[str, Any], ...] = ()
    evidence: tuple[str, ...] = ()
    evaluated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    result_digest: str = ""
    simulation: bool = False
    trace: PolicyDecisionTrace | None = None

    def __post_init__(self) -> None:
        if not self.result_digest:
            object.__setattr__(self, "result_digest", self._compute_digest())

    def _compute_digest(self) -> str:
        # Exclude evaluated_at from digest so it's deterministic
        # for the same decision outcome (useful for idempotency keys).
        payload = {
            "decision": self.decision.value,
            "violated_rules": [r.rule_id for r in self.violated_rules],
            "evidence": list(self.evidence),
            "simulation": self.simulation,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def explain(self) -> str:
        """Return a human-readable explanation of this decision."""
        if self.trace is not None:
            return self.trace.explain()
        if self.evidence:
            return (
                f"decision={self.decision.value}; "
                + "; ".join(self.evidence)
            )
        return f"decision={self.decision.value} (no evidence recorded)"

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "decision": self.decision.value,
            "violated_rules": [
                {
                    "rule_id": r.rule_id,
                    "description": r.description,
                    "decision": r.decision.value,
                    "severity": r.severity.value,
                    "reason": r.reason,
                }
                for r in self.violated_rules
            ],
            "evidence": list(self.evidence),
            "evaluated_at": self.evaluated_at,
            "result_digest": self.result_digest,
            "simulation": self.simulation,
        }
        if self.trace is not None:
            payload["trace"] = self.trace.to_dict()
        return payload

    @classmethod
    def approved(
        cls,
        *,
        simulation: bool = False,
        trace: PolicyDecisionTrace | None = None,
        all_results: tuple[dict[str, Any], ...] = (),
        evidence: tuple[str, ...] = (),
    ) -> PolicyResult:
        """Convenience factory: all checks passed."""
        return cls(
            decision=PolicyDecision.APPROVE,
            simulation=simulation,
            trace=trace,
            all_results=all_results,
            evidence=evidence,
        )

    @classmethod
    def denied(
        cls,
        rule: PolicyRule,
        *,
        simulation: bool = False,
        trace: PolicyDecisionTrace | None = None,
        all_results: tuple[dict[str, Any], ...] = (),
        evidence: tuple[str, ...] | None = None,
    ) -> PolicyResult:
        """Convenience factory: single rule blocked the action."""
        return cls(
            decision=PolicyDecision.DENY,
            violated_rules=(rule,),
            evidence=evidence if evidence is not None else (f"[{rule.rule_id}] {rule.reason}",),
            simulation=simulation,
            trace=trace,
            all_results=all_results,
        )

    @classmethod
    def escalated(
        cls,
        rules: tuple[PolicyRule, ...],
        *,
        simulation: bool = False,
        trace: PolicyDecisionTrace | None = None,
        all_results: tuple[dict[str, Any], ...] = (),
        evidence: tuple[str, ...] | None = None,
    ) -> PolicyResult:
        """Convenience factory: one or more rules require escalation."""
        return cls(
            decision=PolicyDecision.ESCALATE,
            violated_rules=rules,
            evidence=(
                evidence
                if evidence is not None
                else tuple(f"[{r.rule_id}] {r.reason}" for r in rules)
            ),
            simulation=simulation,
            trace=trace,
            all_results=all_results,
        )
