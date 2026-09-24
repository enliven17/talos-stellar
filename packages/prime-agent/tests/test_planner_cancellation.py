"""Tests for planner cancellation propagation — issue #564.

Covers:
- CompositionPlanner checks the cancelled callback at each planning step
- PlannerCancelledError is raised when callback returns True
- compose_a2a_plan converts PlannerCancelledError → asyncio.CancelledError
- compose_a2a_plan records cancellation in durable state (_db.add_activity)
- plan_purchase records cancellation when fetch is cancelled
- Partial plans carry the `cancelled` flag
- Privacy: no secrets, seeds, or sensitive data in cancellation records
- Boundary: None callback, always-false, delayed-true, malformed callback
- Regression: existing callers without cancellation still work
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from talos_agent.tools.a2a_composition import (
    ComposableService,
    CompositionPlanner,
    CompositionPlan,
    PlannerCancelledError,
    ServiceSchema,
    _record_planner_cancellation,
)
from talos_agent.tools import PLANNER_TOOL_NAMES


# ── helpers ────────────────────────────────────────────────────────────────────


def _make_service(
    talos_id: str = "svc-1",
    name: str = "TestSvc",
    price: float = 1.0,
) -> ComposableService:
    return ComposableService(
        talos_id=talos_id,
        talos_name=f"Provider-{talos_id}",
        service_name=name,
        description="test service",
        price_usdc=price,
        input_schema=ServiceSchema(
            fields={"query": "string"}, required=["query"]
        ),
        output_schema=ServiceSchema(
            fields={"result": "string", "query": "string"}, required=["result"]
        ),
        category="test",
        chains=["stellar"],
    )


def _make_services(n: int = 5) -> list[ComposableService]:
    return [_make_service(f"svc-{i}", f"Svc-{i}", price=float(i + 1)) for i in range(n)]


# ── CompositionPlanner cancellation ────────────────────────────────────────────


class TestPlannerCancellationCallback:
    """CompositionPlanner._check_cancelled & planning loop behavior."""

    def test_no_callback_does_not_raise(self):
        """Planner with no callback completes normally (regression)."""
        planner = CompositionPlanner(max_depth=3, cancelled=None)
        plan = planner.plan_composition(_make_services(3))
        assert not plan.cancelled
        assert len(plan.steps) > 0

    def test_always_false_callback_completes_normally(self):
        """Planner with always-False callback completes without cancellation."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: False)
        plan = planner.plan_composition(_make_services(3))
        assert not plan.cancelled
        assert len(plan.steps) > 0

    def test_immediate_cancel_produces_empty_plan(self):
        """Callback True on first check → zero steps, cancelled=True."""
        planner = CompositionPlanner(max_depth=5, cancelled=lambda: True)
        plan = planner.plan_composition(_make_services(3))
        assert plan.cancelled is True
        assert plan.steps == []

    def test_delayed_cancel_produces_partial_plan(self):
        """Callback fires after 2 steps → partial plan with cancelled=True."""
        check_count = 0

        def _cancel_after_two():
            nonlocal check_count
            check_count += 1
            return check_count > 2

        planner = CompositionPlanner(max_depth=10, cancelled=_cancel_after_two)
        plan = planner.plan_composition(_make_services(5))
        assert plan.cancelled is True
        assert len(plan.steps) == 2  # 2 steps completed before cancel

    def test_check_cancelled_raises_planner_cancelled_error(self):
        """_check_cancelled raises PlannerCancelledError when callback is True."""
        planner = CompositionPlanner(cancelled=lambda: True)
        with pytest.raises(PlannerCancelledError, match="planner cancelled"):
            planner._check_cancelled()

    def test_check_cancelled_noop_when_none(self):
        """_check_cancelled is a no-op when callback is None."""
        planner = CompositionPlanner(cancelled=None)
        planner._check_cancelled()  # must not raise

    def test_check_cancelled_noop_when_false(self):
        """_check_cancelled is a no-op when callback returns False."""
        planner = CompositionPlanner(cancelled=lambda: False)
        planner._check_cancelled()  # must not raise


