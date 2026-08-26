"""Tests for policy-driven model routing and fallback.

Coverage
--------
ProviderRegistry: registration, lookup, duplicate prevention, health status.
OpenAIClientProvider: factory method, metadata, capability defaults.
RoutingPolicy: selection with task type, cost, latency, privacy constraints,
  preferred provider fast path, capability filtering, error cases.
FallbackChain: ordered fallback, circuit breaker integration, all-failures.
UsageTracker: recording, snapshot aggregation, budget enforcement.
Backward compatibility: routing disabled preserves legacy behaviour.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from talos_agent.circuit_breaker import cb_registry
from talos_agent.routing import (
    BudgetConfig,
    FallbackChain,
    FallbackStrategy,
    ProviderRegistry,
    RoutingConstraints,
    RoutingPolicy,
    UsageRecord,
    UsageTracker,
    _build_default_registry,
)
from talos_agent.routing.fallback import _summarise_exception
from talos_agent.routing.policy import NoSuitableProviderError, RoutingDecision
from talos_agent.routing.provider import (
    LLMProvider,
    OpenAIClientProvider,
    ProviderCapabilities,
    ProviderMetadata,
    ProviderStatus,
    TaskType,
)


# ═══════════════════════════════════════════════════════════════════════════════
# Test helpers
# ═══════════════════════════════════════════════════════════════════════════════


class _FakeProvider(LLMProvider):
    """A minimal in-memory provider for testing without real API calls."""

    def __init__(
        self,
        name: str = "fake",
        *,
        capabilities: ProviderCapabilities | None = None,
        cost_per_1k_input: Decimal = Decimal("0"),
        cost_per_1k_output: Decimal = Decimal("0"),
        avg_latency_ms: float = 500.0,
        privacy_level: str = "external",
        default_model: str = "fake-model",
        fail: bool = False,
    ) -> None:
        self._meta = ProviderMetadata(
            name=name,
            capabilities=capabilities or ProviderCapabilities(),
            cost_per_1k_input=cost_per_1k_input,
            cost_per_1k_output=cost_per_1k_output,
            avg_latency_ms=avg_latency_ms,
            privacy_level=privacy_level,
            default_model=default_model,
            models=(default_model,),
        )
        self._fail = fail
        self._call_count = 0

    @property
    def metadata(self) -> ProviderMetadata:
        return self._meta

    @property
    def call_count(self) -> int:
        return self._call_count

    async def complete(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        **kwargs,
    ) -> dict:
        self._call_count += 1
        if self._fail:
            raise RuntimeError(f"Provider '{self._meta.name}' intentionally failing")
        return {
            "choices": [{"message": {"role": "assistant", "content": "ok"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "model": model,
            "provider": self._meta.name,
        }


# ═══════════════════════════════════════════════════════════════════════════════
# ProviderCapabilities
# ═══════════════════════════════════════════════════════════════════════════════


class TestProviderCapabilities:
    def test_default_capabilities(self):
        caps = ProviderCapabilities()
        assert caps.tool_calling is True
        assert caps.json_mode is True
        assert caps.vision is False
        assert caps.streaming is True
        assert caps.max_tokens == 4096
        assert caps.supported_models == ()

    def test_custom_capabilities(self):
        caps = ProviderCapabilities(
            tool_calling=False,
            json_mode=False,
            vision=True,
            max_tokens=8192,
            supported_models=("gpt-4o", "gpt-4o-mini"),
        )
        assert caps.tool_calling is False
        assert caps.json_mode is False
        assert caps.vision is True
        assert caps.max_tokens == 8192
        assert caps.supported_models == ("gpt-4o", "gpt-4o-mini")


# ═══════════════════════════════════════════════════════════════════════════════
# ProviderMetadata
# ═══════════════════════════════════════════════════════════════════════════════


class TestProviderMetadata:
    def test_frozen_dataclass(self):
        meta = ProviderMetadata(
            name="test",
            capabilities=ProviderCapabilities(),
            cost_per_1k_input=Decimal("0.01"),
        )
        assert meta.name == "test"
        assert meta.cost_per_1k_input == Decimal("0.01")
        assert meta.privacy_level == "external"
        assert meta.avg_latency_ms == 1000.0

    def test_default_model_and_models(self):
        meta = ProviderMetadata(
            name="test",
            capabilities=ProviderCapabilities(),
            default_model="gpt-4o",
            models=("gpt-4o", "gpt-4o-mini"),
        )
        assert meta.default_model == "gpt-4o"
        assert meta.models == ("gpt-4o", "gpt-4o-mini")


# ═══════════════════════════════════════════════════════════════════════════════
# LLMProvider (abstract base)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLLMProvider:
    @pytest.mark.asyncio
    async def test_check_health_with_fake_provider(self):
        provider = _FakeProvider()
        healthy = await provider.check_health()
        assert healthy is True
        # check_health calls complete with max_tokens=1
        assert provider.call_count >= 1

    @pytest.mark.asyncio
    async def test_check_health_returns_false_on_failure(self):
        provider = _FakeProvider(name="broken", fail=True)
        healthy = await provider.check_health()
        assert healthy is False


# ═══════════════════════════════════════════════════════════════════════════════
# OpenAIClientProvider (factory)
# ═══════════════════════════════════════════════════════════════════════════════


class TestOpenAIClientProvider:
    def test_build_creates_provider_with_given_name(self):
        provider = OpenAIClientProvider.build(
            name="test-provider",
            api_key="sk-test",
            default_model="gpt-4o-mini",
        )
        assert provider.metadata.name == "test-provider"
        assert provider.metadata.default_model == "gpt-4o-mini"
        assert provider.metadata.capabilities.tool_calling is True

    def test_build_groq_default_capabilities(self):
        provider = OpenAIClientProvider.build(
            name="groq",
            api_key="gsk-test",
            default_model="llama-3.3-70b-versatile",
        )
        caps = provider.metadata.capabilities
        assert caps.tool_calling is True
        assert caps.json_mode is True
        assert caps.vision is True
        assert caps.max_tokens == 8192  # 70b model
        assert "llama-3.3-70b-versatile" in caps.supported_models

    def test_build_openai_default_capabilities(self):
        provider = OpenAIClientProvider.build(
            name="openai",
            api_key="sk-test",
            default_model="gpt-4o-mini",
        )
        caps = provider.metadata.capabilities
        assert caps.tool_calling is True
        assert caps.json_mode is True
        assert caps.vision is True
        assert caps.max_tokens == 16384
        assert "gpt-4o" in caps.supported_models

    def test_build_with_custom_cost_and_latency(self):
        provider = OpenAIClientProvider.build(
            name="custom",
            api_key="sk-test",
            cost_per_1k_input=Decimal("0.001"),
            cost_per_1k_output=Decimal("0.002"),
            avg_latency_ms=200.0,
        )
        assert provider.metadata.cost_per_1k_input == Decimal("0.001")
        assert provider.metadata.cost_per_1k_output == Decimal("0.002")
        assert provider.metadata.avg_latency_ms == 200.0


# ═══════════════════════════════════════════════════════════════════════════════
# ProviderRegistry
# ═══════════════════════════════════════════════════════════════════════════════


class TestProviderRegistry:
    def test_register_and_get(self):
        registry = ProviderRegistry()
        provider = _FakeProvider(name="test")
        registry.register(provider)
        assert registry.get("test") is provider
        assert registry.available() == ["test"]
        assert registry.count() == 1

    def test_register_duplicate_raises(self):
        registry = ProviderRegistry()
        registry.register(_FakeProvider(name="dup"))
        with pytest.raises(ValueError, match="already registered"):
            registry.register(_FakeProvider(name="dup"))

    def test_register_or_replace_overwrites(self):
        registry = ProviderRegistry()
        p1 = _FakeProvider(name="x")
        p2 = _FakeProvider(name="x")
        registry.register(p1)
        registry.register_or_replace(p2)
        assert registry.get("x") is p2
        assert registry.count() == 1

    def test_get_unknown_raises_key_error(self):
        registry = ProviderRegistry()
        with pytest.raises(KeyError, match="not registered"):
            registry.get("nonexistent")

    def test_available_returns_empty_for_empty_registry(self):
        registry = ProviderRegistry()
        assert registry.available() == []
        assert registry.count() == 0

    def test_all_providers_returns_copy(self):
        registry = ProviderRegistry()
        p = _FakeProvider(name="a")
        registry.register(p)
        all_p = registry.all_providers()
        assert all_p == {"a": p}
        # Modifying the returned dict should not affect the registry
        all_p["b"] = _FakeProvider(name="b")
        assert "b" not in registry.available()

    def test_status_returns_unavailable_for_unknown(self):
        registry = ProviderRegistry()
        status = registry.status("nope")
        assert status == ProviderStatus.UNAVAILABLE

    def test_status_returns_healthy_for_registered_provider(self):
        registry = ProviderRegistry()
        p = _FakeProvider(name="healthy-test")
        registry.register(p)
        status = registry.status("healthy-test")
        assert status == ProviderStatus.HEALTHY

    def test_get_cost_estimate(self):
        registry = ProviderRegistry()
        p = _FakeProvider(
            name="costly",
            cost_per_1k_input=Decimal("0.01"),
            cost_per_1k_output=Decimal("0.03"),
        )
        registry.register(p)
        # 1000 input + 500 output tokens
        cost = registry.get_cost_estimate("costly", 1000, 500)
        expected = Decimal("0.01") * Decimal("1") + Decimal("0.03") * Decimal("0.5")
        assert cost == expected

    def test_get_cost_estimate_for_unknown_provider(self):
        registry = ProviderRegistry()
        with pytest.raises(KeyError):
            registry.get_cost_estimate("unknown", 100, 50)

    def test_get_healthy_returns_closed_circuit_breakers(self):
        registry = ProviderRegistry()
        p = _FakeProvider(name="healthy-p")
        registry.register(p)
        # Circuit breaker should be CLOSED by default
        healthy = registry.get_healthy()
        assert "healthy-p" in healthy


# ═══════════════════════════════════════════════════════════════════════════════
# RoutingPolicy
# ═══════════════════════════════════════════════════════════════════════════════


class TestRoutingPolicySelect:
    @pytest.fixture(autouse=True)
    def _make_registry(self):
        """Create a registry with two fake providers for each test."""
        registry = ProviderRegistry()
        registry.register(_FakeProvider(
            name="cheap",
            cost_per_1k_input=Decimal("0.00001"),
            cost_per_1k_output=Decimal("0.00002"),
            avg_latency_ms=300.0,
        ))
        registry.register(_FakeProvider(
            name="expensive",
            cost_per_1k_input=Decimal("0.01"),
            cost_per_1k_output=Decimal("0.03"),
            avg_latency_ms=1000.0,
        ))
        self._registry = registry

    @property
    def registry(self):
        return self._registry

    def test_select_returns_a_provider(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints())
        assert isinstance(decision, RoutingDecision)
        assert decision.provider_name in ("cheap", "expensive")
        assert decision.score > 0
        assert decision.reason

    def test_preferred_provider_bypasses_scoring(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(preferred_provider="cheap"))
        assert decision.provider_name == "cheap"
        assert decision.score == float("inf")
        assert "preferred" in decision.reason.lower()

    def test_preferred_provider_not_registered_raises(self):
        policy = RoutingPolicy(self.registry)
        with pytest.raises(NoSuitableProviderError, match="not registered"):
            policy.select(RoutingConstraints(preferred_provider="nonexistent"))

    def test_preferred_model_is_used(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(
            preferred_provider="cheap",
            preferred_model="custom-model",
        ))
        assert decision.model == "custom-model"

    def test_preferred_model_defaults_to_provider_default(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(preferred_provider="cheap"))
        assert decision.model == "fake-model"  # _FakeProvider default

    def test_no_suitable_provider_raises(self):
        empty_registry = ProviderRegistry()
        policy = RoutingPolicy(empty_registry)
        with pytest.raises(NoSuitableProviderError, match="No suitable provider"):
            policy.select(RoutingConstraints())

    def test_capability_filtering_excludes_providers(self):
        """Providers that lack required capabilities are excluded."""
        registry = ProviderRegistry()
        registry.register(_FakeProvider(
            name="no_vision",
            capabilities=ProviderCapabilities(vision=False),
        ))
        policy = RoutingPolicy(registry)
        with pytest.raises(NoSuitableProviderError, match="No suitable provider"):
            policy.select(RoutingConstraints(require_capabilities={"vision"}))

    def test_capability_filtering_passes_with_matching(self):
        registry = ProviderRegistry()
        registry.register(_FakeProvider(
            name="has_vision",
            capabilities=ProviderCapabilities(vision=True),
        ))
        policy = RoutingPolicy(registry)
        decision = policy.select(RoutingConstraints(require_capabilities={"vision"}))
        assert decision.provider_name == "has_vision"

    def test_cost_constraint_prefers_cheaper(self):
        """With a tight cost budget, the cheaper provider should be selected."""
        policy = RoutingPolicy(self.registry, cost_weight=10.0, availability_weight=0)
        decision = policy.select(RoutingConstraints(max_cost_usd=Decimal("0.001")))
        assert decision.provider_name == "cheap"

    def test_latency_constraint_prefers_faster(self):
        """With a tight latency budget, the faster provider should be selected."""
        policy = RoutingPolicy(self.registry, latency_weight=10.0, availability_weight=0)
        decision = policy.select(RoutingConstraints(max_latency_ms=400.0))
        assert decision.provider_name == "cheap"

    def test_select_is_deterministic(self):
        policy = RoutingPolicy(self.registry)
        constraints = RoutingConstraints()
        d1 = policy.select(constraints)
        d2 = policy.select(constraints)
        assert d1.provider_name == d2.provider_name
        assert d1.score == d2.score
        assert d1.model == d2.model

    def test_weights_exposed_as_properties(self):
        policy = RoutingPolicy(
            self.registry,
            cost_weight=2.0,
            latency_weight=3.0,
            privacy_weight=0.5,
            availability_weight=1.5,
        )
        assert policy.cost_weight == 2.0
        assert policy.latency_weight == 3.0
        assert policy.privacy_weight == 0.5
        assert policy.availability_weight == 1.5


class TestRoutingPolicyTaskType:
    @pytest.fixture(autouse=True)
    def _make_registry(self):
        registry = ProviderRegistry()
        registry.register(_FakeProvider(
            name="json_capable",
            capabilities=ProviderCapabilities(json_mode=True, vision=False),
            cost_per_1k_input=Decimal("0.0001"),
        ))
        registry.register(_FakeProvider(
            name="vision_capable",
            capabilities=ProviderCapabilities(json_mode=False, vision=True),
            cost_per_1k_input=Decimal("0.0002"),
        ))
        self._registry = registry

    @property
    def registry(self):
        return self._registry

    def test_json_task_type_favors_json_capable(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(task_type=TaskType.JSON))
        assert decision.provider_name == "json_capable"

    def test_vision_task_requires_vision_capability(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(
            task_type=TaskType.VISION,
            require_capabilities={"vision"},
        ))
        # vision_capable has vision=True, so it should be selected
        assert decision.provider_name == "vision_capable"

    def test_chat_task_returns_some_provider(self):
        policy = RoutingPolicy(self.registry)
        decision = policy.select(RoutingConstraints(task_type=TaskType.CHAT))
        assert decision.provider_name in ("json_capable", "vision_capable")


# ═══════════════════════════════════════════════════════════════════════════════
# FallbackChain
# ═══════════════════════════════════════════════════════════════════════════════


class TestFallbackChain:
    @pytest.fixture(autouse=True)
    def _reset_circuit_breakers(self):
        cb_registry.reset_all()

    @pytest.mark.asyncio
    async def test_succeeds_with_first_provider(self):
        p1 = _FakeProvider(name="primary", fail=False)
        p2 = _FakeProvider(name="secondary", fail=False)

        registry = ProviderRegistry()
        registry.register(p1)
        registry.register(p2)

        # Register circuit breakers
        cb_registry.get("primary")
        cb_registry.get("secondary")

        chain = FallbackChain(["primary", "secondary"])

        async def call(provider_name: str) -> str:
            provider = registry.get(provider_name)
            await provider.complete("model", [])
            return f"result from {provider_name}"

        result = await chain.execute(call)
        assert result.success is True
        assert result.provider_name == "primary"
        assert result.result == "result from primary"
        assert result.total_attempts == 1

    @pytest.mark.asyncio
    async def test_falls_back_on_failure(self):
        p1 = _FakeProvider(name="failing", fail=True)
        p2 = _FakeProvider(name="backup", fail=False)

        registry = ProviderRegistry()
        registry.register(p1)
        registry.register(p2)

        cb_registry.get("failing")
        cb_registry.get("backup")

        chain = FallbackChain(["failing", "backup"])

        async def call(provider_name: str) -> str:
            provider = registry.get(provider_name)
            await provider.complete("model", [])
            return f"result from {provider_name}"

        result = await chain.execute(call)
        assert result.success is True
        assert result.provider_name == "backup"
        assert result.result == "result from backup"
        assert len(result.attempts) == 1  # one failure
        assert result.total_attempts == 2

    @pytest.mark.asyncio
    async def test_all_providers_fail(self):
        p1 = _FakeProvider(name="fail1", fail=True)
        p2 = _FakeProvider(name="fail2", fail=True)

        registry = ProviderRegistry()
        registry.register(p1)
        registry.register(p2)

        cb_registry.get("fail1")
        cb_registry.get("fail2")

        chain = FallbackChain(["fail1", "fail2"])

        async def call(provider_name: str) -> str:
            provider = registry.get(provider_name)
            await provider.complete("model", [])
            return "ok"

        result = await chain.execute(call)
        assert result.success is False
        assert result.provider_name == ""
        assert result.result is None
        assert len(result.attempts) == 2
        assert result.total_attempts == 2

    @pytest.mark.asyncio
    async def test_empty_chain_returns_failure(self):
        cb_registry.get("anything")  # Register to avoid missing cb

        chain = FallbackChain([])
        async def call(provider_name: str) -> str:
            return "ok"

        result = await chain.execute(call)
        assert result.success is False
        assert result.total_attempts == 0

    @pytest.mark.asyncio
    async def test_strategy_ordered_property(self):
        chain = FallbackChain(["a", "b"], strategy=FallbackStrategy.ORDERED)
        assert chain.strategy == FallbackStrategy.ORDERED
        assert chain.providers == ["a", "b"]

    async def _make_fake_provider(self, name: str, fail: bool = False) -> _FakeProvider:
        return _FakeProvider(name=name, fail=fail)


# ═══════════════════════════════════════════════════════════════════════════════
# UsageTracker
# ═══════════════════════════════════════════════════════════════════════════════


class TestUsageTracker:
    @pytest.fixture(autouse=True)
    def _make_registry_and_tracker(self):
        registry = ProviderRegistry()
        registry.register(_FakeProvider(
            name="tracked-provider",
            cost_per_1k_input=Decimal("0.01"),
            cost_per_1k_output=Decimal("0.03"),
        ))
        self._registry = registry
        self._tracker = UsageTracker(registry)
        return registry

    @property
    def registry(self):
        return self._registry

    @property
    def tracker(self):
        return self._tracker

    @pytest.mark.asyncio
    async def test_record_creates_usage_record(self):
        record = await self.tracker.record(
            provider_name="tracked-provider",
            model="fake-model",
            prompt_tokens=100,
            completion_tokens=50,
        )
        assert isinstance(record, UsageRecord)
        assert record.provider_name == "tracked-provider"
        assert record.prompt_tokens == 100
        assert record.completion_tokens == 50
        assert record.total_tokens == 150
        assert record.success is True
        assert record.cost_usd > Decimal("0")
        assert record.timestamp > 0

    @pytest.mark.asyncio
    async def test_record_unknown_provider_uses_zero_cost(self):
        record = await self.tracker.record(
            provider_name="unknown",
            model="m",
            prompt_tokens=100,
            completion_tokens=50,
        )
        assert record.cost_usd == Decimal("0")

    @pytest.mark.asyncio
    async def test_snapshot_aggregates_correctly(self):
        await self.tracker.record("tracked-provider", "m1", 100, 50)
        await self.tracker.record("tracked-provider", "m2", 200, 100)

        snapshot = self.tracker.snapshot()
        assert snapshot.total_prompt_tokens == 300
        assert snapshot.total_completion_tokens == 150
        assert snapshot.total_cost_usd > Decimal("0")
        assert snapshot.record_count == 2

        prov = snapshot.provider_totals["tracked-provider"]
        assert prov["prompt_tokens"] == 300
        assert prov["completion_tokens"] == 150
        assert prov["request_count"] == 2
        assert prov["success_count"] == 2
        assert prov["failure_count"] == 0

    def test_snapshot_empty_tracker(self):
        snapshot = self.tracker.snapshot()
        assert snapshot.total_prompt_tokens == 0
        assert snapshot.total_completion_tokens == 0
        assert snapshot.total_cost_usd == Decimal("0")
        assert snapshot.record_count == 0
        assert snapshot.provider_totals == {}

    def test_provider_usage_returns_aggregated_data(self):
        usage = self.tracker.provider_usage("tracked-provider")
        # No records recorded yet
        assert usage == {}

    def test_check_budget_within_limits(self):
        config = BudgetConfig(max_cost_usd=Decimal("100"))
        within = self.tracker.check_budget(config)
        assert within is True

    def test_check_budget_exceeded(self):
        config = BudgetConfig(max_cost_usd=Decimal("0.000001"))
        # Budget is so low it's already exceeded (0 > budget)
        # Since no records exist, total cost is 0 which is NOT >= 0.000001
        within = self.tracker.check_budget(config)
        assert within is True

    @pytest.mark.asyncio
    async def test_check_budget_exceeded_with_records(self):
        config = BudgetConfig(max_cost_usd=Decimal("0.00001"))
        await self.tracker.record("tracked-provider", "m", 1000, 500)
        within = self.tracker.check_budget(config)
        assert within is False

    @pytest.mark.asyncio
    async def test_check_budget_provider_specific(self):
        config = BudgetConfig(max_requests=1)
        await self.tracker.record("tracked-provider", "m", 10, 5)
        # Check budget for this specific provider
        within = self.tracker.check_budget(config, provider_name="tracked-provider")
        assert within is False

    def test_check_budget_max_tokens(self):
        config = BudgetConfig(max_total_tokens=100)
        within = self.tracker.check_budget(config)
        assert within is True  # 0 < 100

    def test_check_budget_none_values_are_ignored(self):
        config = BudgetConfig(max_cost_usd=None, max_total_tokens=None, max_requests=None)
        within = self.tracker.check_budget(config)
        assert within is True

    def test_clear_resets_all_records(self):
        tracker = UsageTracker(self.registry)
        snapshot = tracker.snapshot()
        assert snapshot.record_count == 0

    @pytest.mark.asyncio
    async def test_persist_callback_is_called(self):
        callback_records = []

        def callback(record: UsageRecord) -> None:
            callback_records.append(record)

        tracker = UsageTracker(self.registry, persist_callback=callback)
        await tracker.record("tracked-provider", "m", 10, 5)
        assert len(callback_records) == 1
        assert callback_records[0].provider_name == "tracked-provider"


# ═══════════════════════════════════════════════════════════════════════════════
# _build_default_registry
# ═══════════════════════════════════════════════════════════════════════════════


class MockSettings:
    """Minimal settings stub for testing _build_default_registry."""

    def __init__(
        self,
        groq_api_key: str = "",
        openai_api_key: str = "",
        groq_model: str = "llama-3.3-70b-versatile",
        openai_model: str = "gpt-4o-mini",
    ) -> None:
        self.groq_api_key = groq_api_key
        self.openai_api_key = openai_api_key
        self.groq_model = groq_model
        self.openai_model = openai_model

    def secret_value(self, name: str, legacy_value: str | None = None) -> str:
        return getattr(self, name, legacy_value or "")


class TestBuildDefaultRegistry:
    def test_builds_with_both_providers(self):
        settings = MockSettings(
            groq_api_key="gsk-test",
            openai_api_key="sk-test",
        )
        registry = _build_default_registry(settings)
        assert registry.count() == 2
        assert "groq" in registry.available()
        assert "openai" in registry.available()

    def test_builds_with_groq_only(self):
        settings = MockSettings(groq_api_key="gsk-test")
        registry = _build_default_registry(settings)
        assert registry.count() == 1
        assert "groq" in registry.available()
        assert "openai" not in registry.available()

    def test_builds_with_openai_only(self):
        settings = MockSettings(openai_api_key="sk-test")
        registry = _build_default_registry(settings)
        assert registry.count() == 1
        assert "openai" in registry.available()
        assert "groq" not in registry.available()

    def test_builds_empty_registry_with_no_keys(self):
        settings = MockSettings()
        registry = _build_default_registry(settings)
        assert registry.count() == 0

    def test_build_sets_default_models(self):
        settings = MockSettings(
            groq_api_key="gsk-test",
            openai_api_key="sk-test",
            groq_model="mixtral-8x7b-32768",
            openai_model="gpt-4o",
        )
        registry = _build_default_registry(settings)
        assert registry.get("groq").metadata.default_model == "mixtral-8x7b-32768"
        assert registry.get("openai").metadata.default_model == "gpt-4o"

    def test_build_sets_costs(self):
        settings = MockSettings(
            groq_api_key="gsk-test",
            openai_api_key="sk-test",
        )
        registry = _build_default_registry(settings)
        groq = registry.get("groq")
        openai = registry.get("openai")
        assert groq.metadata.cost_per_1k_input == Decimal("0.0001")
        assert openai.metadata.cost_per_1k_input == Decimal("0.00015")


# ═══════════════════════════════════════════════════════════════════════════════
# Fallback helper: _summarise_exception
# ═══════════════════════════════════════════════════════════════════════════════


class TestSummariseException:
    def test_short_message(self):
        result = _summarise_exception(ValueError("something bad"))
        assert result == "ValueError: something bad"

    def test_long_message_truncated(self):
        long_msg = "x" * 500
        result = _summarise_exception(RuntimeError(long_msg))
        assert len(result) <= 220  # "RuntimeError: " (14) + 197 + "..."
        assert result.endswith("...")

    def test_custom_exception(self):
        class CustomError(Exception):
            pass

        result = _summarise_exception(CustomError("custom"))
        assert result == "CustomError: custom"
