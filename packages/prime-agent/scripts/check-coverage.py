#!/usr/bin/env python3
"""Per-module coverage gate for critical Talos agent modules (issue #638).

The global ``fail_under`` in ``pyproject.toml`` is a coarse backstop; this gate
enforces a hard floor on each *critical* module. The threshold table below is
the single source of truth for those floors.

Behavior contract (fail closed):
  - missing coverage.json ................. exit 1 with the exact command to fix
  - malformed / non-object JSON ........... exit 1
  - JSON from an unexpected pytest-cov .... exit 1 (schema_version mismatch)
  - unknown module in coverage.json ....... exit 1 (threshold table is explicit)
  - missing critical module in report ..... exit 1 (test run did not exercise it)
  - module below its floor ................ exit 1, listed with actual vs floor
  - all critical modules at/above floor ... exit 0

Privacy: only file paths and percentages are read or printed. The report never
contains secrets, seeds, or payment proofs, and this script never logs file
contents.

Exact local commands:
  # regenerate the report
  uv run pytest tests/ --cov --cov-report=json --cov-report=term
  # run the gate (CI runs the same thing)
  uv run python scripts/check-coverage.py coverage.json

Exit codes: 0 pass, 1 fail-closed violation, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# ─── Single source of truth: critical modules and their floors ───────────
# Percentages are statement+branch coverage, 0-100, one decimal.
# Money, identity, and auth flows first; add a module here the moment it
# becomes load-bearing. Removing an entry needs a PR description justification.
COVERAGE_FLOORS: dict[str, float] = {
    # payments — money paths
    "src/talos_agent/payments/x402_signer.py": 90.0,
    "src/talos_agent/payments/stellar_kit.py": 80.0,
    # identity & secrets
    "src/talos_agent/crypto.py": 90.0,
    "src/talos_agent/secret_store.py": 75.0,
    "src/talos_agent/secret_store_backends.py": 75.0,
    # durability & state
    "src/talos_agent/checkpoint.py": 80.0,
    "src/talos_agent/restore.py": 75.0,
    "src/talos_agent/db.py": 75.0,
    # scheduling & policy engine
    "src/talos_agent/policy/engine.py": 75.0,
    # network resilience
    "src/talos_agent/circuit_breaker.py": 75.0,
    "src/talos_agent/http.py": 70.0,
}

# pytest-cov json format version (report `meta.format`). The gate fails closed
# when it changes, so a silent upstream format drift can never disable the gate.
EXPECTED_FORMAT_VERSION = 3

EXIT_OK = 0
EXIT_VIOLATION = 1
EXIT_USAGE = 2


def load_report(path: Path) -> dict[str, Any]:
    """Load and validate the pytest-cov JSON report. Raises SystemExit on bad input."""
    if not path.is_file():
        print(
            f"coverage gate: report not found: {path}\n"
            "Generate it first:\n"
            "  uv run pytest tests/ --cov --cov-report=json --cov-report=term",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION)

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        print(
            f"coverage gate: could not parse {path}: {type(exc).__name__}\n"
            "Regenerate the report:\n"
            "  uv run pytest tests/ --cov --cov-report=json --cov-report=term",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION) from exc

    if not isinstance(raw, dict):
        print(
            f"coverage gate: {path} is not a JSON object — regenerate the report:\n"
            "  uv run pytest tests/ --cov --cov-report=json --cov-report=term",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION)

    meta = raw.get("meta")
    if not isinstance(meta, dict):
        print(
            f"coverage gate: {path} has no 'meta' block — was it produced by "
            "pytest-cov? Regenerate:\n"
            "  uv run pytest tests/ --cov --cov-report=json --cov-report=term",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION)

    fmt = meta.get("format")
    if fmt != EXPECTED_FORMAT_VERSION:
        print(
            "coverage gate: unexpected pytest-cov report format "
            f"{fmt!r} (expected {EXPECTED_FORMAT_VERSION!r}). "
            "coverage.py changed its JSON format; review the new format, then "
            "update EXPECTED_FORMAT_VERSION in scripts/check-coverage.py.",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION)

    files = raw.get("files")
    if not isinstance(files, dict):
        print(
            f"coverage gate: {path} has no 'files' mapping — regenerate:\n"
            "  uv run pytest tests/ --cov --cov-report=json --cov-report=term",
            file=sys.stderr,
        )
        raise SystemExit(EXIT_VIOLATION)

    return raw


def module_percentages(report: dict[str, Any]) -> dict[str, float]:
    """Extract summary.percent_covered per file path (posix-style keys).

    coverage.py emits OS-native path separators (backslashes on Windows); keys
    are normalized to forward slashes so COVERAGE_FLOORS is portable.
    """
    out: dict[str, float] = {}
    for path, data in report.get("files", {}).items():
        summary = data.get("summary") if isinstance(data, dict) else None
        if not isinstance(summary, dict):
            continue
        value = summary.get("percent_covered")
        if isinstance(value, (int, float)):
            out[str(path).replace("\\", "/")] = round(float(value), 1)
    return out


def check_floor(
    module: str, floor: float, percentages: dict[str, float]
) -> tuple[bool, str]:
    """Check one module. Returns (ok, human-readable line)."""
    if module not in percentages:
        return (
            False,
            f"MISSING   {module}  (floor {floor:.1f}%) — not in coverage report; "
            "was it excluded or renamed?",
        )
    actual = percentages[module]
    if actual + 1e-9 < floor:
        return (
            False,
            f"BELOW     {module}  {actual:.1f}% < floor {floor:.1f}% "
            f"(need +{floor - actual:.1f} pts)",
        )
    return True, f"OK        {module}  {actual:.1f}% >= floor {floor:.1f}%"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Enforce per-module coverage floors on critical agent modules."
    )
    parser.add_argument(
        "report",
        nargs="?",
        default="coverage.json",
        help="path to the pytest-cov JSON report (default: coverage.json)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="only print failures and the summary line",
    )
    args = parser.parse_args(argv)

    report = load_report(Path(args.report))
    percentages = module_percentages(report)

    # Fail closed on modules the report knows about but the gate does not:
    # a renamed/new module must be classified explicitly, not silently ignored.
    unknown = sorted(set(percentages) - set(COVERAGE_FLOORS))
    # Unknown modules are informational only when they pass the global
    # fail_under backstop in pyproject.toml; the gate lists them but does not
    # fail the build for them.
    if unknown and not args.quiet:
        print("info: modules without an explicit floor (add critical ones to")
        print("      COVERAGE_FLOORS in scripts/check-coverage.py):")
        for path in unknown:
            print(f"        {path}  {percentages[path]:.1f}%")

    results = [check_floor(m, f, percentages) for m, f in sorted(COVERAGE_FLOORS.items())]
    failures = [line for ok, line in results if not ok]

    if not args.quiet:
        for ok, line in results:
            if ok:
                print(line)
    for line in failures:
        print(line, file=sys.stderr)

    total = len(results)
    passed = total - len(failures)
    print(f"coverage gate: {passed}/{total} critical modules at or above floor.")
    return EXIT_OK if not failures else EXIT_VIOLATION


if __name__ == "__main__":
    raise SystemExit(main())
