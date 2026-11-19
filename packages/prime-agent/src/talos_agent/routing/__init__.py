"""Policy-driven model routing and fallback.

This package provides a production-grade routing layer for LLM model calls
that routes by task type, cost, latency, privacy, and availability while
preserving predictable failure behaviour.

Components
----------
ProviderRegistry
    Register and discover providers with their capabilities, cost,
    and latency metadata.

RoutingPolicy
    Selects the best provider for a given set of constraints (task type,
    cost budget, latency budget, privacy requirements).

FallbackChain
    Tries providers in priority order, falling back on failure, with
    circuit-breaker integration to avoid cascading failures.

UsageTracker
    Tracks token and cost usage per provider for accounting and budgeting.

Quick start
-----------
>>> from talos_agent.routing import (
...     ProviderRegistry, RoutingPolicy, FallbackChain, UsageTracker,
...     RoutingConstraints, LLMProvider,
... )
>>> registry = ProviderRegistry()
>>> registry.register(MyProvider())
>>> policy = RoutingPolicy(registry)
>>> constraints = RoutingConstraints(task_type="chat")
>>> provider = policy.select(constraints)
"""

from __future__ import annotations

from talos_agent.routing.provider import (
    LLMProvider,
    OpenAIClientProvider,
    ProviderCapabilities,
    ProviderMetadata,
    ProviderRegistry,
    ProviderStatus,
    TaskType,
    _build_default_registry,
)
from talos_agent.routing.policy import (
    RoutingConstraints,
    RoutingDecision,
    RoutingPolicy,
)
from talos_agent.routing.fallback import (
    FallbackChain,
    FallbackResult,
    FallbackStrategy,
)
from talos_agent.routing.usage import (
    BudgetConfig,
    UsageRecord,
    UsageSnapshot,
    UsageTracker,
)

__all__ = [
    "BudgetConfig",
    "FallbackChain",
    "FallbackResult",
    "FallbackStrategy",
    "_build_default_registry",
    "LLMProvider",
    "OpenAIClientProvider",
    "ProviderCapabilities",
    "ProviderMetadata",
    "ProviderRegistry",
    "ProviderStatus",
    "RoutingConstraints",
    "RoutingDecision",
    "RoutingPolicy",
    "TaskType",
    "UsageRecord",
    "UsageSnapshot",
    "UsageTracker",
]
