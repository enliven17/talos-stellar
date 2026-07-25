"""Tests for tools/planning.py — provider normalisation and dry-run purchase plans.

Coverage
--------
Unit tests
  - ProviderNormalizer: happy path, missing fields, bad price, bad chains
  - CandidateMarker: each flag individually + mark_all
  - PlanEmitter: confidence, ranking, digest stability, empty providers
  - _assert_read_only: forbidden method raises PlanningForbiddenError

Integration tests (mock API + mock DB)
  - normalize_providers tool: returns structured result
  - plan_purchase tool: returns canonical DryRunPlan with digest
  - plan_purchase with price cap filter
  - plan_purchase with no eligible providers
  - plan_purchase: no wallet / approval / job mutation calls ever made
  - plan_purchase: deterministic digest (same inputs → same digest)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.tools.planning import (
    CANONICAL_CURRENCY,
    MAX_PRICE_USDC,
    CandidateMarker,
    PlanEmitter,
    PlanningForbiddenError,
    ProviderNormalized,
    ProviderNormalizer,
    _assert_read_only,
    normalize_providers,
    plan_purchase,
)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


def _make_raw_service(**overrides) -> dict:
    """Return a valid raw service dict, optionally overriding fields."""
    base = {
        "talosId": "talos-abc123",
        "talosName": "AlphaBot",
        "talosCategory": "Analytics",
        "serviceName": "Market Analysis",
        "description": "Deep market insights",
        "price": 5.0,
        "currency": "USDC",
        "chains": ["stellar"],
    }
    base.update(overrides)
    return base


def _make_provider(**overrides) -> ProviderNormalized:
    """Return a valid, eligible ProviderNormalized (all flags False)."""
    p = ProviderNormalizer().normalize(_make_raw_service(**overrides))
    return p


# ---------------------------------------------------------------------------
# ProviderNormalizer — unit tests
# ---------------------------------------------------------------------------


class TestProviderNormalizerHappyPath:
    def test_identity_fields_are_stripped(self):
        raw = _make_raw_service(talosId="  talos-1  ", talosName="  Bot  ")
        p = ProviderNormalizer().normalize(raw)
        assert p.talos_id == "talos-1"
        assert p.talos_name == "Bot"

    def test_price_float_conversion(self):
        p = ProviderNormalizer().normalize(_make_raw_service(price="3.50"))
        assert p.price_usdc == 3.50

    def test_price_valid_within_bounds(self):
        p = ProviderNormalizer().normalize(_make_raw_service(price=1.0))
        assert p.price_valid is True

    def test_currency_uppercased(self):
        p = ProviderNormalizer().normalize(_make_raw_service(currency="usdc"))
        assert p.currency == "USDC"

    def test_chains_lowercased_list(self):
        p = ProviderNormalizer().normalize(_make_raw_service(chains=["Stellar", "EVM"]))
        assert "stellar" in p.chains
        assert "evm" in p.chains

    def test_chain_supported_true(self):
        p = ProviderNormalizer().normalize(_make_raw_service(chains=["stellar"]))
        assert p.chain_supported is True

    def test_schema_complete_true(self):
        p = ProviderNormalizer().normalize(_make_raw_service())
        assert p.schema_complete is True

    def test_normalize_many_skips_non_dicts(self):
        items = [_make_raw_service(), "not-a-dict", None, 42]
        result = ProviderNormalizer().normalize_many(items)  # type: ignore[arg-type]
        assert len(result) == 1

    def test_missing_chains_defaults_to_stellar(self):
        raw = _make_raw_service()
        del raw["chains"]
        p = ProviderNormalizer().normalize(raw)
        assert p.chains == ["stellar"]


class TestProviderNormalizerEdgeCases:
    def test_price_too_high_invalid(self):
        p = ProviderNormalizer().normalize(_make_raw_service(price=MAX_PRICE_USDC + 1))
        assert p.price_valid is False

    def test_price_zero_invalid(self):
        p = ProviderNormalizer().normalize(_make_raw_service(price=0))
        assert p.price_valid is False

    def test_price_non_numeric_becomes_zero(self):
        p = ProviderNormalizer().normalize(_make_raw_service(price="not-a-number"))
        assert p.price_usdc == 0.0
        assert p.price_valid is False

    def test_unsupported_chain_only(self):
        p = ProviderNormalizer().normalize(_make_raw_service(chains=["evm"]))
        assert p.chain_supported is False

    def test_schema_incomplete_missing_required_key(self):
        raw = _make_raw_service()
        del raw["serviceName"]
        p = ProviderNormalizer().normalize(raw)
        assert p.schema_complete is False

    def test_schema_incomplete_empty_talos_id(self):
        p = ProviderNormalizer().normalize(_make_raw_service(talosId=""))
        assert p.schema_complete is False


# ---------------------------------------------------------------------------
# CandidateMarker — unit tests
# ---------------------------------------------------------------------------


class TestCandidateMarkerStale:
    def test_marks_stale_for_bad_price(self):
        p = _make_provider(price=MAX_PRICE_USDC + 1)
        CandidateMarker().mark_stale(p)
        assert p.is_stale is True
        assert any("price_out_of_bounds" in e for e in p.evidence)

    def test_marks_stale_for_wrong_currency(self):
        p = _make_provider(currency="EUR")
        # normalizer uppercases currency; marker checks against CANONICAL_CURRENCY
        CandidateMarker().mark_stale(p)
        assert p.is_stale is True
        assert any("non_canonical_currency" in e for e in p.evidence)

    def test_marks_stale_for_unsupported_chain(self):
        p = _make_provider(chains=["evm"])
        CandidateMarker().mark_stale(p)
        assert p.is_stale is True
        assert any("unsupported_chains" in e for e in p.evidence)

    def test_valid_provider_not_stale(self):
        p = _make_provider()
        CandidateMarker().mark_stale(p)
        assert p.is_stale is False
        assert p.evidence == []


class TestCandidateMarkerIncomplete:
    def test_marks_incomplete_when_schema_incomplete(self):
        raw = _make_raw_service()
        del raw["serviceName"]
        p = ProviderNormalizer().normalize(raw)
        CandidateMarker().mark_incomplete(p)
        assert p.is_incomplete is True

    def test_marks_incomplete_for_empty_talos_id(self):
        raw = _make_raw_service(talosId="")
        p = ProviderNormalizer().normalize(raw)
        CandidateMarker().mark_incomplete(p)
        assert p.is_incomplete is True

    def test_complete_provider_not_flagged(self):
        p = _make_provider()
        CandidateMarker().mark_incomplete(p)
        assert p.is_incomplete is False


class TestCandidateMarkerUnverified:
    def test_marks_unverified_bad_talos_id(self):
        p = _make_provider()
        p.talos_id = "bad id with spaces"
        CandidateMarker().mark_unverified(p)
        assert p.is_unverified is True

    def test_marks_unverified_empty_talos_name(self):
        p = _make_provider()
        p.talos_name = ""
        CandidateMarker().mark_unverified(p)
        assert p.is_unverified is True

    def test_valid_identity_not_unverified(self):
        p = _make_provider()
        CandidateMarker().mark_unverified(p)
        assert p.is_unverified is False


class TestCandidateMarkerPolicyIneligible:
    def test_marks_ineligible_when_budget_exhausted(self):
        p = _make_provider(price=1.0)
        marker = CandidateMarker(gtm_budget=100.0, spent_this_period=100.0)
        marker.mark_policy_ineligible(p)
        assert p.is_policy_ineligible is True
        assert any("budget_exhausted" in e for e in p.evidence)

    def test_marks_ineligible_when_price_exceeds_remaining(self):
        p = _make_provider(price=50.0)
        marker = CandidateMarker(gtm_budget=100.0, spent_this_period=80.0)
        marker.mark_policy_ineligible(p)
        assert p.is_policy_ineligible is True
        assert any("insufficient_budget" in e for e in p.evidence)

    def test_marks_ineligible_when_price_above_approval_threshold(self):
        p = _make_provider(price=15.0)
        marker = CandidateMarker(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        marker.mark_policy_ineligible(p)
        assert p.is_policy_ineligible is True
        assert any("requires_approval" in e for e in p.evidence)

    def test_eligible_when_within_policy(self):
        p = _make_provider(price=5.0)
        marker = CandidateMarker(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        marker.mark_policy_ineligible(p)
        assert p.is_policy_ineligible is False

    def test_mark_all_runs_all_checks(self):
        raw_bad = _make_raw_service(price=MAX_PRICE_USDC + 1)
        p = ProviderNormalizer().normalize(raw_bad)
        marker = CandidateMarker()
        marker.mark_all([p])
        # stale from bad price
        assert p.is_stale is True

    def test_is_eligible_returns_false_if_any_flag_set(self):
        p = _make_provider()
        p.is_stale = True
        assert p.is_eligible() is False

    def test_is_eligible_returns_true_when_no_flags(self):
        p = _make_provider()
        assert p.is_eligible() is True


# ---------------------------------------------------------------------------
# PlanEmitter — unit tests
# ---------------------------------------------------------------------------


class TestPlanEmitterConfidence:
    def test_zero_confidence_when_no_providers(self):
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0)
        plan = emitter.build([])
        assert plan.confidence == 0.0

    def test_full_confidence_single_valid_provider(self):
        p = _make_provider(price=5.0)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([p])
        assert plan.confidence == 1.0

    def test_partial_confidence_some_ineligible(self):
        good = _make_provider(price=5.0)
        bad = _make_provider(price=MAX_PRICE_USDC + 1)
        CandidateMarker().mark_all([good, bad])
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([good, bad])
        assert 0.0 < plan.confidence < 1.0


class TestPlanEmitterRanking:
    def test_cheapest_eligible_ranked_first_without_target(self):
        cheap = _make_provider(price=2.0)
        expensive = _make_provider(price=9.0)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([expensive, cheap])
        assert plan.eligible_providers[0]["price_usdc"] == 2.0

    def test_target_service_match_ranks_first(self):
        p_match = _make_provider(price=8.0)
        p_match.service_name = "Deep Market Analysis"
        p_cheap = _make_provider(price=2.0)
        p_cheap.service_name = "SEO Audit"
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([p_cheap, p_match], target_service="market analysis")
        assert plan.eligible_providers[0]["service_name"] == "Deep Market Analysis"

    def test_estimated_cost_is_cheapest(self):
        p1 = _make_provider(price=3.0)
        p2 = _make_provider(price=7.0)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([p1, p2])
        assert plan.estimated_cost_usdc == 3.0

    def test_estimated_cost_zero_when_no_eligible(self):
        p = _make_provider(price=MAX_PRICE_USDC + 1)
        CandidateMarker().mark_all([p])
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0)
        plan = emitter.build([p])
        assert plan.estimated_cost_usdc == 0.0


class TestPlanEmitterDigest:
    def test_digest_is_sha256_hex_64_chars(self):
        p = _make_provider()
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([p])
        assert len(plan.plan_digest) == 64
        int(plan.plan_digest, 16)  # must be valid hex

    def test_same_inputs_produce_same_digest(self):
        p1 = _make_provider(price=5.0)
        p2 = _make_provider(price=5.0)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan_a = emitter.build([p1])
        plan_b = emitter.build([p2])
        assert plan_a.plan_digest == plan_b.plan_digest

    def test_different_price_produces_different_digest(self):
        p_cheap = _make_provider(price=1.0)
        p_expensive = _make_provider(price=9.0)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan_a = emitter.build([p_cheap])
        plan_b = emitter.build([p_expensive])
        assert plan_a.plan_digest != plan_b.plan_digest


class TestPlanEmitterAssumptions:
    def test_assumptions_include_dry_run_disclaimer(self):
        emitter = PlanEmitter()
        plan = emitter.build([])
        assert any("DRY-RUN" in a for a in plan.assumptions)

    def test_assumptions_include_canonical_currency(self):
        emitter = PlanEmitter()
        plan = emitter.build([])
        assert any(CANONICAL_CURRENCY in a for a in plan.assumptions)

    def test_assumptions_include_no_eligible_message_when_empty(self):
        emitter = PlanEmitter()
        plan = emitter.build([])
        assert any("No eligible providers" in a for a in plan.assumptions)

    def test_assumptions_include_cheapest_when_eligible(self):
        p = _make_provider(price=4.5)
        emitter = PlanEmitter(gtm_budget=200.0, spent_this_period=0.0, approval_threshold=10.0)
        plan = emitter.build([p])
        assert any("4.5" in a for a in plan.assumptions)

    def test_budget_headroom_correct(self):
        p = _make_provider(price=5.0)
        emitter = PlanEmitter(gtm_budget=100.0, spent_this_period=30.0, approval_threshold=10.0)
        plan = emitter.build([p])
        assert plan.budget_headroom_usdc == 70.0


# ---------------------------------------------------------------------------
# _assert_read_only — forbidden guard tests
# ---------------------------------------------------------------------------


class TestAssertReadOnly:
    @pytest.mark.parametrize("forbidden", [
        "sign_payment",
        "create_approval",
        "claim_job",
        "submit_job_result",
        "submit_commerce",
        "heartbeat_job",
        "release_job",
        "request_transfer",
        "get_agent_wallet",
        "create_agent_wallet",
        "register_service",
    ])
    def test_forbidden_methods_raise(self, forbidden: str):
        with pytest.raises(PlanningForbiddenError, match=forbidden):
            _assert_read_only(forbidden)

    def test_allowed_method_does_not_raise(self):
        # These are read-only; they must NOT raise
        _assert_read_only("discover_services")
        _assert_read_only("get_talos")
        _assert_read_only("get_pending_activities")


# ---------------------------------------------------------------------------
# Integration tests — @tool functions with mocked API + DB
# ---------------------------------------------------------------------------


def _mock_api_with_services(services: list[dict]) -> MagicMock:
    api = MagicMock()
    api.discover_services = AsyncMock(return_value=services)
    # Ensure forbidden methods exist on the mock but are NOT called
    for forbidden in [
        "sign_payment", "create_approval", "claim_job", "submit_job_result",
        "submit_commerce", "heartbeat_job", "release_job", "request_transfer",
        "get_agent_wallet", "create_agent_wallet", "register_service",
    ]:
        setattr(api, forbidden, AsyncMock())
    return api


def _mock_db(gtm_budget: float = 200.0, spent: float = 0.0) -> MagicMock:
    db = MagicMock()
    db.get_talos_config.return_value = {"gtmBudget": str(gtm_budget)}
    db.get_spending_period.return_value = spent
    return db


def _mock_settings(approval_threshold: float = 10.0) -> MagicMock:
    s = MagicMock()
    s.approval_threshold = str(approval_threshold)
    return s


SAMPLE_SERVICES = [
    _make_raw_service(talosId="talos-1", talosName="Bot1", price=3.0),
    _make_raw_service(talosId="talos-2", talosName="Bot2", price=7.0),
]


@pytest.mark.asyncio
class TestNormalizeProvidersTool:
    async def test_returns_dict_with_providers_key(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            result = await normalize_providers()
        assert "providers" in result
        assert "total_count" in result

    async def test_total_count_matches_service_list(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            result = await normalize_providers()
        assert result["total_count"] == 2

    async def test_eligible_count_excludes_policy_blocked(self):
        # Price 15 > approval_threshold 10 → policy-ineligible
        services = [_make_raw_service(price=15.0)]
        api = _mock_api_with_services(services)
        db = _mock_db()
        settings = _mock_settings(approval_threshold=10.0)
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            result = await normalize_providers()
        assert result["eligible_count"] == 0

    async def test_no_forbidden_calls_on_api(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            await normalize_providers()
        # Forbidden methods must NEVER have been called
        api.sign_payment.assert_not_called()
        api.create_approval.assert_not_called()
        api.claim_job.assert_not_called()
        api.submit_job_result.assert_not_called()
        api.submit_commerce.assert_not_called()
        api.request_transfer.assert_not_called()
        api.get_agent_wallet.assert_not_called()
        api.create_agent_wallet.assert_not_called()
        api.register_service.assert_not_called()

    async def test_handles_empty_service_list(self):
        api = _mock_api_with_services([])
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            result = await normalize_providers()
        assert result["total_count"] == 0
        assert result["eligible_count"] == 0


@pytest.mark.asyncio
class TestPlanPurchaseTool:
    async def test_returns_plan_dict_with_required_keys(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        for key in (
            "eligible_providers", "all_providers", "assumptions",
            "confidence", "estimated_cost_usdc", "gtm_budget_usdc",
            "spent_this_period_usdc", "budget_headroom_usdc",
            "plan_digest", "planned_at",
        ):
            assert key in plan, f"Missing key: {key}"

    async def test_plan_digest_is_hex_string(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert isinstance(plan["plan_digest"], str)
        assert len(plan["plan_digest"]) == 64
        int(plan["plan_digest"], 16)

    async def test_cheapest_provider_ranked_first(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)  # prices 3.0 and 7.0
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert plan["eligible_providers"][0]["price_usdc"] == 3.0

    async def test_price_cap_excludes_over_cap(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)  # prices 3.0 and 7.0
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase(max_price_usdc=5.0)
        prices = [p["price_usdc"] for p in plan["eligible_providers"]]
        assert all(pr <= 5.0 for pr in prices)

    async def test_no_eligible_providers_plan(self):
        # All services priced above approval threshold
        expensive = [_make_raw_service(price=50.0)]
        api = _mock_api_with_services(expensive)
        db = _mock_db()
        settings = _mock_settings(approval_threshold=10.0)
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert plan["eligible_providers"] == []
        assert plan["estimated_cost_usdc"] == 0.0
        assert any("No eligible providers" in a for a in plan["assumptions"])

    async def test_no_forbidden_calls_on_api(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            await plan_purchase(target_service="analysis")
        api.sign_payment.assert_not_called()
        api.create_approval.assert_not_called()
        api.claim_job.assert_not_called()
        api.submit_job_result.assert_not_called()
        api.submit_commerce.assert_not_called()
        api.heartbeat_job.assert_not_called()
        api.release_job.assert_not_called()
        api.request_transfer.assert_not_called()
        api.get_agent_wallet.assert_not_called()
        api.create_agent_wallet.assert_not_called()
        api.register_service.assert_not_called()

    async def test_deterministic_digest_same_inputs(self):
        api1 = _mock_api_with_services(SAMPLE_SERVICES)
        api2 = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api1), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan_a = await plan_purchase()
        with patch("talos_agent.tools.planning._api", api2), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan_b = await plan_purchase()
        assert plan_a["plan_digest"] == plan_b["plan_digest"]

    async def test_different_prices_yield_different_digest(self):
        services_a = [_make_raw_service(price=3.0)]
        services_b = [_make_raw_service(price=6.0)]
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", _mock_api_with_services(services_a)), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan_a = await plan_purchase()
        with patch("talos_agent.tools.planning._api", _mock_api_with_services(services_b)), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan_b = await plan_purchase()
        assert plan_a["plan_digest"] != plan_b["plan_digest"]

    async def test_target_service_ranking_applied(self):
        services = [
            _make_raw_service(talosId="t1", serviceName="Deep Market Analysis", price=8.0),
            _make_raw_service(talosId="t2", serviceName="SEO Audit", price=2.0),
        ]
        api = _mock_api_with_services(services)
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase(target_service="market analysis")
        assert plan["eligible_providers"][0]["service_name"] == "Deep Market Analysis"

    async def test_budget_context_reflected_in_plan(self):
        api = _mock_api_with_services(SAMPLE_SERVICES)
        db = _mock_db(gtm_budget=150.0, spent=40.0)
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert plan["gtm_budget_usdc"] == 150.0
        assert plan["spent_this_period_usdc"] == 40.0
        assert plan["budget_headroom_usdc"] == 110.0

    async def test_api_none_returns_gracefully(self):
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", None), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert plan["eligible_providers"] == []
        assert plan["all_providers"] == []

    async def test_assumptions_contain_dry_run_disclaimer(self):
        api = _mock_api_with_services([])
        db = _mock_db()
        settings = _mock_settings()
        with patch("talos_agent.tools.planning._api", api), \
             patch("talos_agent.tools.planning._db", db), \
             patch("talos_agent.tools.planning._settings", settings):
            plan = await plan_purchase()
        assert any("DRY-RUN" in a for a in plan["assumptions"])
        assert any("sign_payment" in a or "wallet" in a.lower() or "DRY-RUN" in a
                   for a in plan["assumptions"])
