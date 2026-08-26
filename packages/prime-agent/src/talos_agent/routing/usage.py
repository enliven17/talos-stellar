"""Usage tracking and budget enforcement for provider calls.

The :class:`UsageTracker` records token and cost usage per provider,
enabling budget-aware routing and telemetry.  Usage data is kept
in-memory by default and can be augmented with a persistence callback.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Callable

from talos_agent.routing.provider import ProviderRegistry

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UsageRecord:
    """A single usage record for one provider call.

    Attributes
    ----------
    provider_name:
        The provider that served the request.
    model:
        The model used.
    prompt_tokens:
        Number of input/prompt tokens.
    completion_tokens:
        Number of output/completion tokens.
    total_tokens:
        Total token count (prompt + completion).
    cost_usd:
        Estimated cost in USD.
    timestamp:
        Unix timestamp of the call.
    success:
        Whether the call succeeded.
    """

    provider_name: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: Decimal
    timestamp: float
    success: bool = True


@dataclass(frozen=True)
class UsageSnapshot:
    """A point-in-time snapshot of aggregated usage.

    Attributes
    ----------
    provider_totals:
        Map of provider_name to aggregated stats.
    total_prompt_tokens:
        Total input tokens across all providers.
    total_completion_tokens:
        Total output tokens across all providers.
    total_cost_usd:
        Total estimated cost across all providers.
    record_count:
        Total number of individual usage records.
    """

    provider_totals: dict[str, dict[str, object]]
    total_prompt_tokens: int
    total_completion_tokens: int
    total_cost_usd: Decimal
    record_count: int


@dataclass
class BudgetConfig:
    """Budget limits for a single provider or globally.

    ``None`` means no limit for that dimension.
    """

    max_cost_usd: Decimal | None = None
    """Maximum total cost in USD."""

    max_total_tokens: int | None = None
    """Maximum total tokens (all calls summed)."""

    max_requests: int | None = None
    """Maximum number of requests."""

    window_seconds: float | None = None
    """Time window for the budget (``None`` = all-time)."""


class UsageTracker:
    """Tracks token and cost usage per provider.

    Records usage after each provider call and provides aggregated
    snapshots for telemetry and budget-aware routing.

    Usage
    -----
    >>> tracker = UsageTracker(registry)
    >>> await tracker.record("groq", "llama-3.3-70b", 100, 50)
    >>> snapshot = tracker.snapshot()
    >>> snapshot.total_cost_usd
    Decimal('0.000035')
    """

    def __init__(
        self,
        registry: ProviderRegistry,
        *,
        persist_callback: Callable[[UsageRecord], None] | None = None,
    ) -> None:
        self._registry = registry
        self._persist_callback = persist_callback
        self._records: list[UsageRecord] = []

    # ── Recording ─────────────────────────────────────────────────────────

    async def record(
        self,
        provider_name: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        success: bool = True,
    ) -> UsageRecord:
        """Record usage for a provider call and return the record.

        Parameters
        ----------
        provider_name:
            The provider that served the request.
        model:
            The model used.
        prompt_tokens:
            Number of input/prompt tokens.
        completion_tokens:
            Number of output/completion tokens.
        success:
            Whether the call succeeded.

        Returns
        -------
        UsageRecord
            The newly created usage record.
        """
        total_tokens = prompt_tokens + completion_tokens

        # Calculate cost
        try:
            cost = self._registry.get_cost_estimate(provider_name, prompt_tokens, completion_tokens)
        except KeyError:
            cost = Decimal("0")
            logger.debug("Cannot calculate cost for unknown provider '%s'", provider_name)

        record = UsageRecord(
            provider_name=provider_name,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            cost_usd=cost,
            timestamp=time.time(),
            success=success,
        )

        self._records.append(record)

        if self._persist_callback:
            try:
                self._persist_callback(record)
            except Exception:
                logger.exception("Usage persistence callback failed for %s/%s", provider_name, model)

        return record

    # ── Aggregation ───────────────────────────────────────────────────────

    def snapshot(self, window_seconds: float | None = None) -> UsageSnapshot:
        """Return a point-in-time usage snapshot.

        Parameters
        ----------
        window_seconds:
            If set, only include records within the last N seconds.
            ``None`` includes all records.

        Returns
        -------
        UsageSnapshot
            Aggregated usage data.
        """
        records = self._records
        if window_seconds is not None:
            cutoff = time.time() - window_seconds
            records = [r for r in records if r.timestamp >= cutoff]

        provider_totals: dict[str, dict[str, object]] = {}
        total_prompt = 0
        total_completion = 0
        total_cost = Decimal("0")

        for record in records:
            total_prompt += record.prompt_tokens
            total_completion += record.completion_tokens
            total_cost += record.cost_usd

            prov = record.provider_name
            if prov not in provider_totals:
                provider_totals[prov] = {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                    "cost_usd": Decimal("0"),
                    "request_count": 0,
                    "success_count": 0,
                    "failure_count": 0,
                }
            pt = provider_totals[prov]
            pt["prompt_tokens"] = int(pt["prompt_tokens"]) + record.prompt_tokens
            pt["completion_tokens"] = int(pt["completion_tokens"]) + record.completion_tokens
            pt["total_tokens"] = int(pt["total_tokens"]) + record.total_tokens
            pt["cost_usd"] = Decimal(str(pt["cost_usd"])) + record.cost_usd
            pt["request_count"] = int(pt["request_count"]) + 1
            if record.success:
                pt["success_count"] = int(pt["success_count"]) + 1
            else:
                pt["failure_count"] = int(pt["failure_count"]) + 1

        return UsageSnapshot(
            provider_totals=provider_totals,
            total_prompt_tokens=total_prompt,
            total_completion_tokens=total_completion,
            total_cost_usd=total_cost,
            record_count=len(records),
        )

    def provider_usage(self, provider_name: str) -> dict[str, object]:
        """Return aggregated usage for a single provider.

        Returns an empty dict if no records exist for that provider.
        """
        snapshot = self.snapshot()
        return dict(snapshot.provider_totals.get(provider_name, {}))

    def check_budget(
        self,
        config: BudgetConfig,
        provider_name: str | None = None,
    ) -> bool:
        """Check whether the budget has been exceeded.

        Parameters
        ----------
        config:
            The budget limits to check against.
        provider_name:
            If set, only check usage for this provider.  ``None`` checks
            global usage.

        Returns
        -------
        bool
            ``True`` if the budget is still available (not exceeded).
        """
        snapshot = self.snapshot(window_seconds=config.window_seconds)

        if provider_name:
            prov_usage = snapshot.provider_totals.get(provider_name, {})
            total_cost = Decimal(str(prov_usage.get("cost_usd", "0")))
            total_tokens = int(prov_usage.get("total_tokens", 0))
            total_requests = int(prov_usage.get("request_count", 0))
        else:
            total_cost = snapshot.total_cost_usd
            total_tokens = snapshot.total_prompt_tokens + snapshot.total_completion_tokens
            total_requests = snapshot.record_count

        if config.max_cost_usd is not None and total_cost >= config.max_cost_usd:
            logger.warning(
                "Budget exceeded: cost %.4f >= %.4f (provider=%s)",
                total_cost,
                config.max_cost_usd,
                provider_name or "global",
            )
            return False

        if config.max_total_tokens is not None and total_tokens >= config.max_total_tokens:
            logger.warning(
                "Budget exceeded: tokens %d >= %d (provider=%s)",
                total_tokens,
                config.max_total_tokens,
                provider_name or "global",
            )
            return False

        if config.max_requests is not None and total_requests >= config.max_requests:
            logger.warning(
                "Budget exceeded: requests %d >= %d (provider=%s)",
                total_requests,
                config.max_requests,
                provider_name or "global",
            )
            return False

        return True

    def clear(self) -> None:
        """Clear all recorded usage data."""
        self._records.clear()
        logger.debug("Usage tracker cleared")


__all__ = [
    "BudgetConfig",
    "UsageRecord",
    "UsageSnapshot",
    "UsageTracker",
]
