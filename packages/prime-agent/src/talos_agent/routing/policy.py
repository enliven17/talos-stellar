"""Routing policy engine for selecting providers based on constraints.

The :class:`RoutingPolicy` evaluates constraints (task type, cost, latency,
privacy, required capabilities) against registered providers and selects
the best candidate.  Selection is deterministic for the same inputs.

Scoring
-------
Each candidate provider receives a score based on how well it matches the
constraints.  The scoring dimensions are:

* **Capability fit**: Does the provider support the required capabilities?
  (boolean — disqualifies if missing)
* **Cost score**: Normalised inverse cost (lower cost = higher score).
* **Latency score**: Normalised inverse latency (lower latency = higher score).
* **Privacy score**: ``local`` > ``trusted`` > ``external``.
* **Availability score**: Circuit breaker state (healthy > degraded > open).

Providers that do not meet capability requirements are excluded.  The
remaining candidates are scored and the highest scorer is selected.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import Decimal

from talos_agent.routing.provider import (
    ProviderCapabilities,
    ProviderMetadata,
    ProviderRegistry,
    TaskType,
)

logger = logging.getLogger(__name__)

# ── Scoring weights ────────────────────────────────────────────────────────────

# Default scoring weights.  These can be overridden in RoutingPolicy to
# tune the router for different deployment scenarios.

DEFAULT_COST_WEIGHT = 1.0
DEFAULT_LATENCY_WEIGHT = 1.0
DEFAULT_PRIVACY_WEIGHT = 0.5
DEFAULT_AVAILABILITY_WEIGHT = 2.0  # Most important — avoid failing calls

# ── Constraints ────────────────────────────────────────────────────────────────


@dataclass
class RoutingConstraints:
    """Constraints that the routing policy must satisfy.

    All fields are optional.  Unset constraints are treated as "no
    preference" and do not influence scoring.
    """

    task_type: TaskType = TaskType.CHAT
    """What kind of task is being routed."""

    max_cost_usd: Decimal | None = None
    """Maximum acceptable cost in USD for this single call."""

    max_latency_ms: float | None = None
    """Maximum acceptable latency in milliseconds."""

    require_privacy: str | None = None
    """Minimum privacy level: ``"local"``, ``"trusted"``, or ``"external"``."""

    require_capabilities: set[str] = field(default_factory=set)
    """Required capability names (e.g. ``{"vision"}``, ``{"json_mode"}``)."""

    preferred_provider: str | None = None
    """Exact provider name to use (bypasses scoring if available)."""

    preferred_model: str | None = None
    """Exact model name to use (used alongside preferred_provider)."""

    bypass_fallback: bool = False
    """If ``True``, do not attempt fallback on failure (fail-fast)."""


# ── Routing Decision ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RoutingDecision:
    """The result of a routing policy evaluation.

    Attributes
    ----------
    provider_name:
        The selected provider name.
    model:
        The model to use for this call.
    score:
        The aggregate score that determined this selection.
    reason:
        Human-readable explanation of why this provider was chosen.
    constraints:
        The constraints that led to this decision.
    """

    provider_name: str
    model: str
    score: float
    reason: str
    constraints: RoutingConstraints


# ── Policy ─────────────────────────────────────────────────────────────────────


class RoutingPolicy:
    """Selects the best provider for a set of :class:`RoutingConstraints`.

    The policy is deterministic — the same constraints and registry state
    always produce the same selection.

    Usage
    -----
    >>> policy = RoutingPolicy(registry)
    >>> constraints = RoutingConstraints(task_type=TaskType.CHAT)
    >>> decision = policy.select(constraints)
    >>> decision.provider_name
    'groq'
    """

    def __init__(
        self,
        registry: ProviderRegistry,
        *,
        cost_weight: float = DEFAULT_COST_WEIGHT,
        latency_weight: float = DEFAULT_LATENCY_WEIGHT,
        privacy_weight: float = DEFAULT_PRIVACY_WEIGHT,
        availability_weight: float = DEFAULT_AVAILABILITY_WEIGHT,
    ) -> None:
        self._registry = registry
        self._cost_weight = cost_weight
        self._latency_weight = latency_weight
        self._privacy_weight = privacy_weight
        self._availability_weight = availability_weight

    # These weights are exposed as read-only properties so that consumers
    # can inspect the policy configuration.

    @property
    def cost_weight(self) -> float:
        return self._cost_weight

    @property
    def latency_weight(self) -> float:
        return self._latency_weight

    @property
    def privacy_weight(self) -> float:
        return self._privacy_weight

    @property
    def availability_weight(self) -> float:
        return self._availability_weight

    # ── Public API ────────────────────────────────────────────────────────

    def select(self, constraints: RoutingConstraints) -> RoutingDecision:
        """Select the best provider for the given constraints.

        Parameters
        ----------
        constraints:
            The task constraints to satisfy.

        Returns
        -------
        RoutingDecision
            The selected provider and model, along with a score and reason.

        Raises
        ------
        NoSuitableProviderError
            If no registered provider can satisfy the constraints.
        """
        # Fast path: preferred provider
        if constraints.preferred_provider:
            return self._select_preferred(constraints)

        candidates = self._score_candidates(constraints)
        if not candidates:
            raise NoSuitableProviderError(
                "No suitable provider found",
                constraints=constraints,
                available=self._registry.available(),
            )

        # Sort by score descending, then by name for determinism
        candidates.sort(key=lambda x: (-x[1], x[0]))

        best_name, best_score = candidates[0]
        best_provider = self._registry.get(best_name)
        model = constraints.preferred_model or best_provider.metadata.default_model
        reason = self._build_reason(best_name, best_score, constraints, candidates)

        return RoutingDecision(
            provider_name=best_name,
            model=model,
            score=best_score,
            reason=reason,
            constraints=constraints,
        )

    # ── Scoring ───────────────────────────────────────────────────────────

    def _score_candidates(
        self,
        constraints: RoutingConstraints,
    ) -> list[tuple[str, float]]:
        """Score all registered providers against the constraints.

        Returns a list of ``(provider_name, score)`` tuples for providers
        that satisfy all capability requirements.
        """
        scored: list[tuple[str, float]] = []

        for name in self._registry.available():
            provider = self._registry.get(name)
            meta = provider.metadata

            # Check capability requirements
            if not self._capabilities_satisfy(meta.capabilities, constraints):
                continue

            score = 0.0

            # Cost score (inverse — lower cost = higher score)
            if self._cost_weight > 0 and constraints.max_cost_usd is not None:
                cost_score = self._compute_cost_score(meta, constraints)
                score += self._cost_weight * cost_score

            # Latency score (inverse — lower latency = higher score)
            if self._latency_weight > 0 and constraints.max_latency_ms is not None:
                latency_score = self._compute_latency_score(meta, constraints)
                score += self._latency_weight * latency_score

            # Privacy score
            if self._privacy_weight > 0 and constraints.require_privacy:
                privacy_score = self._compute_privacy_score(meta, constraints)
                score += self._privacy_weight * privacy_score

            # Availability score
            if self._availability_weight > 0:
                availability_score = self._compute_availability_score(name)
                score += self._availability_weight * availability_score

            # Task-type-specific preference
            score += self._task_type_bonus(name, meta, constraints.task_type)

            scored.append((name, score))

        return scored

    def _select_preferred(self, constraints: RoutingConstraints) -> RoutingDecision:
        """Handle the fast path when a preferred provider is explicitly set."""
        preferred = constraints.preferred_provider

        if preferred not in self._registry.available():
            raise NoSuitableProviderError(
                f"Preferred provider '{preferred}' is not registered",
                constraints=constraints,
                available=self._registry.available(),
            )

        provider = self._registry.get(preferred)
        model = constraints.preferred_model or provider.metadata.default_model

        # Still check capability requirements
        if not self._capabilities_satisfy(provider.metadata.capabilities, constraints):
            raise NoSuitableProviderError(
                f"Preferred provider '{preferred}' does not satisfy capability requirements",
                constraints=constraints,
                available=self._registry.available(),
            )

        return RoutingDecision(
            provider_name=preferred,
            model=model,
            score=float("inf"),
            reason=f"Preferred provider '{preferred}' selected by constraint",
            constraints=constraints,
        )

    # ── Scoring helpers ───────────────────────────────────────────────────

    @staticmethod
    def _capabilities_satisfy(
        capabilities: ProviderCapabilities,
        constraints: RoutingConstraints,
    ) -> bool:
        """Check whether *capabilities* satisfy *constraints*.

        Returns ``False`` if any required capability is missing.
        """
        for required in constraints.require_capabilities:
            if required == "json_mode" and not capabilities.json_mode:
                return False
            if required == "vision" and not capabilities.vision:
                return False
            if required == "tool_calling" and not capabilities.tool_calling:
                return False
            if required == "streaming" and not capabilities.streaming:
                return False
            if required == "parallel_tool_calls" and not capabilities.parallel_tool_calls:
                return False
        return True

    @staticmethod
    def _compute_cost_score(
        meta: ProviderMetadata,
        constraints: RoutingConstraints,
    ) -> float:
        """Compute cost score (0 to 1, higher = better)."""
        if constraints.max_cost_usd is None or constraints.max_cost_usd <= Decimal("0"):
            return 0.5  # Neutral if no budget constraint

        # Estimate cost for a typical call (1000 input + 500 output tokens)
        estimated = (
            meta.cost_per_1k_input * Decimal("1")
            + meta.cost_per_1k_output * Decimal("0.5")
        )

        if estimated <= Decimal("0"):
            return 1.0  # Free provider

        # Score = 1 - (estimated / max_cost), clamped to [0, 1]
        ratio = float(estimated / constraints.max_cost_usd)
        return max(0.0, min(1.0, 1.0 - ratio))

    @staticmethod
    def _compute_latency_score(
        meta: ProviderMetadata,
        constraints: RoutingConstraints,
    ) -> float:
        """Compute latency score (0 to 1, higher = better)."""
        if constraints.max_latency_ms is None or constraints.max_latency_ms <= 0:
            return 0.5

        if meta.avg_latency_ms <= 0:
            return 0.5

        ratio = meta.avg_latency_ms / constraints.max_latency_ms
        if ratio <= 0.5:
            return 1.0  # Well within budget
        if ratio <= 1.0:
            return 2.0 * (1.0 - ratio)  # Within budget, lower = better
        # Exceeds budget — penalize
        return max(0.0, 1.0 - ratio)

    @staticmethod
    def _compute_privacy_score(
        meta: ProviderMetadata,
        constraints: RoutingConstraints,
    ) -> float:
        """Compute privacy score (0 to 1, higher = better).

        Privacy levels: local=3, trusted=2, external=1
        Required level must be <= provider level.
        """
        level_map = {"local": 3, "trusted": 2, "external": 1}
        required = constraints.require_privacy or "external"
        provider_level = level_map.get(meta.privacy_level, 1)
        required_level = level_map.get(required, 1)

        if provider_level < required_level:
            return -1.0  # Penalty for not meeting privacy requirements

        # Score proportional to how much better the provider is
        return float(provider_level) / 3.0

    @staticmethod
    def _compute_availability_score(provider_name: str) -> float:
        """Compute availability score based on circuit breaker state."""
        from talos_agent.circuit_breaker import cb_registry

        breaker = cb_registry.get(provider_name)
        state = breaker.state.value
        if state == "closed":
            return 1.0
        elif state == "half_open":
            return 0.3
        else:  # open
            return -1.0

    @staticmethod
    def _task_type_bonus(
        provider_name: str,
        meta: ProviderMetadata,
        task_type: TaskType,
    ) -> float:
        """Small bonus/penalty for task-type affinity with the provider."""
        lower = provider_name.lower()
        if task_type == TaskType.JSON and not meta.capabilities.json_mode:
            return -0.5
        if task_type == TaskType.VISION and not meta.capabilities.vision:
            return -0.5
        if task_type == TaskType.CHAT:
            # Prefer cheaper providers for simple chat
            if lower == "groq":
                return 0.3
            if lower == "openai" and "mini" in meta.default_model:
                return 0.2
        if task_type == TaskType.REASONING:
            # Prefer more capable providers for reasoning
            if lower == "openai" and "4" in meta.default_model:
                return 0.3
        if task_type == TaskType.CODE:
            if lower == "openai":
                return 0.2
        return 0.0

    @staticmethod
    def _build_reason(
        name: str,
        score: float,
        constraints: RoutingConstraints,
        candidates: list[tuple[str, float]],
    ) -> str:
        """Build a human-readable explanation of the selection."""
        parts = [f"Selected '{name}' (score={score:.2f})"]
        if constraints.task_type != TaskType.CHAT:
            parts.append(f"for task_type={constraints.task_type.value}")
        if len(candidates) > 1:
            others = ", ".join(f"'{n}'({s:.2f})" for n, s in candidates if n != name)
            parts.append(f"over {others}")
        return "; ".join(parts)


# ── Exception ──────────────────────────────────────────────────────────────────


class NoSuitableProviderError(LookupError):
    """Raised when the routing policy cannot find a suitable provider.

    Attributes
    ----------
    constraints:
        The constraints that could not be satisfied.
    available:
        The list of registered provider names at the time of the error.
    """

    def __init__(
        self,
        message: str,
        *,
        constraints: RoutingConstraints,
        available: list[str],
    ) -> None:
        self.constraints = constraints
        self.available = available
        super().__init__(f"{message} (available: {available})")


__all__ = [
    "NoSuitableProviderError",
    "RoutingConstraints",
    "RoutingDecision",
    "RoutingPolicy",
]
