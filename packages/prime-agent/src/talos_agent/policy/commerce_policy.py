"""A2A Commerce Policy Evaluator.

Enforces policy evaluation before consequential commerce operations:
- quote acceptance
- payment signing
- reservation creation
- job creation

Integrates the existing PolicyEngine and enforces strict verification,
invalidation, fail-closed handling, audit logging, and idempotency binding.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from talos_agent.policy.engine import PolicyEngine
from talos_agent.policy.schema import (
    ActionSpec,
    CommerceOperationType,
    CommercePolicyContext,
    CommercePolicyDecision,
    PolicyDecision,
)

logger = logging.getLogger(__name__)


def compute_payload_digest(payload: Any) -> str:
    """Compute deterministic SHA-256 hash of a payload dictionary or string."""
    if payload is None:
        data = ""
    elif isinstance(payload, str):
        data = payload
    elif isinstance(payload, (dict, list)):
        data = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    else:
        data = str(payload)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


class CommercePolicyInvalidationError(Exception):
    """Raised when a policy decision is invalid, stale, or modified."""


class CommercePolicyEvaluationTimeoutError(Exception):
    """Raised when policy evaluation or provider evaluation times out."""


class CommercePolicyEvaluator:
    """Evaluates A2A policy for commerce operations and enforces fail-closed rules."""

    def __init__(
        self,
        engine: PolicyEngine,
        *,
        default_timeout_seconds: float = 5.0,
    ) -> None:
        self._engine = engine
        self._default_timeout_seconds = default_timeout_seconds

    @property
    def engine(self) -> PolicyEngine:
        return self._engine

    async def evaluate_commerce_operation(
        self,
        context: CommercePolicyContext,
        *,
        timeout_seconds: float | None = None,
    ) -> CommercePolicyDecision:
        """Perform A2A policy evaluation for a commerce operation.

        Verifies at minimum:
        1. requester identity
        2. provider
        3. asset
        4. network
        5. quoted amount
        6. payload digest
        7. expiration
        8. authorization context

        Returns a structured CommercePolicyDecision object.
        Fails closed on any timeout, error, or missing configuration.
        """
        timeout = timeout_seconds if timeout_seconds is not None else self._default_timeout_seconds
        try:
            return await asyncio.wait_for(
                self._do_evaluate(context),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            logger.error(
                "A2A commerce policy evaluation timed out after %.2f seconds for requester %s",
                timeout,
                context.requester,
            )
            return self._build_fail_closed_decision(
                context,
                reason=f"Policy evaluation timed out ({timeout}s)",
            )
        except Exception as exc:
            logger.error("A2A commerce policy evaluation failed with exception: %s", exc)
            return self._build_fail_closed_decision(
                context,
                reason=f"Policy evaluation error: {str(exc)}",
            )

    async def _do_evaluate(self, context: CommercePolicyContext) -> CommercePolicyDecision:
        now_dt = datetime.now(timezone.utc)
        evaluated_at = now_dt.isoformat()

        # Check expiration of the request
        try:
            exp_dt = datetime.fromisoformat(context.expiration.replace("Z", "+00:00"))
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if now_dt >= exp_dt:
                return self._build_fail_closed_decision(
                    context,
                    reason="Request expiration timestamp is in the past (expired policy context)",
                )
        except (ValueError, AttributeError):
            return self._build_fail_closed_decision(
                context,
                reason=f"Invalid expiration timestamp format: {context.expiration}",
            )

        # Validate minimum required fields
        if not context.requester or not context.provider or not context.asset or not context.network:
            return self._build_fail_closed_decision(
                context,
                reason="Missing required policy parameters (requester, provider, asset, or network)",
            )

        # Build ActionSpec for PolicyEngine
        spec_params = {
            "requester": context.requester,
            "provider": context.provider,
            "asset": context.asset,
            "network": context.network,
            "price": context.quoted_amount,
            "quoted_amount": context.quoted_amount,
            "payload_digest": context.payload_digest,
            "expiration": context.expiration,
            "operation_type": context.operation_type.value,
        }
        spec_context = dict(context.authorization_context)

        spec = ActionSpec(
            action=context.operation_type.value,
            params=spec_params,
            context=spec_context,
        )

        # Evaluate via PolicyEngine
        result = self._engine.evaluate(spec)

        decision_id = str(uuid.uuid4())
        expiry = context.expiration

        # Build canonical digest payload
        digest_input = {
            "decision_id": decision_id,
            "requester": context.requester,
            "provider": context.provider,
            "asset": context.asset,
            "network": context.network,
            "quoted_amount": str(context.quoted_amount),
            "payload_digest": context.payload_digest,
            "operation_type": context.operation_type.value,
            "expiry": expiry,
            "decision": result.decision.value,
        }
        decision_digest = hashlib.sha256(
            json.dumps(digest_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

        return CommercePolicyDecision(
            decision_id=decision_id,
            decision_digest=decision_digest,
            expiry=expiry,
            evaluated_at=evaluated_at,
            decision=result.decision,
            requester=context.requester,
            provider=context.provider,
            asset=context.asset,
            network=context.network,
            quoted_amount=context.quoted_amount,
            payload_digest=context.payload_digest,
            operation_type=context.operation_type.value,
            violated_rules=tuple(r.rule_id for r in result.violated_rules),
            evidence=tuple(result.evidence),
        )

    def _build_fail_closed_decision(
        self,
        context: CommercePolicyContext,
        reason: str,
    ) -> CommercePolicyDecision:
        now_dt = datetime.now(timezone.utc)
        decision_id = str(uuid.uuid4())
        evaluated_at = now_dt.isoformat()
        expiry = context.expiration or evaluated_at

        digest_input = {
            "decision_id": decision_id,
            "requester": context.requester or "unknown",
            "provider": context.provider or "unknown",
            "asset": context.asset or "unknown",
            "network": context.network or "unknown",
            "quoted_amount": str(context.quoted_amount or 0),
            "payload_digest": context.payload_digest or "empty",
            "operation_type": (
                context.operation_type.value
                if hasattr(context.operation_type, "value")
                else str(context.operation_type)
            ),
            "expiry": expiry,
            "decision": PolicyDecision.DENY.value,
            "reason": reason,
        }
        decision_digest = hashlib.sha256(
            json.dumps(digest_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

        return CommercePolicyDecision(
            decision_id=decision_id,
            decision_digest=decision_digest,
            expiry=expiry,
            evaluated_at=evaluated_at,
            decision=PolicyDecision.DENY,
            requester=context.requester or "unknown",
            provider=context.provider or "unknown",
            asset=context.asset or "unknown",
            network=context.network or "unknown",
            quoted_amount=context.quoted_amount or 0.0,
            payload_digest=context.payload_digest or "empty",
            operation_type=(
                context.operation_type.value
                if hasattr(context.operation_type, "value")
                else str(context.operation_type)
            ),
            violated_rules=("FAIL_CLOSED",),
            evidence=(reason,),
        )

    def validate_decision_against_request(
        self,
        decision: CommercePolicyDecision,
        context: CommercePolicyContext,
    ) -> None:
        """Verify that an approved policy decision matches the request and has not expired.

        Raises CommercePolicyInvalidationError if any protected value has changed
        or if the decision has expired.
        """
        if decision.decision != PolicyDecision.APPROVE:
            raise CommercePolicyInvalidationError(
                f"Policy decision is not approved (decision: {decision.decision.value})"
            )

        now_dt = datetime.now(timezone.utc)
        try:
            exp_dt = datetime.fromisoformat(decision.expiry.replace("Z", "+00:00"))
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if now_dt >= exp_dt:
                raise CommercePolicyInvalidationError("Policy decision has expired")
        except (ValueError, AttributeError):
            raise CommercePolicyInvalidationError(f"Invalid decision expiry: {decision.expiry}")

        # Check protected values
        mismatches: list[str] = []
        if decision.provider != context.provider:
            mismatches.append(f"provider (approved: {decision.provider}, current: {context.provider})")
        if abs(decision.quoted_amount - context.quoted_amount) > 1e-6:
            mismatches.append(f"quoted_amount (approved: {decision.quoted_amount}, current: {context.quoted_amount})")
        if decision.payload_digest != context.payload_digest:
            mismatches.append(f"payload_digest (approved: {decision.payload_digest}, current: {context.payload_digest})")
        if decision.asset != context.asset:
            mismatches.append(f"asset (approved: {decision.asset}, current: {context.asset})")
        if decision.network != context.network:
            mismatches.append(f"network (approved: {decision.network}, current: {context.network})")
        if decision.operation_type != context.operation_type.value:
            mismatches.append(f"operation_type (approved: {decision.operation_type}, current: {context.operation_type.value})")

        if mismatches:
            raise CommercePolicyInvalidationError(
                "Policy decision invalidated due to modified protected values: " + ", ".join(mismatches)
            )
