"""Policy middleware for intercepting agent tool calls.

The :class:`PolicyMiddleware` wraps the agent's tool execution pipeline
so that every consequential action is evaluated by the :class:`PolicyEngine`
before it runs.  This is the primary integration point between the policy
engine and the agent loop.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.loader import PolicyLoader
from talos_agent.policy.schema import ActionSpec, PolicyDecision, PolicyResult

logger = logging.getLogger(__name__)

# ── Action categories that the middleware intercepts ──────────────────────────

# These are tool names whose execution should be gated by the policy engine.
_GATED_ACTIONS: frozenset[str] = frozenset(
    {
        "purchase_service",
        "transfer_xlm",
        "airdrop_pulse",
        "execute_approved_transfer",
        "request_defi_loan",
        "repay_loan",
        "register_service",
        "publish_content",
        "fulfill_job",
        "generate_playbook",
        "create_pulse_token",
    }
)

# Actions that always bypass policy evaluation (read-only, no side effects)
_BYPASS_ACTIONS: frozenset[str] = frozenset(
    {
        "normalize_providers",
        "plan_purchase",
        "discover_services",
        "get_xlm_balance",
        "get_pulse_balance",
        "get_active_loans",
        "get_pending_jobs",
        "get_publishing_channels",
        "check_approval",
        "check_x_mentions",
        "check_post_performance",
        "poll_service_result",
        "evaluate_marketplace_bid",
    }
)


class PolicyViolationError(Exception):
    """Raised when a policy evaluation blocks or escalates an action.

    The ``result`` attribute contains the full :class:`PolicyResult`
    so callers can inspect the evidence and decide how to proceed.
    """

    def __init__(self, result: PolicyResult, action: str) -> None:
        self.result = result
        self.action = action
        super().__init__(
            f"Policy {result.decision.value} for action '{action}': "
            + "; ".join(result.evidence)
        )


# ── Middleware ────────────────────────────────────────────────────────────────


class PolicyMiddleware:
    """Intercept tool calls and evaluate them against the policy engine.

    Usage in the agent loop::

        middleware = PolicyMiddleware(engine, loader)

        # Before executing a tool:
        result = middleware.evaluate_action("purchase_service", {"price": 15.0})
        if result.decision == PolicyDecision.APPROVE:
            await tools.execute(name, args)
        elif result.decision == PolicyDecision.ESCALATE:
            # Trigger approval flow
            approval_id = await request_approval(name, args, result)
            return {"status": "approval_requested", "approval_id": approval_id}
        else:  # DENY
            return {"error": str(PolicyViolationError(result, name))}
    """

    def __init__(
        self,
        engine: PolicyEngine,
        loader: PolicyLoader | None = None,
        *,
        budget_getter: Callable[[], dict[str, float]] | None = None,
        config_getter: Callable[[], dict[str, Any]] | None = None,
    ) -> None:
        self._engine = engine
        self._loader = loader
        self._budget_getter = budget_getter or (lambda: {})
        self._config_getter = config_getter or (lambda: {})

    @property
    def engine(self) -> PolicyEngine:
        return self._engine

    def evaluate_action(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        extra_context: dict[str, Any] | None = None,
    ) -> PolicyResult:
        """Evaluate *action* with *params* against all loaded policies.

        Parameters
        ----------
        action: Tool name (e.g. ``purchase_service``, ``transfer_xlm``)
        params: Tool arguments
        extra_context: Additional context to merge (overrides auto-gathered context)

        Returns
        -------
        PolicyResult
            The evaluation result.  Check ``result.decision`` to decide.
        """
        if params is None:
            params = {}

        # Build context from the registered getters
        context: dict[str, Any] = {}
        try:
            context.update(self._budget_getter())
        except Exception as exc:
            logger.debug("Budget getter failed: %s", exc)
        try:
            context.update(self._config_getter())
        except Exception as exc:
            logger.debug("Config getter failed: %s", exc)
        if extra_context:
            context.update(extra_context)

        spec = ActionSpec(action=action, params=params, context=context)

        result = self._engine.evaluate(spec)

        logger.debug(
            "Policy evaluation: action=%s decision=%s violated=%d evidence=%s",
            action,
            result.decision.value,
            len(result.violated_rules),
            "; ".join(result.evidence) if result.evidence else "(none)",
        )

        return result

    def wrap_tool(
        self,
        tool_name: str,
        tool_fn: Callable,
    ) -> Callable:
        """Wrap a tool function with policy evaluation.

        Returns an async wrapper that evaluates policies before calling
        the original function.  If the policy engine denies the action,
        the wrapper returns an error dict without calling the tool.

        Actions in ``_GATED_ACTIONS`` are evaluated; actions in
        ``_BYPASS_ACTIONS`` skip evaluation; all others are evaluated
        only if ``enforce_all`` is True.
        """
        import asyncio

        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            # Skip evaluation for read-only actions
            if tool_name in _BYPASS_ACTIONS:
                result = tool_fn(*args, **kwargs)
                if asyncio.iscoroutine(result):
                    return await result
                return result

            # Evaluate only gated actions (unless enforce_all mode)
            if tool_name not in _GATED_ACTIONS:
                result = tool_fn(*args, **kwargs)
                if asyncio.iscoroutine(result):
                    return await result
                return result

            # Build params dict from args/kwargs
            params = dict(kwargs)
            # Attempt to map positional args to parameter names
            import inspect
            try:
                sig = inspect.signature(tool_fn)
                param_names = [
                    n for n, p in sig.parameters.items()
                    if n not in ("self", "cls")
                ]
                for i, val in enumerate(args):
                    if i < len(param_names):
                        params.setdefault(param_names[i], val)
            except Exception:
                pass

            policy_result = self.evaluate_action(tool_name, params)

            if policy_result.decision == PolicyDecision.DENY:
                return {
                    "error": "Policy denied this action",
                    "policy_decision": "deny",
                    "evidence": list(policy_result.evidence),
                    "result_digest": policy_result.result_digest,
                }

            if policy_result.decision == PolicyDecision.ESCALATE:
                return {
                    "status": "policy_escalation_required",
                    "policy_decision": "escalate",
                    "evidence": list(policy_result.evidence),
                    "result_digest": policy_result.result_digest,
                    "message": (
                        "This action requires approval. Use request_approval "
                        "to escalate to a human operator."
                    ),
                }

            # APPROVE — proceed normally
            result = tool_fn(*args, **kwargs)
            if asyncio.iscoroutine(result):
                return await result
            return result

        return wrapped

    def hot_reload(self) -> bool:
        """Check for policy file changes and reload if stale.

        Returns
        -------
        bool
            ``True`` if policies were reloaded.
        """
        if self._loader is None:
            return False
        fresh = self._loader.reload_if_stale()
        if fresh is not None:
            self._engine.load(fresh)
            return True
        return False


# ── Convenience: single global middleware instance ────────────────────────────

_middleware: PolicyMiddleware | None = None


def get_policy_middleware() -> PolicyMiddleware:
    """Return the global :class:`PolicyMiddleware` singleton.

    Raises ``RuntimeError`` if :func:`init_policy_middleware` has not
    been called yet.
    """
    global _middleware
    if _middleware is None:
        raise RuntimeError(
            "Policy middleware not initialised. "
            "Call init_policy_middleware(...) during agent startup."
        )
    return _middleware


def init_policy_middleware(
    engine: PolicyEngine,
    loader: PolicyLoader | None = None,
    **kwargs: Any,
) -> PolicyMiddleware:
    """Initialise the global policy middleware singleton.

    Must be called once during agent startup (from ``scheduler.run``).
    """
    global _middleware
    _middleware = PolicyMiddleware(engine, loader, **kwargs)
    return _middleware