class TestPlannerCancelledPlanMetadata:
    """Cancelled plan metadata is correct and privacy-safe."""

    def test_cancelled_plan_has_valid_digest(self):
        """Even partial/cancelled plans get a valid sha256 digest."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: True)
        plan = planner.plan_composition(_make_services(2))
        assert plan.cancelled is True
        assert len(plan.plan_digest) == 64  # sha256 hex

    def test_cancelled_plan_has_timestamp(self):
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: True)
        plan = planner.plan_composition(_make_services(2))
        assert plan.planned_at  # non-empty ISO-8601

    def test_cancelled_plan_serialization(self):
        """to_dict includes the cancelled field."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: True)
        plan = planner.plan_composition(_make_services(2))
        d = plan.to_dict()
        assert d["cancelled"] is True
        # Ensure no sensitive data leaks
        blob = str(d)
        assert "sk-" not in blob
        assert "seed" not in blob.lower()
        assert "secret" not in blob.lower()

    def test_uncancelled_plan_serialization(self):
        """to_dict includes cancelled=False for normal plans (regression)."""
        planner = CompositionPlanner(max_depth=3)
        plan = planner.plan_composition(_make_services(3))
        d = plan.to_dict()
        assert d["cancelled"] is False

    def test_cancelled_plan_confidence_is_valid(self):
        """Confidence is valid [0,1] even for cancelled plans."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: True)
        plan = planner.plan_composition(_make_services(3))
        assert 0.0 <= plan.confidence <= 1.0

    def test_cancelled_plan_with_no_services(self):
        """Cancelled plan with empty services list is well-formed."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: True)
        plan = planner.plan_composition([])
        assert plan.cancelled is True
        assert plan.steps == []
        assert plan.confidence == 0.0


# ── compose_a2a_plan tool cancellation ─────────────────────────────────────────


