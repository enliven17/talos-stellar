"""Declarative policy engine for autonomous agent actions.

This module provides a type-safe, deterministic policy evaluation framework
that runs before payments, publishing, fulfillment, and other consequential
agent actions.  Policies are defined declaratively as structured rules and
evaluated by the :class:`PolicyEngine`.

The engine is **disabled by default** so existing behaviour is preserved.
Enable it via ``POLICY_ENGINE_ENABLED=true`` in the environment or
``policy_engine_enabled: true`` in ``~/.talos-agent/config.json``.

Quick start
-----------
>>> from talos_agent.policy import PolicyEngine, PolicyLoader, evaluate_action
>>> engine = PolicyEngine()
>>> loader = PolicyLoader()
>>> engine.load(loader.load_defaults())
>>> result = await engine.evaluate("purchase_service", {"price": 15.0})
>>> result.decision
PolicyDecision.APPROVE
"""

from __future__ import annotations

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.loader import PolicyLoader
from talos_agent.policy.middleware import PolicyMiddleware
from talos_agent.policy.schema import (
    ActionSpec,
    Policy,
    PolicyDecision,
    PolicyResult,
    PolicyRule,
    Severity,
)
from talos_agent.policy.simulator import PolicySimulator

__all__ = [
    "ActionSpec",
    "Policy",
    "PolicyDecision",
    "PolicyEngine",
    "PolicyLoader",
    "PolicyMiddleware",
    "PolicyResult",
    "PolicyRule",
    "PolicySimulator",
    "Severity",
]
