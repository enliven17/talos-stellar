#!/usr/bin/env python3
"""Prime-agent performance regression budget (issue #645).

Benchmarks a set of pure, synchronous hot-path functions and fails closed if
any measured p99 latency exceeds its budget.

The threshold table at the bottom of this file (``PERF_BUDGET``) is the
**single source of truth** for all prime-agent latency ceilings.  Add a row
here the moment a new synchronous hot-path is promoted to load-bearing;
removing an entry requires a PR description justification.

Behavior contract (fail closed):
  - p99 latency exceeds ceiling ............... exit 1, listed with actual vs budget
  - callable not importable / raises .......... exit 1 (import path is wrong)
  - callable raises during measurement ........ exit 1
  - zero samples produced ..................... exit 1
  - all benchmarks within budget .............. exit 0

Privacy: only timing statistics and function labels are printed. The script
never logs return values, secrets, seeds, or payment proofs.

Exact local commands:
  # Run with defaults (100 samples, 10 warmup)
  cd packages/prime-agent
  uv run python scripts/check-perf-budget.py

  # Increase sample count for a more stable measurement
  uv run python scripts/check-perf-budget.py --samples 500 --warmup 20

  # Quick smoke run (low precision, CI-style)
  uv run python scripts/check-perf-budget.py --samples 50 --warmup 5

Exit codes: 0 pass, 1 budget-violation / import-error, 2 usage error.
"""

from __future__ import annotations

import argparse
import importlib
import statistics
import sys
import time
from collections.abc import Callable
from typing import Any

# ─── Setup helpers ────────────────────────────────────────────────────────────
#
# Each helper returns a kwargs dict for the function under test.  Setup helpers
# that construct objects (PolicyEngine, etc.) are called fresh every 20 samples
# so long-lived state doesn't skew repeated runs.
#
# No helper logs or returns sensitive data.


def _setup_verify_quote_valid() -> dict:
    from datetime import datetime, timedelta, timezone

    return {
        "expires_at": datetime.now(timezone.utc) + timedelta(hours=1),
        "now": datetime.now(timezone.utc),
    }


def _setup_verify_quote_expired() -> dict:
    from datetime import datetime, timedelta, timezone

    return {
        "expires_at": datetime.now(timezone.utc) - timedelta(hours=1),
        "now": datetime.now(timezone.utc),
    }


def _setup_enforce_valid() -> dict:
    from datetime import datetime, timedelta, timezone

    future = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    return {"payment_details": {"expiresAt": future}}


def _setup_sanitize_long() -> dict:
    # ~4 KB payload with an embedded bearer token to exercise the redaction regex.
    chunk = '{"data":"' + ("x" * 60) + '","Authorization":"Bearer eyABC123test456"}'
    text = (chunk + ",") * 60
    return {"text": text[:4096]}


def _setup_registered_classification() -> dict:
    from talos_agent.state_classify import (
        FieldClassification,
        StateCategory,
        register_field,
    )

    # Ensure at least one field is registered so the lookup always hits.
    register_field(
        "_perf_budget_probe",
        FieldClassification(category=StateCategory.DERIVED),
    )
    return {"field_path": "_perf_budget_probe"}


def _setup_policy_disabled() -> dict:
    from talos_agent.policy.engine import PolicyEngine
    from talos_agent.policy.schema import ActionSpec

    engine = PolicyEngine()
    engine.enabled = False
    spec = ActionSpec(action="purchase_service", params={"price": 1.0})
    # "self" is a special key: the benchmark loop calls fn(self_obj, **rest).
    return {"self": engine, "spec": spec}


def _setup_policy_minimal() -> dict:
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
        description="Single-rule approve policy for the perf-budget benchmark",
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
    return {"self": engine, "spec": spec}