class TestComposeA2APlanCancellation:
    """compose_a2a_plan tool handles asyncio.CancelledError and PlannerCancelledError."""

    @pytest.mark.asyncio
    async def test_cancel_during_service_fetch(self):
        """CancelledError from _fetch_services_with_schemas is re-raised after logging."""
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db

        async def _cancel_fetch():
            raise asyncio.CancelledError()

        try:
            mod._db = mock_db
            with patch.object(mod, "_fetch_services_with_schemas", _cancel_fetch):
                with pytest.raises(asyncio.CancelledError):
                    await mod.compose_a2a_plan(goal_description="test")

            # Verify durable state recording
            mock_db.add_activity.assert_called_once_with(
                "planner_cancelled",
                "Planner tool 'compose_a2a_plan' cancelled during service_fetch",
                "system",
            )
        finally:
            mod._db = original_db

    @pytest.mark.asyncio
    async def test_cancel_during_planning_loop(self):
        """PlannerCancelledError from planning loop is converted to CancelledError."""
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db

        async def _return_services():
            return [
                {
                    "talosId": "svc-1",
                    "talosName": "P1",
                    "serviceName": "S1",
                    "description": "d",
                    "price": 1.0,
                    "talosCategory": "test",
                    "chains": ["stellar"],
                    "inputSchema": {"fields": {"query": "string"}, "required": ["query"]},
                    "outputSchema": {"fields": {"result": "string"}, "required": ["result"]},
                }
            ]

        try:
            mod._db = mock_db
            with (
                patch.object(mod, "_fetch_services_with_schemas", _return_services),
                patch.object(mod, "_read_composition_settings", return_value={
                    "max_depth": 5, "max_candidates": 10, "max_calls": 20,
                    "max_cost_usdc": 100.0, "max_planning_time_seconds": 30.0,
                    "schema_strictness": "compatible",
                }),
                patch.object(
                    CompositionPlanner, "plan_composition",
                    side_effect=PlannerCancelledError("cancelled"),
                ),
            ):
                with pytest.raises(asyncio.CancelledError):
                    await mod.compose_a2a_plan(goal_description="test")

            mock_db.add_activity.assert_called_once_with(
                "planner_cancelled",
                "Planner tool 'compose_a2a_plan' cancelled during planning_loop",
                "system",
            )
        finally:
            mod._db = original_db

    @pytest.mark.asyncio
    async def test_partial_cancelled_plan_records_activity(self):
        """When plan_composition returns a plan with cancelled=True, activity is recorded."""
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db

        partial_plan = MagicMock(spec=CompositionPlan)
        partial_plan.cancelled = True
        partial_plan.to_dict.return_value = {"cancelled": True, "steps": []}

        async def _return_services():
            return []

        try:
            mod._db = mock_db
            with (
                patch.object(mod, "_fetch_services_with_schemas", _return_services),
                patch.object(mod, "_read_composition_settings", return_value={
                    "max_depth": 5, "max_candidates": 10, "max_calls": 20,
                    "max_cost_usdc": 100.0, "max_planning_time_seconds": 30.0,
                    "schema_strictness": "compatible",
                }),
                patch.object(
                    CompositionPlanner, "plan_composition",
                    return_value=partial_plan,
                ),
            ):
                result = await mod.compose_a2a_plan(goal_description="partial")

            assert result["cancelled"] is True
            mock_db.add_activity.assert_called_once_with(
                "planner_cancelled",
                "Planner tool 'compose_a2a_plan' cancelled during partial_result",
                "system",
            )
        finally:
            mod._db = original_db

    @pytest.mark.asyncio
    async def test_normal_plan_does_not_record_cancellation(self):
        """Normal successful plan does NOT record a planner_cancelled activity."""
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db

        normal_plan = MagicMock(spec=CompositionPlan)
        normal_plan.cancelled = False
        normal_plan.to_dict.return_value = {"cancelled": False, "steps": []}

        async def _return_services():
            return []

        try:
            mod._db = mock_db
            with (
                patch.object(mod, "_fetch_services_with_schemas", _return_services),
                patch.object(mod, "_read_composition_settings", return_value={
                    "max_depth": 5, "max_candidates": 10, "max_calls": 20,
                    "max_cost_usdc": 100.0, "max_planning_time_seconds": 30.0,
                    "schema_strictness": "compatible",
                }),
                patch.object(
                    CompositionPlanner, "plan_composition",
                    return_value=normal_plan,
                ),
            ):
                result = await mod.compose_a2a_plan(goal_description="normal")

            assert result["cancelled"] is False
            mock_db.add_activity.assert_not_called()
        finally:
            mod._db = original_db


# ── plan_purchase tool cancellation ────────────────────────────────────────────


class TestPlanPurchaseCancellation:
    """plan_purchase tool handles asyncio.CancelledError during fetch."""

    @pytest.mark.asyncio
    async def test_cancel_during_service_fetch(self):
        from talos_agent.tools import planning as mod

        mock_db = MagicMock()
        original_db = mod._db

        async def _cancel_fetch(**kwargs):
            raise asyncio.CancelledError()

        try:
            mod._db = mock_db
            with patch.object(mod, "_fetch_services", _cancel_fetch):
                with pytest.raises(asyncio.CancelledError):
                    await mod.plan_purchase(target_service="test")

            mock_db.add_activity.assert_called_once_with(
                "planner_cancelled",
                "Planner tool 'plan_purchase' cancelled during service_fetch",
                "system",
            )
        finally:
            mod._db = original_db


# ── _record_planner_cancellation ───────────────────────────────────────────────


