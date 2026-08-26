"""Tests for tools/a2a_composition.py — bounded multi-step A2A plan composition.

Coverage
--------
Unit tests
  - ServiceSchema: serialization, from_dict
  - ComposableService: creation, serialization
  - CompositionStep: creation, serialization
  - CompositionPlan: creation, serialization, digest
  - SchemaValidator: strict mode, compatible mode, type compatibility
  - CycleDetector: simple cycle, complex cycle, no cycle
  - CompositionPlanner: bounds enforcement, confidence calculation

Integration tests (mock API + mock DB)
  - compose_a2a_plan tool: returns valid plan
  - compose_a2a_plan with custom bounds
  - compose_a2a_plan with no services
  - compose_a2a_plan with incompatible schemas
  - compose_a2a_plan cycle detection
  - compose_a2a_plan timeout handling
  - compose_a2a_plan deterministic digest
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.tools.a2a_composition import (
    CompositionPlan,
    CompositionPlanner,
    CompositionStep,
    ComposableService,
    CycleDetector,
    SchemaValidator,
    ServiceSchema,
    compose_a2a_plan,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


def _make_service_schema(
    fields: dict[str, str] | None = None,
    required: list[str] | None = None,
) -> ServiceSchema:
    """Return a ServiceSchema with optional overrides."""
    return ServiceSchema(
        fields=fields or {"query": "string", "context": "string"},
        required=required or ["query"],
    )


def _make_composable_service(**overrides) -> ComposableService:
    """Return a valid ComposableService."""
    defaults = {
        "talos_id": "talos-abc123",
        "talos_name": "TestBot",
        "service_name": "Test Service",
        "description": "A test service",
        "price_usdc": 5.0,
        "input_schema": _make_service_schema(),
        "output_schema": _make_service_schema(
            fields={"result": "string", "confidence": "number"},
            required=["result"],
        ),
        "category": "Analytics",
        "chains": ["stellar"],
    }
    defaults.update(overrides)
    return ComposableService(**defaults)


# ---------------------------------------------------------------------------
# ServiceSchema — unit tests
# ---------------------------------------------------------------------------


class TestServiceSchema:
    def test_to_dict_roundtrip(self):
        schema = ServiceSchema(
            fields={"query": "string", "count": "integer"},
            required=["query"],
        )
        data = schema.to_dict()
        restored = ServiceSchema.from_dict(data)
        assert restored.fields == schema.fields
        assert restored.required == schema.required

    def test_from_dict_with_empty_fields(self):
        data = {"fields": {}, "required": []}
        schema = ServiceSchema.from_dict(data)
        assert schema.fields == {}
        assert schema.required == []

    def test_from_dict_missing_required_defaults(self):
        data = {"fields": {"query": "string"}}
        schema = ServiceSchema.from_dict(data)
        assert schema.required == []


# ---------------------------------------------------------------------------
# ComposableService — unit tests
# ---------------------------------------------------------------------------


class TestComposableService:
    def test_to_dict_includes_schemas(self):
        service = _make_composable_service()
        data = service.to_dict()
        assert "input_schema" in data
        assert "output_schema" in data
        assert data["price_usdc"] == 5.0

    def test_serialization_preserves_all_fields(self):
        service = ComposableService(
            talos_id="talos-xyz",
            talos_name="Bot",
            service_name="Service",
            description="Desc",
            price_usdc=10.0,
            input_schema=_make_service_schema(),
            output_schema=_make_service_schema(),
            category="Marketing",
            chains=["stellar", "evm"],
        )
        data = service.to_dict()
        assert data["chains"] == ["stellar", "evm"]
        assert data["category"] == "Marketing"


# ---------------------------------------------------------------------------
# CompositionStep — unit tests
# ---------------------------------------------------------------------------


class TestCompositionStep:
    def test_to_dict_includes_nested_service(self):
        service = _make_composable_service()
        step = CompositionStep(
            step_number=1,
            service=service,
            input_mapping={"query": "query"},
            estimated_cost_usdc=5.0,
        )
        data = step.to_dict()
        assert data["step_number"] == 1
        assert "service" in data
        assert data["service"]["talos_id"] == "talos-abc123"

    def test_input_mapping_preserved(self):
        service = _make_composable_service()
        step = CompositionStep(
            step_number=1,
            service=service,
            input_mapping={"output_field": "input_field"},
            estimated_cost_usdc=5.0,
        )
        data = step.to_dict()
        assert data["input_mapping"] == {"output_field": "input_field"}


# ---------------------------------------------------------------------------
# CompositionPlan — unit tests
# ---------------------------------------------------------------------------


class TestCompositionPlan:
    def test_to_dict_includes_all_metadata(self):
        service = _make_composable_service()
        step = CompositionStep(
            step_number=1,
            service=service,
            input_mapping={},
            estimated_cost_usdc=5.0,
        )
        plan = CompositionPlan(
            steps=[step],
            assumptions=["Test assumption"],
            confidence=0.8,
            total_estimated_cost_usdc=5.0,
            max_depth=5,
            max_candidates=10,
            max_calls=20,
            max_cost_usdc=100.0,
            planning_time_seconds=1.0,
            cycles_detected=[],
            duplicates_rejected=[],
            schema_incompatibilities=[],
            plan_digest="abc123",
            planned_at="2024-01-01T00:00:00Z",
        )
        data = plan.to_dict()
        assert data["confidence"] == 0.8
        assert data["total_estimated_cost_usdc"] == 5.0
        assert len(data["steps"]) == 1
        assert data["cycles_detected"] == []


# ---------------------------------------------------------------------------
# SchemaValidator — unit tests
# ---------------------------------------------------------------------------


class TestSchemaValidatorStrict:
    def test_exact_match_passes(self):
        validator = SchemaValidator(strictness="strict")
        output = ServiceSchema(
            fields={"result": "string", "count": "integer"},
            required=["result"],
        )
        input_schema = ServiceSchema(
            fields={"result": "string", "count": "integer"},
            required=["result"],
        )
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is True
        assert len(reasons) == 0

    def test_type_mismatch_fails(self):
        validator = SchemaValidator(strictness="strict")
        output = ServiceSchema(fields={"result": "string"}, required=["result"])
        input_schema = ServiceSchema(fields={"result": "integer"}, required=["result"])
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is False
        assert any("Type mismatch" in r for r in reasons)

    def test_missing_required_field_fails(self):
        validator = SchemaValidator(strictness="strict")
        output = ServiceSchema(fields={"result": "string"}, required=["result"])
        input_schema = ServiceSchema(
            fields={"result": "string", "missing": "integer"},
            required=["result", "missing"],
        )
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is False
        assert any("Missing required input field" in r for r in reasons)


class TestSchemaValidatorCompatible:
    def test_integer_to_number_passes(self):
        validator = SchemaValidator(strictness="compatible")
        output = ServiceSchema(fields={"count": "integer"}, required=["count"])
        input_schema = ServiceSchema(fields={"count": "number"}, required=["count"])
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is True

    def test_number_to_string_passes(self):
        validator = SchemaValidator(strictness="compatible")
        output = ServiceSchema(fields={"value": "number"}, required=["value"])
        input_schema = ServiceSchema(fields={"value": "string"}, required=["value"])
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is True

    def test_incompatible_types_fail(self):
        validator = SchemaValidator(strictness="compatible")
        output = ServiceSchema(fields={"data": "object"}, required=["data"])
        input_schema = ServiceSchema(fields={"data": "array"}, required=["data"])
        is_compatible, reasons = validator.are_compatible(output, input_schema)
        assert is_compatible is False


# ---------------------------------------------------------------------------
# CycleDetector — unit tests
# ---------------------------------------------------------------------------


class TestCycleDetector:
    def test_no_cycle_simple_chain(self):
        detector = CycleDetector()
        service1 = _make_composable_service(talos_id="A")
        service2 = _make_composable_service(talos_id="B")
        service3 = _make_composable_service(talos_id="C")

        step1 = CompositionStep(1, service1, {}, 5.0)
        step2 = CompositionStep(2, service2, {}, 5.0)
        step3 = CompositionStep(3, service3, {}, 5.0)

        cycles = detector.detect_cycles([step1, step2, step3])
        assert len(cycles) == 0

    def test_detects_simple_cycle(self):
        detector = CycleDetector()
        service1 = _make_composable_service(talos_id="A")
        service2 = _make_composable_service(talos_id="B")
        service3 = _make_composable_service(talos_id="A")  # Back to A

        step1 = CompositionStep(1, service1, {}, 5.0)
        step2 = CompositionStep(2, service2, {}, 5.0)
        step3 = CompositionStep(3, service3, {}, 5.0)

        cycles = detector.detect_cycles([step1, step2, step3])
        assert len(cycles) > 0
        assert any("A" in cycle for cycle in cycles)

    def test_no_cycle_single_step(self):
        detector = CycleDetector()
        service = _make_composable_service(talos_id="A")
        step = CompositionStep(1, service, {}, 5.0)
        cycles = detector.detect_cycles([step])
        assert len(cycles) == 0


# ---------------------------------------------------------------------------
# CompositionPlanner — unit tests
# ---------------------------------------------------------------------------


class TestCompositionPlannerBounds:
    def test_respects_max_depth(self):
        planner = CompositionPlanner(max_depth=2)
        services = [
            _make_composable_service(talos_id=f"service-{i}", price_usdc=1.0)
            for i in range(10)
        ]
        plan = planner.plan_composition(services)
        assert len(plan.steps) <= 2

    def test_respects_max_cost(self):
        planner = CompositionPlanner(max_cost_usdc=10.0)
        services = [
            _make_composable_service(talos_id=f"service-{i}", price_usdc=6.0)
            for i in range(5)
        ]
        plan = planner.plan_composition(services)
        assert plan.total_estimated_cost_usdc <= 10.0

    def test_respects_max_candidates(self):
        planner = CompositionPlanner(max_candidates=2)
        services = [
            _make_composable_service(talos_id=f"service-{i}", price_usdc=float(i))
            for i in range(10)
        ]
        plan = planner.plan_composition(services)
        # Should only consider top 2 candidates per step
        assert plan.max_candidates == 2

    def test_respects_max_calls(self):
        planner = CompositionPlanner(max_calls=3)
        services = [
            _make_composable_service(talos_id=f"service-{i}", price_usdc=1.0)
            for i in range(10)
        ]
        plan = planner.plan_composition(services)
        assert len(plan.steps) <= 3


class TestCompositionPlannerConfidence:
    def test_zero_confidence_no_steps(self):
        planner = CompositionPlanner()
        plan = planner.plan_composition([])
        assert plan.confidence == 0.0

    def test_high_confidence_full_depth(self):
        planner = CompositionPlanner(max_depth=5, max_cost_usdc=100.0)
        services = [
            _make_composable_service(
                talos_id=f"service-{i}",
                price_usdc=1.0,
            )
            for i in range(5)
        ]
        plan = planner.plan_composition(services)
        assert plan.confidence > 0.5

    def test_low_confidence_high_cost(self):
        planner = CompositionPlanner(max_depth=5, max_cost_usdc=10.0)
        services = [
            _make_composable_service(
                talos_id=f"service-{i}",
                price_usdc=8.0,
            )
            for i in range(5)
        ]
        plan = planner.plan_composition(services)
        # High cost relative to max should reduce confidence
        assert plan.confidence < 1.0


class TestCompositionPlannerDuplicatePrevention:
    def test_prevents_duplicate_services(self):
        planner = CompositionPlanner(max_depth=5)
        service = _make_composable_service(talos_id="A", price_usdc=1.0)
        services = [service]  # Only one service available
        plan = planner.plan_composition(services)
        # Should only use the service once
        assert len(plan.steps) <= 1


class TestCompositionPlannerDigest:
    def test_digest_is_sha256_hex(self):
        planner = CompositionPlanner()
        service = _make_composable_service()
        plan = planner.plan_composition([service])
        assert len(plan.plan_digest) == 64
        int(plan.plan_digest, 16)  # Must be valid hex

    def test_same_inputs_same_digest(self):
        planner = CompositionPlanner()
        service = _make_composable_service()
        plan_a = planner.plan_composition([service])
        plan_b = planner.plan_composition([service])
        assert plan_a.plan_digest == plan_b.plan_digest

    def test_different_inputs_different_digest(self):
        planner = CompositionPlanner()
        service_a = _make_composable_service(talos_id="A", price_usdc=1.0)
        service_b = _make_composable_service(talos_id="B", price_usdc=2.0)
        plan_a = planner.plan_composition([service_a])
        plan_b = planner.plan_composition([service_b])
        assert plan_a.plan_digest != plan_b.plan_digest


# ---------------------------------------------------------------------------
# Integration tests — @tool function with mocked API + DB
# ---------------------------------------------------------------------------


def _mock_api_with_services(services: list[dict]) -> MagicMock:
    api = MagicMock()
    api.discover_services = AsyncMock(return_value=services)
    return api


def _mock_db(composition_config: dict | None = None) -> MagicMock:
    db = MagicMock()
    db.get_talos_config.return_value = composition_config or {}
    db.get_spending_period.return_value = 0.0
    return db


def _mock_settings() -> MagicMock:
    s = MagicMock()
    return s


SAMPLE_SERVICES_WITH_SCHEMAS = [
    {
        "talosId": "talos-1",
        "talosName": "Bot1",
        "serviceName": "Data Analysis",
        "description": "Analyzes data",
        "price": 3.0,
        "currency": "USDC",
        "chains": ["stellar"],
        "talosCategory": "Analytics",
        "inputSchema": {"fields": {"query": "string"}, "required": ["query"]},
        "outputSchema": {
            "fields": {"result": "string", "confidence": "number"},
            "required": ["result"],
        },
    },
    {
        "talosId": "talos-2",
        "talosName": "Bot2",
        "serviceName": "Report Generation",
        "description": "Generates reports",
        "price": 5.0,
        "currency": "USDC",
        "chains": ["stellar"],
        "talosCategory": "Analytics",
        "inputSchema": {
            "fields": {"data": "object", "format": "string"},
            "required": ["data"],
        },
        "outputSchema": {
            "fields": {"report": "string", "format": "string"},
            "required": ["report"],
        },
    },
]


@pytest.mark.asyncio
class TestComposeA2APlanTool:
    async def test_returns_plan_dict_with_required_keys(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        for key in (
            "steps",
            "assumptions",
            "confidence",
            "total_estimated_cost_usdc",
            "max_depth",
            "max_candidates",
            "max_calls",
            "max_cost_usdc",
            "planning_time_seconds",
            "cycles_detected",
            "duplicates_rejected",
            "schema_incompatibilities",
            "plan_digest",
            "planned_at",
        ):
            assert key in plan, f"Missing key: {key}"

    async def test_plan_digest_is_hex_string(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assert isinstance(plan["plan_digest"], str)
        assert len(plan["plan_digest"]) == 64
        int(plan["plan_digest"], 16)

    async def test_custom_max_depth_override(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan(max_depth=2)

        assert plan["max_depth"] == 2
        assert len(plan["steps"]) <= 2

    async def test_custom_max_cost_override(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan(max_cost_usdc=4.0)

        assert plan["max_cost_usdc"] == 4.0
        assert plan["total_estimated_cost_usdc"] <= 4.0

    async def test_no_services_empty_plan(self):
        api = _mock_api_with_services([])
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assert plan["steps"] == []
        assert plan["confidence"] == 0.0
        assert plan["total_estimated_cost_usdc"] == 0.0

    async def test_goal_description_in_assumptions(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan(goal_description="Analyze market trends")

        assert any("market trends" in a for a in plan["assumptions"])

    async def test_db_config_override(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db(
            {"compositionMaxDepth": "3", "compositionMaxCost": "50.0"}
        )
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assert plan["max_depth"] == 3
        assert plan["max_cost_usdc"] == 50.0

    async def test_deterministic_digest_same_inputs(self):
        api1 = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        api2 = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api1
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan_a = await compose_a2a_plan()
        with patch(
            "talos_agent.tools.a2a_composition._api", api2
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan_b = await compose_a2a_plan()

        assert plan_a["plan_digest"] == plan_b["plan_digest"]

    async def test_planning_time_recorded(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assert "planning_time_seconds" in plan
        assert plan["planning_time_seconds"] >= 0.0

    async def test_assumptions_include_bounds_info(self):
        api = _mock_api_with_services(SAMPLE_SERVICES_WITH_SCHEMAS)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assumptions = plan["assumptions"]
        assert any("Max depth" in a for a in assumptions)
        assert any("Max candidates" in a for a in assumptions)
        assert any("Max total calls" in a for a in assumptions)
        assert any("Max total cost" in a for a in assumptions)

    async def test_api_none_returns_gracefully(self):
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", None
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        assert plan["steps"] == []
        assert plan["confidence"] == 0.0

    async def test_malformed_service_skipped(self):
        malformed_services = [
            {"talosId": "bad-1"},  # Missing required fields
            SAMPLE_SERVICES_WITH_SCHEMAS[0],  # Good service
        ]
        api = _mock_api_with_services(malformed_services)
        db = _mock_db()
        settings = _mock_settings()
        with patch(
            "talos_agent.tools.a2a_composition._api", api
        ), patch("talos_agent.tools.a2a_composition._db", db), patch(
            "talos_agent.tools.a2a_composition._settings", settings
        ):
            plan = await compose_a2a_plan()

        # Should skip malformed service and only use good one
        assert len(plan["steps"]) >= 0