# ─── Single source of truth: hot-path functions and their p99 ceilings ───────
#
# Each entry:
#   "label"     human-readable name shown in output
#   "module"    importable dotted module path
#   "callable"  attribute name (may use "." for nested: "ClassName.method")
#   "setup"     zero-argument callable → kwargs dict for the benchmarked fn
#   "p99_ms"    hard p99 ceiling in milliseconds (fail if exceeded)
#   "batch"     number of calls per sample (reduces timer noise for very cheap ops)
#
# Budget rationale:
#   - quote / timestamp parsing: sub-millisecond, on every commerce payment
#     path — 0.10 ms p99 (10× headroom on modern hardware).
#   - metrics normalization: frozenset membership called on every LLM / tool /
#     HTTP emission — 0.05 ms p99.
#   - state classification registry lookup: dict lookup when checkpointing
#     any field — 0.10 ms p99.
#   - registered_classifications (full copy × 100): called during restore
#     validation — 1.00 ms p99.
#   - http._sanitize_response_text (short): before every logged response body
#     — 0.50 ms p99.
#   - http._sanitize_response_text (4 KB token-bearing): stress variant for
#     the regex-scan pass — 5.00 ms p99.
#   - PolicyEngine.evaluate (disabled engine fast-path): called on every tool
#     invocation when policy evaluation is disabled — 0.50 ms p99.
#   - PolicyEngine.evaluate (single-rule enabled): minimal policy evaluation
#     round-trip — 5.00 ms p99.

PERF_BUDGET: list[dict[str, Any]] = [
    # ── commerce_quote ──────────────────────────────────────────────────────
    {
        "label": "commerce_quote.parse_iso8601_timestamp (valid)",
        "module": "talos_agent.commerce_quote",
        "callable": "parse_iso8601_timestamp",
        "setup": lambda: {"value": "2099-01-01T12:00:00Z"},
        "p99_ms": 0.10,
        "batch": 1,
    },
    {
        "label": "commerce_quote.parse_iso8601_timestamp (malformed)",
        "module": "talos_agent.commerce_quote",
        "callable": "parse_iso8601_timestamp",
        "setup": lambda: {"value": "not-a-timestamp"},
        "p99_ms": 0.10,
        "batch": 1,
    },
    {
        "label": "commerce_quote.verify_quote_not_expired (valid, not expired)",
        "module": "talos_agent.commerce_quote",
        "callable": "verify_quote_not_expired",
        "setup": _setup_verify_quote_valid,
        "p99_ms": 0.10,
        "batch": 1,
    },
    {
        "label": "commerce_quote.verify_quote_not_expired (expired)",
        "module": "talos_agent.commerce_quote",
        "callable": "verify_quote_not_expired",
        "setup": _setup_verify_quote_expired,
        "p99_ms": 0.10,
        "batch": 1,
    },
    {
        "label": "commerce_quote.enforce_commerce_quote_expiry (valid)",
        "module": "talos_agent.commerce_quote",
        "callable": "enforce_commerce_quote_expiry",
        "setup": _setup_enforce_valid,
        "p99_ms": 0.20,
        "batch": 1,
    },
    {
        "label": "commerce_quote.enforce_commerce_quote_expiry (missing expiry)",
        "module": "talos_agent.commerce_quote",
        "callable": "enforce_commerce_quote_expiry",
        "setup": lambda: {"payment_details": {}},
        "p99_ms": 0.10,
        "batch": 1,
    },
    # ── metrics normalization ────────────────────────────────────────────────
    {
        "label": "metrics._normalize_task (known value)",
        "module": "talos_agent.metrics",
        "callable": "_normalize_task",
        "setup": lambda: {"value": "agent_cycle"},
        "p99_ms": 0.05,
        "batch": 1,
    },
    {
        "label": "metrics._normalize_task (unknown → sentinel)",
        "module": "talos_agent.metrics",
        "callable": "_normalize_task",
        "setup": lambda: {"value": "not_a_real_task_xyz"},
        "p99_ms": 0.05,
        "batch": 1,
    },
    {
        "label": "metrics._normalize_tool (known value)",
        "module": "talos_agent.metrics",
        "callable": "_normalize_tool",
        "setup": lambda: {"value": "registry_lookup"},
        "p99_ms": 0.05,
        "batch": 1,
    },
    {
        "label": "metrics._normalize_model (known value)",
        "module": "talos_agent.metrics",
        "callable": "_normalize_model",
        "setup": lambda: {"value": "llama3-70b-8192"},
        "p99_ms": 0.05,
        "batch": 1,
    },
    # ── state classification ─────────────────────────────────────────────────
    {
        "label": "state_classify.registered_classification (present)",
        "module": "talos_agent.state_classify",
        "callable": "registered_classification",
        "setup": _setup_registered_classification,
        "p99_ms": 0.10,
        "batch": 1,
    },
    {
        "label": "state_classify.registered_classifications (full copy ×100)",
        "module": "talos_agent.state_classify",
        "callable": "registered_classifications",
        "setup": dict,
        "p99_ms": 1.00,
        "batch": 100,
    },
    # ── http sanitize ────────────────────────────────────────────────────────
    {
        "label": "http._sanitize_response_text (short, clean)",
        "module": "talos_agent.http",
        "callable": "_sanitize_response_text",
        "setup": lambda: {"text": '{"status":"ok","id":"abc123"}'},
        "p99_ms": 0.50,
        "batch": 1,
    },
    {
        "label": "http._sanitize_response_text (4 KB, token-bearing)",
        "module": "talos_agent.http",
        "callable": "_sanitize_response_text",
        "setup": _setup_sanitize_long,
        "p99_ms": 5.00,
        "batch": 1,
    },
    # ── policy engine ────────────────────────────────────────────────────────
    {
        "label": "policy.engine.PolicyEngine.evaluate (disabled fast-path)",
        "module": "talos_agent.policy.engine",
        "callable": "PolicyEngine.evaluate",
        "setup": _setup_policy_disabled,
        "p99_ms": 0.50,
        "batch": 1,
    },
    {
        "label": "policy.engine.PolicyEngine.evaluate (single APPROVE rule)",
        "module": "talos_agent.policy.engine",
        "callable": "PolicyEngine.evaluate",
        "setup": _setup_policy_minimal,
        "p99_ms": 5.00,
        "batch": 1,
    },
]