class TestRecordPlannerCancellation:
    """Durable recording helper is resilient and privacy-safe."""

    def test_records_activity_when_db_available(self):
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db
        try:
            mod._db = mock_db
            _record_planner_cancellation("test_tool", "test_phase")
            mock_db.add_activity.assert_called_once_with(
                "planner_cancelled",
                "Planner tool 'test_tool' cancelled during test_phase",
                "system",
            )
        finally:
            mod._db = original_db

    def test_does_not_raise_when_db_is_none(self):
        from talos_agent.tools import a2a_composition as mod

        original_db = mod._db
        try:
            mod._db = None
            # Must not raise
            _record_planner_cancellation("test_tool", "test_phase")
        finally:
            mod._db = original_db

    def test_does_not_raise_when_db_throws(self):
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        mock_db.add_activity.side_effect = RuntimeError("db error")
        original_db = mod._db
        try:
            mod._db = mock_db
            # Must not raise
            _record_planner_cancellation("test_tool", "test_phase")
        finally:
            mod._db = original_db

    def test_privacy_safe_message_content(self):
        """Recorded message contains only tool name and phase, no secrets."""
        from talos_agent.tools import a2a_composition as mod

        mock_db = MagicMock()
        original_db = mod._db
        try:
            mod._db = mock_db
            _record_planner_cancellation("compose_a2a_plan", "service_fetch")
            recorded_msg = mock_db.add_activity.call_args[0][1]
            assert "sk-" not in recorded_msg
            assert "seed" not in recorded_msg.lower()
            assert "secret" not in recorded_msg.lower()
            assert "payment" not in recorded_msg.lower()
        finally:
            mod._db = original_db


# ── PLANNER_TOOL_NAMES constant ────────────────────────────────────────────────


class TestPlannerToolNames:
    """PLANNER_TOOL_NAMES is correctly populated."""

    def test_contains_compose_a2a_plan(self):
        assert "compose_a2a_plan" in PLANNER_TOOL_NAMES

    def test_contains_plan_purchase(self):
        assert "plan_purchase" in PLANNER_TOOL_NAMES

    def test_contains_normalize_providers(self):
        assert "normalize_providers" in PLANNER_TOOL_NAMES

    def test_is_frozenset(self):
        assert isinstance(PLANNER_TOOL_NAMES, frozenset)

    def test_does_not_contain_non_planner_tools(self):
        assert "browse_page" not in PLANNER_TOOL_NAMES
        assert "purchase_service" not in PLANNER_TOOL_NAMES


# ── Boundary: malformed callback ───────────────────────────────────────────────


class TestPlannerMalformedCallback:
    """Edge cases with unusual callback return values."""

    def test_callback_returning_truthy_string_cancels(self):
        """Non-empty string is truthy → treated as cancelled."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: "yes")
        plan = planner.plan_composition(_make_services(3))
        assert plan.cancelled is True

    def test_callback_returning_zero_does_not_cancel(self):
        """0 is falsy → not cancelled."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: 0)
        plan = planner.plan_composition(_make_services(3))
        assert plan.cancelled is False

    def test_callback_returning_empty_string_does_not_cancel(self):
        """Empty string is falsy → not cancelled."""
        planner = CompositionPlanner(max_depth=3, cancelled=lambda: "")
        plan = planner.plan_composition(_make_services(3))
        assert plan.cancelled is False

    def test_callback_raising_exception_propagates(self):
        """If the callback itself raises, the error propagates (not swallowed)."""
        def _bad_callback():
            raise ValueError("broken callback")

        planner = CompositionPlanner(max_depth=3, cancelled=_bad_callback)
        with pytest.raises(ValueError, match="broken callback"):
            planner.plan_composition(_make_services(3))


# ── Regression: existing callers without cancellation ──────────────────────────


class TestRegressionExistingCallers:
    """Existing callers that don't pass cancelled still work unchanged."""

    def test_default_planner_has_no_cancelled_callback(self):
        planner = CompositionPlanner()
        assert planner._cancelled is None

    def test_default_planner_check_cancelled_is_noop(self):
        planner = CompositionPlanner()
        planner._check_cancelled()  # must not raise

    def test_plan_without_callback_has_cancelled_false(self):
        planner = CompositionPlanner(max_depth=3)
        plan = planner.plan_composition(_make_services(3))
        assert plan.cancelled is False

    def test_plan_dict_without_callback_contains_cancelled_key(self):
        """Serialised plan always includes the `cancelled` key for schema stability."""
        planner = CompositionPlanner(max_depth=3)
        d = planner.plan_composition(_make_services(3)).to_dict()
        assert "cancelled" in d
        assert d["cancelled"] is False
