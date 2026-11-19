"""Performance regression budget tests for prime-agent hot paths (issue #645).

These tests run a small, fast subset of the benchmarks defined in
``scripts/check-perf-budget.py`` so that pytest catches p99 regressions
during the normal ``uv run pytest tests/`` pass — without requiring the
full standalone script.

Design:
  - Each test runs N_SAMPLES timed samples, computes the p99, and asserts it
    is below the hard ceiling defined in the ``INLINE_BUDGET`` table below.
  - The ``INLINE_BUDGET`` table shadows ``PERF_BUDGET`` in check-perf-budget.py
    for the fast subset only; both tables reference the same ceilings so
    there is a single source of truth per function.
  - Budgets here are 3× the script's ceilings to absorb slow CI runners
    (GitHub Actions ubuntu-latest can be 3–5× slower than developer hardware).
  - All code under test is pure Python / CPU-only: no I/O, no network, no DB.
  - Sensitive data (secrets, seeds, payment proofs) is never logged or
    returned by any function under test.

Local commands:
  # Run just these tests
  cd packages/prime-agent
  uv run pytest tests/test_perf_budget.py -v

  # Run full budget script (more samples, tighter ceilings)
  uv run python scripts/check-perf-budget.py

  # CI equivalents
  uv run pytest tests/ -v --cov --cov-report=json
  uv run python scripts/check-perf-budget.py --samples 50 --warmup 5
"""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

# ── Shared helpers ───────────────────────────────────────────────────────────

# Number of timed iterations per test — low enough for fast CI, high enough
# for a stable p99 estimate.
N_SAMPLES = 50
N_WARMUP = 5

# CI headroom multiplier: budgets in this file are 3× the script's ceilings
# to handle slow GitHub Actions runners.
CI_MULTIPLIER = 3.0


def _percentile(samples: list[float], pct: float) -> float:
    """Return the *pct*-th percentile of *samples* (0–100)."""
    if not samples:
        return float("inf")
    s = sorted(samples)
    k = (len(s) - 1) * pct / 100.0
    lo = int(k)
    hi = lo + 1
    if hi >= len(s):
        return s[-1]
    return s[lo] * (1 - (k - lo)) + s[hi] * (k - lo)


def _call(fn: Callable, kwargs: dict) -> Any:
    """Call fn, supporting the ``self`` key for instance methods."""
    kw = dict(kwargs)
    self_obj = kw.pop("self", None)
    if self_obj is not None:
        return fn(self_obj, **kw)
    return fn(**kw)


def _time_fn(
    fn: Callable, kwargs: dict, n: int, n_warmup: int = N_WARMUP
) -> list[float]:
    """Return *n* wall-clock timings in milliseconds for ``fn(**kwargs)``."""
    # Warmup — exceptions are swallowed intentionally (warmup failures are
    # irrelevant to timing stability).
    for _ in range(n_warmup):
        try:  # noqa: SIM105
            _call(fn, kwargs)
        except Exception:  # noqa: BLE001
            pass
    # Timed
    samples: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        _call(fn, kwargs)
        samples.append((time.perf_counter() - t0) * 1000.0)
    return samples


def _assert_budget(samples: list[float], ceiling_ms: float, label: str) -> None:
    p99 = _percentile(samples, 99)
    budget = ceiling_ms * CI_MULTIPLIER
    assert p99 <= budget, (
        f"{label}: p99={p99:.3f}ms > CI budget {budget:.2f}ms "
        f"(base ceiling {ceiling_ms:.2f}ms × {CI_MULTIPLIER}). "
        f"p50={_percentile(samples, 50):.3f}ms  "
        f"p95={_percentile(samples, 95):.3f}ms  "
        f"mean={statistics.mean(samples):.3f}ms"
    )


# ── commerce_quote ───────────────────────────────────────────────────────────