# ─── Benchmarking helpers ────────────────────────────────────────────────────


def _percentile(samples: list[float], pct: float) -> float:
    """Return the *pct*-th percentile of *samples* (0–100)."""
    if not samples:
        return float("inf")
    sorted_s = sorted(samples)
    k = (len(sorted_s) - 1) * pct / 100.0
    lo = int(k)
    hi = lo + 1
    if hi >= len(sorted_s):
        return sorted_s[-1]
    frac = k - lo
    return sorted_s[lo] * (1 - frac) + sorted_s[hi] * frac


def _resolve_callable(module_path: str, attr_path: str) -> Callable:
    """Import *module_path* and resolve dotted *attr_path*.

    Exits with code 1 on import or attribute failure so callers don't need to
    handle ImportError separately.
    """
    try:
        mod = importlib.import_module(module_path)
    except ImportError as exc:
        print(
            f"perf budget: cannot import {module_path!r}: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1) from exc

    obj: Any = mod
    for part in attr_path.split("."):
        try:
            obj = getattr(obj, part)
        except AttributeError as exc:
            print(
                f"perf budget: {module_path}.{attr_path!r} not found: {exc}",
                file=sys.stderr,
            )
            raise SystemExit(1) from exc
    return obj  # type: ignore[return-value]


def _run_benchmark(
    entry: dict[str, Any],
    n_samples: int,
    n_warmup: int,
) -> dict[str, float]:
    """Run one benchmark entry.  Returns timing stats in milliseconds.

    If ``"self"`` is present in the kwargs dict returned by setup, the function
    is called as ``fn(self_obj, **remaining_kwargs)``.  This lets us benchmark
    instance methods without them needing to be separately importable.
    """
    fn = _resolve_callable(entry["module"], entry["callable"])
    setup: Callable[[], dict] = entry.get("setup") or dict
    batch: int = entry.get("batch", 1)

    def _call(kwargs: dict) -> None:
        kw = dict(kwargs)
        self_obj = kw.pop("self", None)
        if self_obj is not None:
            fn(self_obj, **kw)
        else:
            fn(**kw)

    # Warmup — not timed; exceptions are swallowed intentionally here because
    # warmup failures are irrelevant to timing stability.
    kwargs = setup()
    for _ in range(n_warmup):
        try:  # noqa: SIM105
            for _ in range(batch):
                _call(kwargs)
        except Exception:  # noqa: BLE001
            pass

    # Timed samples.
    samples_ms: list[float] = []
    kwargs = setup()
    for i in range(n_samples):
        # Refresh setup kwargs every 20 iterations so clock-dependent setups
        # (e.g. verify_quote_not_expired) stay fresh.
        if i > 0 and i % 20 == 0:
            kwargs = setup()
        t0 = time.perf_counter()
        try:
            for _ in range(batch):
                _call(kwargs)
        except Exception as exc:
            print(
                f"perf budget: {entry['label']!r} raised during measurement: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            raise SystemExit(1) from exc
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if batch > 1:
            elapsed_ms /= batch
        samples_ms.append(elapsed_ms)

    if not samples_ms:
        print(
            f"perf budget: {entry['label']!r} produced zero timing samples",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return {
        "p50": _percentile(samples_ms, 50),
        "p95": _percentile(samples_ms, 95),
        "p99": _percentile(samples_ms, 99),
        "mean": statistics.mean(samples_ms),
        "min": min(samples_ms),
        "max": max(samples_ms),
    }


# ─── Main ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Prime-agent performance budget gate (issue #645). "
            "Runs micro-benchmarks on synchronous hot paths and fails if any "
            "p99 latency exceeds its configured ceiling."
        )
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=100,
        metavar="N",
        help="Number of timed samples per benchmark (default: 100).",
    )
    parser.add_argument(
        "--warmup",
        type=int,
        default=10,
        metavar="W",
        help="Warmup iterations before timing begins (default: 10).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Only print failures and the final summary line.",
    )
    args = parser.parse_args(argv)

    if args.samples < 1:
        print("perf budget: --samples must be >= 1", file=sys.stderr)
        return 2
    if args.warmup < 0:
        print("perf budget: --warmup must be >= 0", file=sys.stderr)
        return 2

    violations: list[str] = []
    total = len(PERF_BUDGET)

    for entry in PERF_BUDGET:
        label = entry["label"]
        ceiling_ms = float(entry["p99_ms"])

        try:
            stats = _run_benchmark(entry, args.samples, args.warmup)
        except SystemExit as exc:
            return int(exc.code) if exc.code is not None else 1

        p99 = stats["p99"]
        ok = p99 <= ceiling_ms

        if ok:
            if not args.quiet:
                print(
                    f"OK        {label}  "
                    f"p50={stats['p50']:.3f}ms  "
                    f"p95={stats['p95']:.3f}ms  "
                    f"p99={p99:.3f}ms  "
                    f"(budget {ceiling_ms:.2f}ms)"
                )
        else:
            line = (
                f"EXCEEDED  {label}  "
                f"p99={p99:.3f}ms > budget {ceiling_ms:.2f}ms  "
                f"(+{p99 - ceiling_ms:.3f}ms over ceiling)"
            )
            violations.append(line)
            print(line, file=sys.stderr)

    passed = total - len(violations)
    summary = f"perf budget: {passed}/{total} benchmarks within budget."
    if violations:
        print(f"\n{summary}", file=sys.stderr)
        print(
            "To investigate a regression, increase --samples and re-run:\n"
            "  uv run python scripts/check-perf-budget.py --samples 500 --warmup 20",
            file=sys.stderr,
        )
        return 1

    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
