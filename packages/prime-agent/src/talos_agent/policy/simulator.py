"""Policy simulator — dry-run policy evaluation for planning.

The :class:`PolicySimulator` lets callers ask "what would the policy engine
decide?" for a hypothetical action without actually enforcing anything.
This is used by the planning tools (``normalize_providers``, ``plan_purchase``)
and can also be used for operator-facing "test this policy" workflows.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.schema import ActionSpec, PolicyResult, redact_trace_value
from talos_agent.redact import redact_text

logger = logging.getLogger(__name__)
_MAX_EXPORTED_REASON_LENGTH = 256
_MAX_EXPORTED_ARGUMENTS = 32
_MAX_EXPORTED_NESTING = 4


def _bounded_reason(reason: str) -> str:
    redacted = redact_text(reason)
    if len(redacted) <= _MAX_EXPORTED_REASON_LENGTH:
        return redacted
    return redacted[: _MAX_EXPORTED_REASON_LENGTH - 3] + "..."


def _is_private_argument(path: str, private_arguments: frozenset[str]) -> bool:
    normalized = path.casefold()
    field_name = normalized.rsplit(".", 1)[-1]
    return any(
        normalized == name or normalized.endswith(f".{name}") or field_name == name
        for name in private_arguments
    )


def _export_arguments(
    value: Any,
    *,
    path: str,
    private_arguments: frozenset[str],
    depth: int = 0,
) -> Any:
    if _is_private_argument(path, private_arguments):
        return "[redacted]"
    if isinstance(value, dict):
        if depth >= _MAX_EXPORTED_NESTING:
            return "[truncated]"
        exported: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_EXPORTED_ARGUMENTS:
                exported["..."] = "[truncated]"
                break
            key_text = str(key)
            child_path = f"{path}.{key_text}" if path else key_text
            exported[key_text] = _export_arguments(
                item,
                path=child_path,
                private_arguments=private_arguments,
                depth=depth + 1,
            )
        return exported
    if isinstance(value, (list, tuple)):
        items = [
            _export_arguments(
                item,
                path=path,
                private_arguments=private_arguments,
                depth=depth + 1,
            )
            for item in value[:8]
        ]
        if len(value) > 8:
            items.append("[truncated]")
        return items
    return redact_trace_value(path or "argument", value)


def _export_step(step: Any, private_arguments: frozenset[str]) -> dict[str, Any]:
    exported = step.to_dict()
    exported["reason"] = _bounded_reason(step.reason)
    for condition in exported["conditions"]:
        if _is_private_argument(condition["field"], private_arguments):
            if condition["observed"] is not None:
                condition["observed"] = "[redacted]"
            if condition["expected"] is not None:
                condition["expected"] = "[redacted]"
    return exported


@dataclass(frozen=True)
class PolicyCoverageReport:
    """Coverage observed in a collection of redacted policy traces.

    A rule has two observable branches: its conditions matched, or they did
    not match.  Rules that are absent from every supplied trace are reported
    separately as ``unobserved_rules`` and never contribute to
    ``observed_branch_count``.  This distinction is important for dry-run
    review: an action that never reached a rule is not evidence that the rule
    was tested.
    """

    cycle_count: int
    observed_rules: tuple[str, ...]
    unobserved_rules: tuple[str, ...]
    exercised_branches: tuple[str, ...]
    unexercised_branches: tuple[str, ...]

    @property
    def observed_branch_count(self) -> int:
        return len(self.exercised_branches) + len(self.unexercised_branches)

    @property
    def exercised_branch_count(self) -> int:
        return len(self.exercised_branches)

    @property
    def percentage(self) -> float:
        """Return branch coverage among rules observed in the traces."""
        if not self.observed_branch_count:
            return 0.0
        return self.exercised_branch_count / self.observed_branch_count * 100

    def to_dict(self) -> dict[str, Any]:
        return {
            "cycle_count": self.cycle_count,
            "observed_rules": list(self.observed_rules),
            "unobserved_rules": list(self.unobserved_rules),
            "exercised_branches": list(self.exercised_branches),
            "unexercised_branches": list(self.unexercised_branches),
            "exercised_branch_count": self.exercised_branch_count,
            "observed_branch_count": self.observed_branch_count,
            "percentage": self.percentage,
        }


def _trace_from_record(record: Any) -> PolicyDecisionTrace | None:
    """Extract a decision trace from a result or redacted serialized record."""
    if isinstance(record, PolicyResult):
        return record.trace
    if isinstance(record, PolicyDecisionTrace):
        return record
    if not isinstance(record, Mapping):
        return None

    if "trace" not in record and "steps" not in record:
        return None
    raw_trace = record.get("trace", record)
    if not isinstance(raw_trace, Mapping):
        return None
    raw_steps = raw_trace.get("steps", ())
    if not isinstance(raw_steps, Iterable) or isinstance(raw_steps, (str, bytes)):
        return None

    # Rehydrate only the public, redacted trace fields.  Condition values are
    # never evaluated here, so this report cannot accidentally consume secrets.
    from talos_agent.policy.schema import ConditionTrace, RuleTraceStep

    steps: list[RuleTraceStep] = []
    for raw_step in raw_steps:
        if not isinstance(raw_step, Mapping):
            continue
        raw_conditions = raw_step.get("conditions", ())
        if not isinstance(raw_conditions, Iterable) or isinstance(raw_conditions, (str, bytes)):
            raw_conditions = ()
        conditions = tuple(
            ConditionTrace(
                field=str(c.get("field", "")),
                operator=str(c.get("operator", "")),
                matched=bool(c.get("matched", False)),
                observed=c.get("observed"),
                expected=c.get("expected"),
            )
            for c in raw_conditions
            if isinstance(c, Mapping)
        )
        steps.append(
            RuleTraceStep(
                policy=str(raw_step.get("policy", "")),
                rule_id=str(raw_step.get("rule_id", "")),
                severity=str(raw_step.get("severity", "")),
                matched=bool(raw_step.get("matched", False)),
                decision=str(raw_step.get("decision", "")),
                reason=str(raw_step.get("reason", "")),
                conditions=conditions,
                effect=str(raw_step.get("effect", "continue")),
            )
        )
    return PolicyDecisionTrace(
        action=str(raw_trace.get("action", "")),
        decision=str(raw_trace.get("decision", "")),
        engine_enabled=bool(raw_trace.get("engine_enabled", True)),
        short_circuited=bool(raw_trace.get("short_circuited", False)),
        steps=tuple(steps),
        summary=str(raw_trace.get("summary", "")),
    )


class PolicySimulator:
    """Evaluate policies in simulation mode — never enforces.

    Usage::

        sim = PolicySimulator(engine)
        result = sim.simulate("purchase_service", {"price": 25.0}, {"budget": 200})
        if result.decision == PolicyDecision.DENY:
            print("Would be blocked:", result.evidence)
    """

    def __init__(self, engine: PolicyEngine) -> None:
        self._engine = engine

    def simulate(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
    ) -> PolicyResult:
        """Run policy evaluation in dry-run mode.

        The returned :class:`PolicyResult` has ``simulation=True`` so
        consumers can distinguish simulated results from real enforcement.
        """
        params = params or {}
        context = context or {}

        spec = ActionSpec(action=action, params=params, context=context)

        # Evaluate with a temporary engine state so simulation doesn't
        # affect the real engine's metrics
        result = self._engine.evaluate(spec)

        # Mark as simulation
        simulated_result = PolicyResult(
            decision=result.decision,
            violated_rules=result.violated_rules,
            all_results=result.all_results,
            evidence=result.evidence,
            evaluated_at=result.evaluated_at,
            simulation=True,
            trace=result.trace,
        )

        logger.debug(
            "Policy simulation: action=%s decision=%s",
            action,
            simulated_result.decision.value,
        )

        return simulated_result

    def simulate_batch(
        self,
        scenarios: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Run multiple simulations and return a summary for each.

        Each scenario dict should have keys: ``action``, ``params``, ``context``.
        """
        results: list[dict[str, Any]] = []
        for i, scenario in enumerate(scenarios):
            action = scenario.get("action", "")
            params = scenario.get("params", {})
            context = scenario.get("context", {})
            try:
                result = self.simulate(action, params, context)
                results.append({
                    "scenario_index": i,
                    "action": action,
                    "decision": result.decision.value,
                    "evidence": list(result.evidence),
                    "result_digest": result.result_digest,
                    "trace": result.trace.to_dict() if result.trace is not None else None,
                })
            except Exception as exc:
                results.append({
                    "scenario_index": i,
                    "action": action,
                    "error": str(exc),
                })
        return results

    def export_decision(
        self,
        action: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        private_arguments: tuple[str, ...] | set[str] | frozenset[str] = (),
    ) -> None:
        """Simulate one action and export its privacy-safe decision explanation.

        ``private_arguments`` names tool arguments that must be redacted even
        when their names do not match the built-in sensitive-field patterns.
        Dotted names can classify nested arguments, for example
        ``{"profile.ssn"}``.
        """
        params = params or {}
        private_names = frozenset(name.casefold() for name in private_arguments)
        result = self.simulate(action, params, context)
        trace = result.trace
        steps = trace.steps if trace is not None else ()
        payload = {
            "action": action,
            "decision": result.decision.value,
            "evaluated_at": result.evaluated_at,
            "result_digest": result.result_digest,
            "simulation": result.simulation,
            "arguments": _export_arguments(
                params,
                path="",
                private_arguments=private_names,
            ),
            "summary": _bounded_reason(
                trace.summary if trace is not None else result.explain()
            ),
            "matched_rules": [
                {
                    "policy": step.policy,
                    "rule_id": step.rule_id,
                    "severity": step.severity,
                    "decision": step.decision,
                    "reason": _bounded_reason(step.reason),
                }
                for step in steps
                if step.matched
            ],
            "steps": [_export_step(step, private_names) for step in steps],
        }
        with open(path, "w", encoding="utf-8") as file:
            json.dump(payload, file, indent=2, sort_keys=True)
            file.write("\n")
        logger.info("Exported policy decision explanation to %s", path)

    def export_scenarios(self, scenarios: list[dict[str, Any]], path: str) -> None:
        """Run a batch of scenarios and write the results to a JSON file.

        Useful for CI/CD policy validation pipelines.
        """
        results = self.simulate_batch(scenarios)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"scenarios": results, "count": len(results)},
                f,
                indent=2,
                sort_keys=True,
            )
        logger.info("Exported %d simulation results to %s", len(results), path)

    def coverage_report(self, records: Iterable[Any]) -> PolicyCoverageReport:
        """Summarize exercised rule branches from recorded dry-run traces.

        ``records`` may contain ``PolicyResult`` objects, trace objects, or
        the dictionaries returned by :meth:`simulate_batch` and
        :meth:`export_scenarios`.  Only rule steps present in a trace are
        observed.  A blocker short-circuit can therefore leave later rules
        unobserved, rather than incorrectly marking them as non-matching.
        """
        traces = [_trace_from_record(record) for record in records]
        traces = [trace for trace in traces if trace is not None]

        observed: set[str] = set()
        exercised: set[str] = set()
        for trace in traces:
            for step in trace.steps:
                if step.effect == "skipped_disabled_policy" or step.rule_id == "*":
                    continue
                rule_key = f"{step.policy}/{step.rule_id}"
                observed.add(rule_key)
                branch = f"{rule_key}:matched" if step.matched else f"{rule_key}:not_matched"
                exercised.add(branch)

        configured = {
            f"{policy.name}/{rule.rule_id}"
            for policy in self._engine.policies
            for rule in policy.rules
            if policy.enabled
        }
        observed_branch_space = {
            f"{rule_key}:{outcome}"
            for rule_key in observed
            for outcome in ("matched", "not_matched")
        }
        unexercised = observed_branch_space - exercised
        unobserved = configured - observed

        return PolicyCoverageReport(
            cycle_count=len(traces),
            observed_rules=tuple(sorted(observed)),
            unobserved_rules=tuple(sorted(unobserved)),
            exercised_branches=tuple(sorted(exercised)),
            unexercised_branches=tuple(sorted(unexercised)),
        )

    # Descriptive alias for callers that prefer the report verb first.
    report_coverage = coverage_report