class TestCommerceQuoteBudget:
    """Latency budgets for commerce_quote hot paths."""

    def test_parse_iso8601_valid(self) -> None:
        from talos_agent.commerce_quote import parse_iso8601_timestamp

        samples = _time_fn(
            parse_iso8601_timestamp,
            {"value": "2099-01-01T12:00:00Z"},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "parse_iso8601_timestamp (valid)")

    def test_parse_iso8601_malformed(self) -> None:
        from talos_agent.commerce_quote import parse_iso8601_timestamp

        samples = _time_fn(
            parse_iso8601_timestamp,
            {"value": "not-a-timestamp"},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "parse_iso8601_timestamp (malformed)")

    def test_verify_quote_not_expired_valid(self) -> None:
        from talos_agent.commerce_quote import verify_quote_not_expired

        now = datetime.now(timezone.utc)
        kwargs = {
            "expires_at": now + timedelta(hours=1),
            "now": now,
        }
        samples = _time_fn(verify_quote_not_expired, kwargs, N_SAMPLES)
        _assert_budget(samples, 0.10, "verify_quote_not_expired (valid)")

    def test_verify_quote_not_expired_expired(self) -> None:
        from talos_agent.commerce_quote import verify_quote_not_expired

        now = datetime.now(timezone.utc)
        kwargs = {
            "expires_at": now - timedelta(hours=1),
            "now": now,
        }
        samples = _time_fn(verify_quote_not_expired, kwargs, N_SAMPLES)
        _assert_budget(samples, 0.10, "verify_quote_not_expired (expired)")

    def test_enforce_commerce_quote_expiry_valid(self) -> None:
        from talos_agent.commerce_quote import enforce_commerce_quote_expiry

        future = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        kwargs = {"payment_details": {"expiresAt": future}}
        samples = _time_fn(enforce_commerce_quote_expiry, kwargs, N_SAMPLES)
        _assert_budget(samples, 0.20, "enforce_commerce_quote_expiry (valid)")

    def test_enforce_commerce_quote_expiry_missing(self) -> None:
        from talos_agent.commerce_quote import enforce_commerce_quote_expiry

        samples = _time_fn(
            enforce_commerce_quote_expiry,
            {"payment_details": {}},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "enforce_commerce_quote_expiry (missing expiry)")


# ── metrics normalization ─────────────────────────────────────────────────────


class TestMetricsNormalizeBudget:
    """Latency budgets for metrics cardinality normalization (frozenset lookups)."""

    def test_normalize_task_known(self) -> None:
        from talos_agent.metrics import _normalize_task

        samples = _time_fn(_normalize_task, {"value": "agent_cycle"}, N_SAMPLES)
        _assert_budget(samples, 0.05, "_normalize_task (known)")

    def test_normalize_task_unknown(self) -> None:
        from talos_agent.metrics import _normalize_task

        samples = _time_fn(_normalize_task, {"value": "unknown_task_xyz"}, N_SAMPLES)
        _assert_budget(samples, 0.05, "_normalize_task (unknown → sentinel)")

    def test_normalize_tool_known(self) -> None:
        from talos_agent.metrics import _normalize_tool

        samples = _time_fn(
            _normalize_tool, {"value": "registry_lookup"}, N_SAMPLES
        )
        _assert_budget(samples, 0.05, "_normalize_tool (known)")

    def test_normalize_model_known(self) -> None:
        from talos_agent.metrics import _normalize_model

        samples = _time_fn(
            _normalize_model, {"value": "llama3-70b-8192"}, N_SAMPLES
        )
        _assert_budget(samples, 0.05, "_normalize_model (known)")


# ── state classification ──────────────────────────────────────────────────────


class TestStateClassifyBudget:
    """Latency budgets for the state classification registry."""

    @pytest.fixture(autouse=True)
    def _ensure_probe_registered(self) -> None:
        from talos_agent.state_classify import (
            FieldClassification,
            StateCategory,
            register_field,
        )

        register_field(
            "_perf_budget_probe",
            FieldClassification(category=StateCategory.DERIVED),
        )

    def test_registered_classification_present(self) -> None:
        from talos_agent.state_classify import registered_classification

        samples = _time_fn(
            registered_classification,
            {"field_path": "_perf_budget_probe"},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "registered_classification (present)")

    def test_registered_classification_absent(self) -> None:
        from talos_agent.state_classify import registered_classification

        samples = _time_fn(
            registered_classification,
            {"field_path": "__no_such_field__"},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "registered_classification (absent)")

    def test_registered_classifications_full_copy(self) -> None:
        """Full dict copy × 100 calls: used during restore validation."""
        from talos_agent.state_classify import registered_classifications

        def _batch_100() -> None:
            for _ in range(100):
                registered_classifications()

        samples_batch: list[float] = []
        for _ in range(N_WARMUP):
            _batch_100()
        for _ in range(N_SAMPLES):
            t0 = time.perf_counter()
            _batch_100()
            samples_batch.append((time.perf_counter() - t0) * 1000.0 / 100)

        _assert_budget(
            samples_batch,
            1.00,
            "registered_classifications (full copy ×100, per-call)",
        )


# ── http sanitize ─────────────────────────────────────────────────────────────


