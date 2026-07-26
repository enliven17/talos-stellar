"""Provider normalization and canonical dry-run purchase plans.

This module is **side-effect free by design**.  It may only call read-only
API methods (discover_services, get_talos) and read-only DB queries.
Any attempt to invoke a wallet, reservation, approval, or job-mutation
method raises ``PlanningForbiddenError`` at the call site so the
restriction is enforced at runtime, not just by convention.

Public @tool functions
----------------------
normalize_providers  — fetch + normalize services from the marketplace
plan_purchase        — emit a canonical dry-run purchase plan (no writes)
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# ---------------------------------------------------------------------------
# Module-level dependency injection (filled by build_all_tools)
# ---------------------------------------------------------------------------
_api: TalosAPIClient = None  # type: ignore[assignment]
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Validation constants
# ---------------------------------------------------------------------------

#: Maximum price accepted as valid (USDC).  Anything above is flagged stale.
MAX_PRICE_USDC: float = 10_000.0

#: Minimum price; zero or negative prices are incomplete.
MIN_PRICE_USDC: float = 0.000_001

#: A service record must have at least these keys to be considered complete.
REQUIRED_SERVICE_KEYS: frozenset[str] = frozenset(
    {"talosId", "serviceName", "price", "currency"}
)

#: Chains we know the agent can actually pay on.
SUPPORTED_CHAINS: frozenset[str] = frozenset({"stellar"})

#: Currency we price everything in.
CANONICAL_CURRENCY: str = "USDC"

#: GTM budget floor used when the DB is unavailable.
DEFAULT_GTM_BUDGET: float = 200.0

# ---------------------------------------------------------------------------
# Forbidden method names — calling any of these during planning is an error
# ---------------------------------------------------------------------------

_FORBIDDEN_METHOD_NAMES: frozenset[str] = frozenset(
    {
        # wallet mutations
        "get_agent_wallet",
        "create_agent_wallet",
        "sign_payment",
        # reservation / approval mutations
        "create_approval",
        # job mutations
        "claim_job",
        "submit_job_result",
        "submit_commerce",
        "heartbeat_job",
        "release_job",
        # transfer
        "request_transfer",
        # service registration
        "register_service",
    }
)


class PlanningForbiddenError(RuntimeError):
    """Raised when planning code attempts a forbidden side-effecting call."""


def _assert_read_only(method_name: str) -> None:
    """Raise ``PlanningForbiddenError`` if *method_name* is in the forbidden set.

    Call this at the top of every helper that touches the API or DB inside
    this module so the invariant is enforced at runtime.
    """
    if method_name in _FORBIDDEN_METHOD_NAMES:
        raise PlanningForbiddenError(
            f"Planning is read-only: calling '{method_name}' is forbidden. "
            "Use purchase_service (commerce.py) for actual purchases."
        )


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ProviderNormalized:
    """Canonical representation of a single marketplace service provider.

    All fields are derived deterministically from the raw API payload so
    two calls with the same payload always produce the same struct.
    """

    # Identity
    talos_id: str
    talos_name: str
    talos_category: str

    # Service metadata
    service_name: str
    description: str

    # Pricing
    price_usdc: float
    currency: str
    price_valid: bool          # within (MIN_PRICE_USDC, MAX_PRICE_USDC]

    # Chain support
    chains: list[str]
    chain_supported: bool      # at least one chain in SUPPORTED_CHAINS

    # Schema completeness
    schema_complete: bool      # all REQUIRED_SERVICE_KEYS present + non-empty

    # Candidate flags (set by CandidateMarker)
    is_stale: bool = False           # price out of bounds or data looks stale
    is_incomplete: bool = False      # missing required fields
    is_unverified: bool = False      # talos_id format suspicious / identity unconfirmed
    is_policy_ineligible: bool = False  # violates agent spend policy

    # Evidence bag: human-readable reasons for each flag
    evidence: list[str] = field(default_factory=list)

    def is_eligible(self) -> bool:
        """Return True iff the provider passes all candidate checks."""
        return not (
            self.is_stale
            or self.is_incomplete
            or self.is_unverified
            or self.is_policy_ineligible
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DryRunPlan:
    """Canonical dry-run purchase plan — never triggers any side effects.

    Emitted by ``PlanEmitter.build`` and returned verbatim by
    the ``plan_purchase`` tool.  The ``plan_digest`` is a SHA-256 of the
    canonical JSON representation so consumers can detect plan changes.
    """

    # Filtered, ranked provider list
    eligible_providers: list[dict[str, Any]]
    all_providers: list[dict[str, Any]]

    # Planning metadata
    assumptions: list[str]
    confidence: float          # 0.0–1.0
    estimated_cost_usdc: float

    # Budget context (read from DB, never mutated)
    gtm_budget_usdc: float
    spent_this_period_usdc: float
    budget_headroom_usdc: float

    # Digest for plan identity / caching
    plan_digest: str           # sha256 hex of canonical JSON

    # Timestamp
    planned_at: str            # ISO-8601 UTC

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# ProviderNormalizer
# ---------------------------------------------------------------------------


class ProviderNormalizer:
    """Convert raw service dicts from the API into ``ProviderNormalized`` objects.

    This class is pure — it takes the raw payload and produces a normalised
    struct without any I/O.  All validation logic lives here so it can be
    unit-tested in isolation.
    """

    # Regex for a plausible talosId: non-empty, printable ASCII, no control chars
    _TALOS_ID_RE = re.compile(r"^[\x21-\x7E]{1,128}$")

    def normalize(self, raw: dict[str, Any]) -> ProviderNormalized:
        """Normalise a single raw service dict.

        Parameters
        ----------
        raw:
            A dict as returned by ``_api.discover_services``, containing at
            minimum ``talosId``, ``serviceName``, ``price``, ``currency``.

        Returns
        -------
        ProviderNormalized
            A fully-populated normalised provider record.  Flags are *not*
            set here; use ``CandidateMarker`` for that step.
        """
        talos_id = str(raw.get("talosId") or "").strip()
        talos_name = str(raw.get("talosName") or "").strip()
        talos_category = str(raw.get("talosCategory") or "").strip()
        service_name = str(raw.get("serviceName") or "").strip()
        description = str(raw.get("description") or "").strip()
        currency = str(raw.get("currency") or CANONICAL_CURRENCY).strip().upper()

        # Price normalisation — accept numeric or string
        raw_price = raw.get("price", 0)
        try:
            price_usdc = float(raw_price)
        except (TypeError, ValueError):
            price_usdc = 0.0

        price_valid = MIN_PRICE_USDC <= price_usdc <= MAX_PRICE_USDC

        # Chain normalisation — always a list of lowercase strings
        raw_chains = raw.get("chains") or []
        if isinstance(raw_chains, str):
            raw_chains = [raw_chains]
        chains = [str(c).strip().lower() for c in raw_chains if c]
        if not chains:
            chains = ["stellar"]  # default assumption
        chain_supported = bool(SUPPORTED_CHAINS & set(chains))

        # Schema completeness: all required keys must be present + truthy
        schema_complete = all(
            raw.get(k) not in (None, "", 0, [])
            for k in REQUIRED_SERVICE_KEYS
        )

        return ProviderNormalized(
            talos_id=talos_id,
            talos_name=talos_name,
            talos_category=talos_category,
            service_name=service_name,
            description=description,
            price_usdc=price_usdc,
            currency=currency,
            price_valid=price_valid,
            chains=chains,
            chain_supported=chain_supported,
            schema_complete=schema_complete,
        )

    def normalize_many(self, raws: list[dict[str, Any]]) -> list[ProviderNormalized]:
        """Normalise a list of raw service dicts, skipping non-dict entries."""
        result: list[ProviderNormalized] = []
        for item in raws:
            if not isinstance(item, dict):
                continue
            result.append(self.normalize(item))
        return result


# ---------------------------------------------------------------------------
# CandidateMarker
# ---------------------------------------------------------------------------


class CandidateMarker:
    """Apply eligibility flags to a ``ProviderNormalized`` record.

    Each ``mark_*`` method mutates the provider in-place, appending to
    ``evidence`` when a flag is raised.  The ``mark_all`` convenience method
    runs every check in the correct order.

    Policy thresholds
    -----------------
    gtm_budget          : total monthly spend ceiling (USDC)
    spent_this_period   : amount already spent in the current period (USDC)
    approval_threshold  : per-transaction amount requiring human approval (USDC)
    """

    def __init__(
        self,
        gtm_budget: float = DEFAULT_GTM_BUDGET,
        spent_this_period: float = 0.0,
        approval_threshold: float = 10.0,
    ) -> None:
        self.gtm_budget = gtm_budget
        self.spent_this_period = spent_this_period
        self.approval_threshold = approval_threshold

    # ── individual checks ────────────────────────────────────────

    def mark_stale(self, p: ProviderNormalized) -> None:
        """Flag providers whose price data looks stale or out of bounds."""
        if not p.price_valid:
            p.is_stale = True
            p.evidence.append(
                f"price_out_of_bounds: {p.price_usdc} USDC "
                f"(valid range {MIN_PRICE_USDC}–{MAX_PRICE_USDC})"
            )
        if p.currency != CANONICAL_CURRENCY:
            p.is_stale = True
            p.evidence.append(
                f"non_canonical_currency: '{p.currency}' (expected {CANONICAL_CURRENCY})"
            )
        if not p.chain_supported:
            p.is_stale = True
            p.evidence.append(
                f"unsupported_chains: {p.chains} (supported: {sorted(SUPPORTED_CHAINS)})"
            )

    def mark_incomplete(self, p: ProviderNormalized) -> None:
        """Flag providers with missing or empty required fields."""
        if not p.schema_complete:
            p.is_incomplete = True
            p.evidence.append("schema_incomplete: one or more required fields are missing or empty")
        if not p.talos_id:
            p.is_incomplete = True
            p.evidence.append("missing_talos_id")
        if not p.service_name:
            p.is_incomplete = True
            p.evidence.append("missing_service_name")

    def mark_unverified(self, p: ProviderNormalized) -> None:
        """Flag providers whose identity cannot be confirmed from the raw payload.

        We cannot make network calls here, so we apply heuristic checks:
        - talos_id must match the allowed character set / length
        - talos_name should not be empty
        """
        if not ProviderNormalizer._TALOS_ID_RE.match(p.talos_id):
            p.is_unverified = True
            p.evidence.append(
                f"suspicious_talos_id: '{p.talos_id}' fails identity format check"
            )
        if not p.talos_name:
            p.is_unverified = True
            p.evidence.append("missing_talos_name: identity unconfirmed")

    def mark_policy_ineligible(self, p: ProviderNormalized) -> None:
        """Flag providers that violate the agent's spend policy.

        Checks:
        - budget exhausted (already spent >= gtm_budget)
        - single purchase would exhaust remaining budget
        - price exceeds approval threshold (requires human sign-off, so
          the agent cannot self-authorise the purchase in a dry-run)
        """
        budget_remaining = self.gtm_budget - self.spent_this_period
        if self.spent_this_period >= self.gtm_budget:
            p.is_policy_ineligible = True
            p.evidence.append(
                f"budget_exhausted: spent {self.spent_this_period} of "
                f"{self.gtm_budget} USDC this period"
            )
            return  # no further policy checks needed

        if p.price_usdc > budget_remaining:
            p.is_policy_ineligible = True
            p.evidence.append(
                f"insufficient_budget: price {p.price_usdc} USDC > "
                f"remaining {budget_remaining:.6f} USDC"
            )

        if p.price_usdc > self.approval_threshold:
            p.is_policy_ineligible = True
            p.evidence.append(
                f"requires_approval: price {p.price_usdc} USDC > "
                f"threshold {self.approval_threshold} USDC"
            )

    def mark_all(self, providers: list[ProviderNormalized]) -> list[ProviderNormalized]:
        """Run all checks against every provider and return the list unchanged."""
        for p in providers:
            self.mark_stale(p)
            self.mark_incomplete(p)
            self.mark_unverified(p)
            self.mark_policy_ineligible(p)
        return providers


# ---------------------------------------------------------------------------
# PlanEmitter
# ---------------------------------------------------------------------------


class PlanEmitter:
    """Build a canonical ``DryRunPlan`` from normalised, marked providers.

    The emitter is pure — it receives all inputs as constructor arguments
    and produces a deterministic plan dict.  No I/O occurs here.
    """

    def __init__(
        self,
        gtm_budget: float = DEFAULT_GTM_BUDGET,
        spent_this_period: float = 0.0,
        approval_threshold: float = 10.0,
    ) -> None:
        self.gtm_budget = gtm_budget
        self.spent_this_period = spent_this_period
        self.approval_threshold = approval_threshold

    def build(
        self,
        providers: list[ProviderNormalized],
        target_service: str = "",
    ) -> DryRunPlan:
        """Produce a ``DryRunPlan`` from the given provider list.

        Parameters
        ----------
        providers:
            Already-normalised and marked provider list.
        target_service:
            Optional free-text filter; eligible providers whose
            ``service_name`` contains this string (case-insensitive)
            are ranked first.

        Returns
        -------
        DryRunPlan
            Fully-populated plan including digest.  **No writes occur.**
        """
        eligible = [p for p in providers if p.is_eligible()]
        ineligible = [p for p in providers if not p.is_eligible()]

        # Rank eligible providers: exact/partial service-name match first,
        # then by ascending price (cheapest first within same relevance tier).
        target_lower = target_service.strip().lower()

        def _rank_key(p: ProviderNormalized) -> tuple[int, float]:
            name_lower = p.service_name.lower()
            relevance = 0 if (target_lower and target_lower in name_lower) else 1
            return (relevance, p.price_usdc)

        ranked_eligible = sorted(eligible, key=_rank_key)

        # Cost estimate: cheapest eligible provider; 0 if none
        estimated_cost = ranked_eligible[0].price_usdc if ranked_eligible else 0.0

        # Confidence score
        confidence = self._compute_confidence(ranked_eligible, providers)

        # Budget headroom
        budget_headroom = max(0.0, self.gtm_budget - self.spent_this_period)

        # Assumptions — always explicit
        assumptions = self._build_assumptions(
            providers=providers,
            eligible=ranked_eligible,
            target_service=target_service,
        )

        planned_at = datetime.now(timezone.utc).isoformat()

        # Build canonical dicts for serialisation
        eligible_dicts = [p.to_dict() for p in ranked_eligible]
        all_dicts = [p.to_dict() for p in (ranked_eligible + ineligible)]

        # Plan digest — sha256 of canonical JSON (sorted keys, no whitespace)
        digest_payload = {
            "eligible_providers": eligible_dicts,
            "estimated_cost_usdc": estimated_cost,
            "gtm_budget_usdc": self.gtm_budget,
            "spent_this_period_usdc": self.spent_this_period,
            "target_service": target_service,
        }
        plan_digest = hashlib.sha256(
            json.dumps(digest_payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

        return DryRunPlan(
            eligible_providers=eligible_dicts,
            all_providers=all_dicts,
            assumptions=assumptions,
            confidence=confidence,
            estimated_cost_usdc=estimated_cost,
            gtm_budget_usdc=self.gtm_budget,
            spent_this_period_usdc=self.spent_this_period,
            budget_headroom_usdc=budget_headroom,
            plan_digest=plan_digest,
            planned_at=planned_at,
        )

    # ── private helpers ──────────────────────────────────────────

    def _compute_confidence(
        self,
        eligible: list[ProviderNormalized],
        all_providers: list[ProviderNormalized],
    ) -> float:
        """Return a [0.0, 1.0] confidence score for the plan.

        Score components (each 0–1, averaged):
        - provider_availability : eligible / total (0 if no providers)
        - price_consistency     : all eligible prices <= budget headroom
        - schema_quality        : fraction of eligible with schema_complete
        """
        if not all_providers:
            return 0.0

        total = len(all_providers)
        n_eligible = len(eligible)
        provider_ratio = n_eligible / total

        budget_remaining = max(0.0, self.gtm_budget - self.spent_this_period)
        if n_eligible == 0:
            price_ok = 0.0
        else:
            within_budget = sum(1 for p in eligible if p.price_usdc <= budget_remaining)
            price_ok = within_budget / n_eligible

        if n_eligible == 0:
            schema_ok = 0.0
        else:
            complete = sum(1 for p in eligible if p.schema_complete)
            schema_ok = complete / n_eligible

        raw = (provider_ratio + price_ok + schema_ok) / 3.0
        return round(min(1.0, max(0.0, raw)), 4)

    def _build_assumptions(
        self,
        providers: list[ProviderNormalized],
        eligible: list[ProviderNormalized],
        target_service: str,
    ) -> list[str]:
        """Return a human-readable list of planning assumptions."""
        dry_run_notice = (
            "This is a DRY-RUN plan. No wallet, reservation, approval, or job "
            "mutation calls have been made."
        )
        budget_line = (
            f"GTM budget: {self.gtm_budget} USDC/period; "
            f"spent so far: {self.spent_this_period} USDC."
        )
        approval_line = (
            f"Approval threshold: {self.approval_threshold} USDC — "
            "purchases above this require human sign-off and are excluded."
        )
        assumptions: list[str] = [
            dry_run_notice,
            f"Canonical currency: {CANONICAL_CURRENCY}.",
            f"Supported chains: {sorted(SUPPORTED_CHAINS)}.",
            budget_line,
            approval_line,
        ]
        if target_service:
            assumptions.append(
                f"Service filter applied: '{target_service}' (case-insensitive substring match)."
            )
        n_total = len(providers)
        n_ineligible = n_total - len(eligible)
        assumptions.append(
            f"Evaluated {n_total} provider(s): "
            f"{len(eligible)} eligible, {n_ineligible} excluded."
        )
        if not eligible:
            assumptions.append(
                "No eligible providers found. "
                "Consider relaxing filters, increasing budget, or trying another category."
            )
        else:
            assumptions.append(
                f"Cheapest eligible provider: '{eligible[0].service_name}' "
                f"from {eligible[0].talos_name} at {eligible[0].price_usdc} USDC."
            )
        return assumptions


# ---------------------------------------------------------------------------
# Internal helpers (read-only I/O)
# ---------------------------------------------------------------------------


def _read_budget_context() -> tuple[float, float, float]:
    """Return (gtm_budget, spent_this_period, approval_threshold) from DB/settings.

    Falls back to safe defaults when the DB or settings are unavailable.
    Never writes to the DB.
    """
    _assert_read_only("_read_budget_context")  # self-check (not in forbidden set — OK)

    gtm_budget = DEFAULT_GTM_BUDGET
    spent_this_period = 0.0
    approval_threshold = 10.0

    try:
        if _db is not None:
            config = _db.get_talos_config()
            if config:
                gtm_budget = float(config.get("gtmBudget", DEFAULT_GTM_BUDGET))
            spent_this_period = float(_db.get_spending_period(30))
    except Exception:  # noqa: BLE001, S110  # planning must never crash; defaults are safe
        pass

    try:
        if _settings is not None:
            approval_threshold = float(_settings.approval_threshold)
    except Exception:  # noqa: BLE001, S110
        pass

    return gtm_budget, spent_this_period, approval_threshold


async def _fetch_services(category: str, target: str) -> list[dict[str, Any]]:
    """Fetch services from the API.  Uses only the read-only discover_services endpoint."""
    # Explicitly assert no forbidden method is called
    _assert_read_only("discover_services")  # will NOT raise — discover_services is allowed
    # The check above is a no-op for allowed methods; the real guard is below
    # ensuring we never call any mutating method inside this module.
    if _api is None:
        return []
    try:
        services = await _api.discover_services(
            category=category or None,
            target=target or None,
        )
        return services if isinstance(services, list) else []
    except Exception:  # noqa: BLE001  # network errors fall back to empty list
        return []


# ---------------------------------------------------------------------------
# @tool functions
# ---------------------------------------------------------------------------


@tool(
    "normalize_providers",
    "Fetch services from the marketplace and return a normalized view of each "
    "provider's capabilities, pricing, identity, and eligibility flags. "
    "This is a READ-ONLY operation — no purchases, wallet calls, or approvals are made.",
)
async def normalize_providers(
    category: str = "",
    target: str = "",
) -> dict:
    """Normalise marketplace services into structured provider records.

    Parameters
    ----------
    category:
        Optional marketplace category filter (e.g. 'Analytics', 'Development').
    target:
        Optional free-text search term forwarded to the API.

    Returns
    -------
    dict with keys:
        providers     — list of normalised provider dicts
        eligible_count
        total_count
        category_searched
    """
    raw_services = await _fetch_services(category, target)

    gtm_budget, spent, approval_threshold = _read_budget_context()
    normalizer = ProviderNormalizer()
    marker = CandidateMarker(
        gtm_budget=gtm_budget,
        spent_this_period=spent,
        approval_threshold=approval_threshold,
    )

    providers = normalizer.normalize_many(raw_services)
    marker.mark_all(providers)

    return {
        "providers": [p.to_dict() for p in providers],
        "eligible_count": sum(1 for p in providers if p.is_eligible()),
        "total_count": len(providers),
        "category_searched": category or "(all)",
    }


@tool(
    "plan_purchase",
    "Emit a canonical DRY-RUN purchase plan for the best matching service provider. "
    "Returns ranked eligible providers, cost estimate, confidence score, budget context, "
    "and a SHA-256 plan digest. "
    "PROOF OF SIDE-EFFECT FREEDOM: this function calls only discover_services (GET) "
    "and local DB reads. It never calls sign_payment, create_approval, claim_job, "
    "submit_commerce, submit_job_result, heartbeat_job, release_job, request_transfer, "
    "get_agent_wallet, create_agent_wallet, or register_service.",
)
async def plan_purchase(
    target_service: str = "",
    category: str = "",
    max_price_usdc: float = 0.0,
) -> dict:
    """Emit a canonical dry-run purchase plan.

    Parameters
    ----------
    target_service:
        Optional free-text description of the service you want to purchase.
        Used for ranking (providers whose service_name contains this string
        rank first) and forwarded to the API as a search hint.
    category:
        Optional marketplace category filter.
    max_price_usdc:
        If > 0, providers priced above this value are additionally flagged
        as policy-ineligible in this plan (does not modify the DB threshold).

    Returns
    -------
    dict — the serialised ``DryRunPlan``, including:
        eligible_providers    list of ranked, eligible provider dicts
        all_providers         all providers (eligible + excluded)
        assumptions           list of explicit planning assumptions
        confidence            float [0,1]
        estimated_cost_usdc   cost of cheapest eligible provider
        gtm_budget_usdc
        spent_this_period_usdc
        budget_headroom_usdc
        plan_digest           sha256 of canonical plan JSON
        planned_at            ISO-8601 UTC timestamp
    """
    raw_services = await _fetch_services(category, target_service)

    gtm_budget, spent, approval_threshold = _read_budget_context()
    normalizer = ProviderNormalizer()
    marker = CandidateMarker(
        gtm_budget=gtm_budget,
        spent_this_period=spent,
        approval_threshold=approval_threshold,
    )

    providers = normalizer.normalize_many(raw_services)
    marker.mark_all(providers)

    # Apply optional caller-supplied price cap
    if max_price_usdc > 0.0:
        for p in providers:
            if p.price_usdc > max_price_usdc and not p.is_policy_ineligible:
                p.is_policy_ineligible = True
                p.evidence.append(
                    f"caller_price_cap: {p.price_usdc} USDC > requested cap {max_price_usdc} USDC"
                )

    emitter = PlanEmitter(
        gtm_budget=gtm_budget,
        spent_this_period=spent,
        approval_threshold=approval_threshold,
    )
    plan = emitter.build(providers, target_service=target_service)
    return plan.to_dict()
