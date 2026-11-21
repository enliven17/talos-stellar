"""Policy simulator — dry-run policy evaluation for planning.

The :class:`PolicySimulator` lets callers ask "what would the policy engine
decide?" for a hypothetical action without actually enforcing anything.
This is used by the planning tools (``normalize_providers``, ``plan_purchase``)
and can also be used for operator-facing "test this policy" workflows.
"""

from __future__ import annotations

import json
import logging
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