class TestHttpSanitizeBudget:
    """Latency budgets for _sanitize_response_text."""

    def test_short_clean_text(self) -> None:
        from talos_agent.http import _sanitize_response_text

        samples = _time_fn(
            _sanitize_response_text,
            {"text": '{"status":"ok","id":"abc123"}'},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.50, "_sanitize_response_text (short, clean)")

    def test_long_token_bearing_text(self) -> None:
        from talos_agent.http import _sanitize_response_text

        chunk = '{"data":"' + ("x" * 60) + '","Authorization":"Bearer eyABC123test456"}'
        text = (chunk + ",") * 60
        long_text = text[:4096]

        samples = _time_fn(
            _sanitize_response_text,
            {"text": long_text},
            N_SAMPLES,
        )
        _assert_budget(
            samples, 5.00, "_sanitize_response_text (4 KB, token-bearing)"
        )


# ── policy engine ─────────────────────────────────────────────────────────────


class TestPolicyEngineBudget:
    """Latency budgets for PolicyEngine.evaluate."""

    def test_evaluate_disabled_fast_path(self) -> None:
        from talos_agent.policy.engine import PolicyEngine
        from talos_agent.policy.schema import ActionSpec

        engine = PolicyEngine()
        engine.enabled = False
        spec = ActionSpec(action="purchase_service", params={"price": 1.0})

        samples = _time_fn(
            PolicyEngine.evaluate,
            {"self": engine, "spec": spec},
            N_SAMPLES,
        )
        _assert_budget(
            samples, 0.50, "PolicyEngine.evaluate (disabled fast-path)"
        )

    def test_evaluate_single_approve_rule(self) -> None:
        from talos_agent.policy.engine import PolicyEngine
        from talos_agent.policy.schema import (
            ActionSpec,
            MatchCondition,
            Policy,
            PolicyRule,
            Severity,
        )

        rule = PolicyRule(
            rule_id="perf-allow-all",
            description="Single-rule approve policy for the perf-budget test",
            severity=Severity.LOW,
            conditions=(
                MatchCondition(field="action", operator="neq", value="__never__"),
            ),
        )
        policy = Policy(name="perf-test", rules=(rule,))
        engine = PolicyEngine()
        engine.load([policy])
        engine.enabled = True
        spec = ActionSpec(action="purchase_service", params={"price": 1.0})

        samples = _time_fn(
            PolicyEngine.evaluate,
            {"self": engine, "spec": spec},
            N_SAMPLES,
        )
        _assert_budget(
            samples, 5.00, "PolicyEngine.evaluate (single APPROVE rule)"
        )


# ── boundary and regression edge-cases ───────────────────────────────────────


class TestPerfBudgetEdgeCases:
    """Boundary / regression edge-cases that must not exceed budget."""

    def test_parse_iso8601_boundary_instant(self) -> None:
        """The exact boundary instant (Z suffix) must parse quickly."""
        from talos_agent.commerce_quote import parse_iso8601_timestamp

        samples = _time_fn(
            parse_iso8601_timestamp,
            {"value": "2026-01-01T00:00:00.000000Z"},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.10, "parse_iso8601_timestamp (boundary instant)")

    def test_parse_iso8601_none_input(self) -> None:
        """None input must return immediately."""
        from talos_agent.commerce_quote import parse_iso8601_timestamp

        samples = _time_fn(
            parse_iso8601_timestamp,
            {"value": None},
            N_SAMPLES,
        )
        _assert_budget(samples, 0.05, "parse_iso8601_timestamp (None input)")

    def test_normalize_task_empty_string(self) -> None:
        """Empty string must return 'other' immediately."""
        from talos_agent.metrics import _normalize_task

        samples = _time_fn(_normalize_task, {"value": ""}, N_SAMPLES)
        _assert_budget(samples, 0.05, "_normalize_task (empty string → sentinel)")

    def test_sanitize_empty_string(self) -> None:
        """Empty text must return quickly."""
        from talos_agent.http import _sanitize_response_text

        samples = _time_fn(_sanitize_response_text, {"text": ""}, N_SAMPLES)
        _assert_budget(samples, 0.10, "_sanitize_response_text (empty string)")

    def test_verify_quote_boundary_equal_now(self) -> None:
        """Quote expiry at exactly now must be treated as expired (strict <)."""
        from talos_agent.commerce_quote import verify_quote_not_expired

        now = datetime.now(timezone.utc)
        result = verify_quote_not_expired(expires_at=now, now=now)
        # Correctness: boundary instant is expired.
        assert result is False
        # Latency: the call is fast.
        samples = _time_fn(
            verify_quote_not_expired,
            {"expires_at": now, "now": now},
            N_SAMPLES,
        )
        _assert_budget(
            samples, 0.10, "verify_quote_not_expired (boundary: expires_at == now)"
        )
