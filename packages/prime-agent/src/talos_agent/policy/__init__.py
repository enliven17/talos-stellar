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

from talos_agent.policy.approval import PolicyApprovalStore
from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.loader import PolicyLoader
from talos_agent.policy.middleware import PolicyMiddleware
from talos_agent.policy.schema import (
    ActionDigestMismatchError,
    ActionSpec,
    ApprovalBindingError,
    ApprovalStatusError,
    ConditionTrace,
    MatchCondition,
    Policy,
    PolicyApproval,
    PolicyDecision,
    PolicyDecisionTrace,
    PolicyDigestMismatchError,
    PolicyResult,
    PolicyRule,
    RuleTraceStep,
    Severity,
    compute_action_digest,
    redact_trace_value,
)
from talos_agent.policy.simulator import PolicyCoverageReport, PolicySimulator

__all__ = [
    "ActionDigestMismatchError",
    "ActionSpec",
    "ApprovalBindingError",
    "ApprovalStatusError",
    "ConditionTrace",
    "MatchCondition",
    "Policy",
    "PolicyApproval",
    "PolicyApprovalStore",
    "PolicyDecision",
    "PolicyDecisionTrace",
    "PolicyDigestMismatchError",
    "PolicyEngine",
    "PolicyLoader",
    "PolicyMiddleware",
    "PolicyResult",
    "PolicyRule",
    "PolicySimulator",
    "RuleTraceStep",
    "Severity",
    "compute_action_digest",
    "redact_trace_value",
]
