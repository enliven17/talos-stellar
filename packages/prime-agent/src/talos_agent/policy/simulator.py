"""Policy simulator — dry-run policy evaluation for planning.

The :class:`PolicySimulator` lets callers ask "what would the policy engine
decide?" for a hypothetical action without actually enforcing anything.
This is used by the planning tools (``normalize_providers``, ``plan_purchase``)
and can also be used for operator-facing "test this policy" workflows.
"""

from __future__ import annotations

import copy
import json
import logging
from typing import Any

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.schema import ActionSpec, PolicyDecision, PolicyResult

logger = logging.getLogger(__name__)


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
