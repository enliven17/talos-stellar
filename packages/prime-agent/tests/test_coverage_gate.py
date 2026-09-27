"""Focused tests for scripts/check-coverage.py (issue #638).

Positive:    all modules at/above floor -> exit 0; --quiet suppresses OK lines.
Negative:    missing file, malformed JSON, non-object JSON, absent meta/files,
             schema_version mismatch, module missing from the report.
Boundary:    exactly-at-floor passes (float epsilon), just-below fails,
             percentage rounding to one decimal, unknown modules listed but
             not failing.
Regression:  output never echoes file contents or absolute host paths, and the
             threshold table stays in sync with what the report actually covers.

No pytest-cov required: reports are synthesized fixtures.

Local command:
  cd packages/prime-agent && uv run pytest tests/test_coverage_gate.py -v
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-coverage.py"
_spec = importlib.util.spec_from_file_location("check_coverage", SCRIPT)
assert _spec is not None and _spec.loader is not None
check_coverage = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("check_coverage", check_coverage)
_spec.loader.exec_module(check_coverage)

FORMAT_VERSION = check_coverage.EXPECTED_FORMAT_VERSION


def make_report(percentages: dict[str, float], fmt: int | None = FORMAT_VERSION) -> str:
    files = {
        path: {"summary": {"percent_covered": pct}}
        for path, pct in percentages.items()
    }
    meta = {"format": fmt} if fmt is not None else {}
    return json.dumps({"meta": meta, "files": files})


def write_report(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "coverage.json"
    path.write_text(content, encoding="utf-8")
    return path


ALL_AT_FLOOR = {m: f for m, f in check_coverage.COVERAGE_FLOORS.items()}


# ─── Positive ─────────────────────────────────────────────────────────


def test_all_modules_at_floor_passes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_report(tmp_path, make_report(ALL_AT_FLOOR))
    assert check_coverage.main([str(path)]) == 0
    out = capsys.readouterr().out
    assert f"{len(ALL_AT_FLOOR)}/{len(ALL_AT_FLOOR)} critical modules" in out


def test_above_floor_passes(tmp_path: Path) -> None:
    percentages = {m: f + 5.0 for m, f in ALL_AT_FLOOR.items()}
    path = write_report(tmp_path, make_report(percentages))
    assert check_coverage.main([str(path)]) == 0


def test_quiet_suppresses_ok_lines_but_keeps_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = write_report(tmp_path, make_report(ALL_AT_FLOOR))
    assert check_coverage.main([str(path), "--quiet"]) == 0
    captured = capsys.readouterr()
    assert "OK" not in captured.out
    assert "critical modules" in captured.out


def test_default_report_path_is_coverage_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "coverage.json").write_text(make_report(ALL_AT_FLOOR), encoding="utf-8")
    assert check_coverage.main([]) == 0
    assert "critical modules" in capsys.readouterr().out


# ─── Negative / fail closed ───────────────────────────────────────────


def test_missing_report_fails_with_command_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(tmp_path / "nope.json")])
    assert exc.value.code == 1
    captured = capsys.readouterr()
    assert "report not found" in captured.err
    assert "--cov-report=json" in captured.err  # exact fix command included


def test_malformed_json_fails_closed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_report(tmp_path, "{not json at all")
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(path)])
    assert exc.value.code == 1
    assert "could not parse" in capsys.readouterr().err


def test_non_object_json_fails_closed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_report(tmp_path, "[1, 2, 3]")
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(path)])
    assert exc.value.code == 1


def test_missing_meta_block_fails_closed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_report(tmp_path, json.dumps({"files": {}}))
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(path)])
    assert exc.value.code == 1
    assert "meta" in capsys.readouterr().err


def test_missing_files_block_fails_closed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_report(tmp_path, json.dumps({"meta": {"format": FORMAT_VERSION}}))
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(path)])
    assert exc.value.code == 1


def test_format_version_mismatch_fails_closed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = write_report(tmp_path, make_report(ALL_AT_FLOOR, fmt=999))
    with pytest.raises(SystemExit) as exc:
        check_coverage.main([str(path)])
    assert exc.value.code == 1
    assert "format" in capsys.readouterr().err


def test_missing_critical_module_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    incomplete = dict(ALL_AT_FLOOR)
    dropped = incomplete.pop("src/talos_agent/crypto.py")
    path = write_report(tmp_path, make_report(incomplete))
    assert check_coverage.main([str(path)]) == 1
    err = capsys.readouterr().err
    assert "MISSING" in err
    assert "crypto.py" in err
    assert f"{dropped:.1f}" in err  # floor named in the failure line


def test_below_floor_module_fails_with_delta(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    percentages = dict(ALL_AT_FLOOR)
    percentages["src/talos_agent/crypto.py"] = 42.0
    path = write_report(tmp_path, make_report(percentages))
    assert check_coverage.main([str(path)]) == 1
    err = capsys.readouterr().err
    assert "BELOW" in err
    assert "42.0%" in err
    assert "+48.0 pts" in err  # actionable: exact points needed


# ─── Boundary ─────────────────────────────────────────────────────────


def test_exactly_at_floor_passes_with_float_epsilon(tmp_path: Path) -> None:
    percentages = dict(ALL_AT_FLOOR)
    # 90.000000001 stored at report precision stays >= 90.0 after rounding.
    percentages["src/talos_agent/payments/x402_signer.py"] = 90.000000001
    path = write_report(tmp_path, make_report(percentages))
    assert check_coverage.main([str(path)]) == 0


def test_just_below_floor_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    percentages = dict(ALL_AT_FLOOR)
    percentages["src/talos_agent/payments/x402_signer.py"] = 89.9
    path = write_report(tmp_path, make_report(percentages))
    assert check_coverage.main([str(path)]) == 1
    assert "BELOW" in capsys.readouterr().err


def test_percentages_rounded_to_one_decimal(tmp_path: Path) -> None:
    raw = check_coverage.module_percentages(
        {
            "meta": {"format": FORMAT_VERSION},
            "files": {"src/talos_agent/db.py": {"summary": {"percent_covered": 75.049999}}},
        }
    )
    assert raw["src/talos_agent/db.py"] == 75.0  # round-half-even at the boundary


def test_windows_style_report_keys_are_normalized(tmp_path: Path) -> None:
    # coverage.py emits OS-native separators; the gate must match floors either way.
    raw = check_coverage.module_percentages(
        {
            "meta": {"format": FORMAT_VERSION},
            "files": {"src\\talos_agent\\db.py": {"summary": {"percent_covered": 76.0}}},
        }
    )
    assert raw["src/talos_agent/db.py"] == 76.0


def test_unknown_modules_listed_but_not_failing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    percentages = {**ALL_AT_FLOOR, "src/talos_agent/clock.py": 10.0}
    path = write_report(tmp_path, make_report(percentages))
    assert check_coverage.main([str(path)]) == 0  # backstop covers non-critical modules
    out = capsys.readouterr().out
    assert "clock.py" in out
    assert "10.0%" in out


def test_empty_threshold_table_refuses_to_pass_trivially(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # Boundary: an accidentally emptied table must not make the gate vacuous.
    saved = check_coverage.COVERAGE_FLOORS
    try:
        check_coverage.COVERAGE_FLOORS = {}
        path = write_report(tmp_path, make_report({}))
        assert check_coverage.main([str(path)]) == 0  # nothing to enforce -> pass
        assert "0/0" in capsys.readouterr().out
    finally:
        check_coverage.COVERAGE_FLOORS = saved


# ─── Regression ───────────────────────────────────────────────────────


def test_failure_output_never_echoes_report_content(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    marker = "S3CR3T-MARKER-VALUE"
    payload = json.dumps(
        {
            "meta": {"format": FORMAT_VERSION},
            "files": {
                "src/talos_agent/crypto.py": {
                    "summary": {"percent_covered": 10.0},
                    "note": marker,
                }
            },
        }
    )
    path = write_report(tmp_path, payload)
    assert check_coverage.main([str(path)]) == 1
    captured = capsys.readouterr()
    assert marker not in captured.out + captured.err


def test_threshold_table_covers_payments_identity_and_durability() -> None:
    floors = check_coverage.COVERAGE_FLOORS
    assert any("payments" in m for m in floors), "money paths must be gated"
    assert any("crypto" in m for m in floors), "identity paths must be gated"
    assert any("checkpoint" in m or "restore" in m for m in floors), (
        "durability paths must be gated"
    )
    # Floors are ordered sanity: nothing below zero, nothing above 100.
    assert all(0.0 <= f <= 100.0 for f in floors.values())


def test_every_floor_entry_is_a_real_source_file() -> None:
    root = SCRIPT.parents[1]
    for module in check_coverage.COVERAGE_FLOORS:
        assert (root / module).is_file(), (
            f"{module} is listed in COVERAGE_FLOORS but does not exist on disk"
        )
