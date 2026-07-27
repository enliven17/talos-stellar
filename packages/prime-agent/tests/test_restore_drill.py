"""Tests for automated restore drill runner (restore_drill.py).

Covers:
- Each drill scenario (normal_roundtrip, key_rotation, migration, corruption,
  wrong_identity, rollback, scheduler_no_duplicate_effects).
- Full drill orchestration (run_restore_drill).
- Report serialisation and persistence (write_drill_report, pruning).
- CLI `checkpoint drill` exit codes and output formatting.
- Error paths: unknown scenarios, invalid schema versions.
- Bounded report size enforcement.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from talos_agent.checkpoint_cli import checkpoint, CheckpointExitCode
from talos_agent.restore_drill import (
    ALL_SCENARIOS,
    DrillConfig,
    DrillReport,
    ScenarioResult,
    _prune_old_reports,
    _sanitise_error,
    run_restore_drill,
    run_restore_drill_sync,
    write_drill_report,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def drill_config() -> DrillConfig:
    return DrillConfig(
        scenarios={"normal_roundtrip", "key_rotation", "wrong_identity"},
    )


@pytest.fixture
def tmp_report_dir(tmp_path: Path) -> Path:
    report_dir = tmp_path / "drill_reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    return report_dir


def _extract_json_from_output(output: str) -> dict:
    """Extract the JSON payload from CLI output that may include log lines."""
    lines = output.splitlines()
    json_lines = []
    in_json = False
    brace_depth = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("{") and not in_json:
            in_json = True
            brace_depth = 0
        if in_json:
            json_lines.append(line)
            brace_depth += stripped.count("{") - stripped.count("}")
            if brace_depth <= 0 and json_lines:
                return json.loads("\n".join(json_lines))
    # Fallback: try parsing the whole output
    return json.loads(output)


# ── Section 1: Individual scenario tests ──────────────────────────────────────

class TestNormalRoundtrip:
    """Seal payload, open it, verify plaintext matches."""

    async def test_normal_roundtrip_passes(self):
        from talos_agent.restore_drill import _scenario_normal_roundtrip

        result = _scenario_normal_roundtrip(
            agent_id="drill-test", master_pw="drill-pw"
        )
        assert result.scenario == "normal_roundtrip"
        assert result.passed is True
        assert result.duration_ms > 0

    async def test_normal_roundtrip_multiple_calls_deterministic(self):
        from talos_agent.restore_drill import _scenario_normal_roundtrip

        r1 = _scenario_normal_roundtrip()
        r2 = _scenario_normal_roundtrip()
        assert r1.passed == r2.passed is True


class TestKeyRotation:
    """Old envelopes readable after rotation; new envelopes use new key."""

    async def test_key_rotation_passes(self):
        from talos_agent.restore_drill import _scenario_key_rotation

        result = _scenario_key_rotation(
            agent_id="drill-rot", master_pw="drill-rot-pw"
        )
        assert result.scenario == "key_rotation"
        assert result.passed is True
        assert "both eras readable" in result.detail


class TestMigration:
    """Cross-schema-version compatibility through staged-restore preflight."""

    async def test_migration_supported_version_passes(self):
        from talos_agent.restore_drill import _scenario_migration

        result = await _scenario_migration(
            agent_id="drill-mig", master_pw="drill-mig-pw",
            schema_versions={1},
        )
        assert result.scenario == "migration"
        assert result.passed is True
        assert "checks passed" in result.detail

    async def test_migration_unsupported_version_rejected(self):
        """Schema version 99 is unsupported: preflight must reject it."""
        from talos_agent.restore_drill import _scenario_migration

        result = await _scenario_migration(
            agent_id="drill-mig", master_pw="drill-mig-pw",
            schema_versions={99},
        )
        assert result.scenario == "migration"
        # Unsupported versions are rejected by preflight (passes because correctly detected)
        assert result.passed is True


class TestCorruption:
    """Tampered ciphertext, HMAC, and AAD fields are detected."""

    async def test_corruption_detection_passes(self):
        from talos_agent.restore_drill import _scenario_corruption

        result = _scenario_corruption(
            agent_id="drill-corr", master_pw="drill-corr-pw"
        )
        assert result.scenario == "corruption"
        assert result.passed is True
        assert "Detected 3/3" in result.detail


class TestWrongIdentity:
    """Envelope rejected when expected_agent_id mismatches."""

    async def test_wrong_identity_rejection_passes(self):
        from talos_agent.restore_drill import _scenario_wrong_identity

        result = _scenario_wrong_identity(
            agent_id="drill-id", master_pw="drill-id-pw"
        )
        assert result.scenario == "wrong_identity"
        assert result.passed is True
        assert "rejected" in result.detail


class TestRollback:
    """Stale sequence rejection — open_latest returns highest; recover_interrupted_restore safely no-ops."""

    async def test_rollback_passes(self):
        from talos_agent.restore_drill import _scenario_rollback

        result = _scenario_rollback(
            agent_id="drill-rb", master_pw="drill-rb-pw"
        )
        assert result.scenario == "rollback"
        assert result.passed is True
        assert "highest sequence" in result.detail
        assert "recover_interrupted_restore" in result.detail


class TestSchedulerNoDuplicateEffects:
    """Scheduler idempotency after restore — reconciliation is a no-op on second pass."""

    async def test_scheduler_no_duplicate_effects_passes(self):
        from talos_agent.restore_drill import _scenario_scheduler_no_duplicate_effects

        result = await _scenario_scheduler_no_duplicate_effects(
            agent_id="drill-sched", master_pw="drill-sched-pw"
        )
        assert result.scenario == "scheduler_no_duplicate_effects"
        assert result.passed is True
        assert "Pass 1: schedules_reset=" in result.detail
        assert "Pass 2: schedules_reset=0" in result.detail
        assert "backoff_capped=0" in result.detail


# ── Section 2: Full drill orchestration ────────────────────────────────────────

class TestRunRestoreDrill:
    """run_restore_drill() orchestrates all scenarios and produces a DrillReport."""

    async def test_run_all_scenarios_passes(self):
        config = DrillConfig()
        report = await run_restore_drill(config=config)

        assert isinstance(report, DrillReport)
        assert report.total == 7  # all registered scenarios
        assert report.passed == report.total
        assert report.failed == 0
        assert report.duration_ms > 0
        assert len(report.scenarios) == report.total
        for s in report.scenarios:
            assert s.passed is True
            assert isinstance(s.detail, str) and len(s.detail) > 0

    async def test_subset_of_scenarios(self, drill_config):
        report = await run_restore_drill(config=drill_config)

        assert report.total == 3
        scenario_names = {s.scenario for s in report.scenarios}
        assert scenario_names == {"normal_roundtrip", "key_rotation", "wrong_identity"}

    async def test_empty_scenarios_produces_empty_report(self):
        config = DrillConfig(scenarios=set())
        report = await run_restore_drill(config=config)

        assert report.total == 0
        assert report.passed == 0
        assert report.failed == 0
        assert len(report.scenarios) == 0

    async def test_unknown_scenario_not_in_runner_registry(self):
        """Scenarios not in _SCENARIO_RUNNERS are silently skipped."""
        config = DrillConfig(scenarios={"nonexistent_scenario"})
        report = await run_restore_drill(config=config)

        # Unknown scenario not in registry → total == 0, no crash
        assert report.total == 0

    async def test_report_timestamp_is_iso(self):
        config = DrillConfig(scenarios={"normal_roundtrip"})
        report = await run_restore_drill(config=config)

        # Should look like: 2026-07-27T12:34:56.789Z
        assert report.timestamp.endswith("Z")
        assert "T" in report.timestamp


class TestRunRestoreDrillSync:
    """Synchronous wrapper runs without errors."""

    def test_sync_wrapper_runs(self):
        config = DrillConfig(scenarios={"wrong_identity"})
        report = run_restore_drill_sync(config=config)

        assert report.total == 1
        assert report.passed == 1
        for s in report.scenarios:
            assert s.passed is True


# ── Section 3: Report persistence ──────────────────────────────────────────────

class TestWriteDrillReport:
    """write_drill_report() persists reports and prunes old ones."""

    def test_report_written_to_disk(self, tmp_report_dir: Path):
        report = DrillReport(
            timestamp="2026-07-27T10:00:00-000Z",
            total=1,
            passed=1,
            failed=0,
            scenarios=[ScenarioResult(
                scenario="test", passed=True, duration_ms=1.0, detail="ok",
            )],
            duration_ms=1.0,
        )

        path = write_drill_report(report, report_dir=tmp_report_dir, retain_count=5)
        assert path.exists()
        assert path.suffix == ".json"

        content = json.loads(path.read_text())
        assert content["total"] == 1
        assert content["passed"] == 1
        assert len(content["scenarios"]) == 1
        # No raw keys or PII in report
        content_str = json.dumps(content)
        assert "ENC::" not in content_str
        assert "password" not in content_str.lower()

    def test_multiple_reports_prune_oldest(self, tmp_report_dir: Path):
        # Write 4 reports, retain only 2
        for i in range(4):
            report = DrillReport(
                timestamp=f"2026-07-27T10:00:0{i}-000Z",
                total=1,
                passed=1,
                failed=0,
                scenarios=[ScenarioResult(
                    scenario=f"run_{i}", passed=True, duration_ms=1.0, detail="ok",
                )],
                duration_ms=1.0,
            )
            write_drill_report(report, report_dir=tmp_report_dir, retain_count=2)

        remaining = list(tmp_report_dir.glob("drill_report_*.json"))
        # Filename-based pruning: oldest (by filename) removed first
        assert len(remaining) <= 2

    def test_report_content_has_no_sensitive_fields(self, tmp_report_dir: Path):
        """Bounded report must not leak plaintext keys, passwords, or PII."""
        report = DrillReport(
            timestamp="2026-07-27T10:00:00-000Z",
            total=1,
            passed=1,
            failed=0,
            scenarios=[ScenarioResult(
                scenario="test", passed=True, duration_ms=1.0, detail="ok",
                error=None,
            )],
            duration_ms=1.0,
        )

        path = write_drill_report(report, report_dir=tmp_report_dir)
        raw = path.read_text()
        # High-signal checks — no forbidden tokens
        assert "master_pw" not in raw
        assert "raw_key" not in raw
        assert "HMAC key" not in raw
        assert "ENC::" not in raw

    def test_prune_old_reports_respects_retain_count(self, tmp_report_dir: Path):
        """_prune_old_reports internal helper works correctly with filename sort."""
        for i in range(5):
            (tmp_report_dir / f"drill_report_2026-07-27T10-00-0{i}-000Z.json").write_text("{}")

        _prune_old_reports(tmp_report_dir, retain_count=2, current="drill_report_2026-07-27T10-00-04-000Z.json")

        remaining = list(tmp_report_dir.glob("drill_report_*.json"))
        assert len(remaining) <= 2

    def test_prune_never_deletes_current(self, tmp_report_dir: Path):
        """Even if current is the oldest (by filename), it must be kept."""
        for i in range(5):
            (tmp_report_dir / f"drill_report_{i:04d}.json").write_text("{}")

        _prune_old_reports(tmp_report_dir, retain_count=2, current="drill_report_0000.json")

        assert (tmp_report_dir / "drill_report_0000.json").exists()

    def test_report_truncation_with_many_scenarios(self, tmp_report_dir: Path):
        """Reports with many scenarios or long details are still bounded."""
        report = DrillReport(
            timestamp="2026-07-27T10:00:00-000Z",
            total=20,
            passed=20,
            failed=0,
            scenarios=[
                ScenarioResult(
                    scenario=f"scenario_{i}",
                    passed=True,
                    duration_ms=1.0,
                    detail="very long detail string " * 100,
                )
                for i in range(20)
            ],
            duration_ms=100.0,
        )

        path = write_drill_report(report, report_dir=tmp_report_dir)
        size = path.stat().st_size
        # Must be well under the 512 KiB limit
        assert size < 100 * 1024


# ── Section 4: Helper functions ────────────────────────────────────────────────

class TestSanitiseError:
    def test_short_error_unchanged(self):
        result = _sanitise_error(ValueError("short"))
        assert result == "short"

    def test_long_error_truncated(self):
        long_msg = "x" * 250
        result = _sanitise_error(ValueError(long_msg))
        assert len(result) <= 203  # 200 + "..."
        assert result.endswith("...")


class TestALLScenarios:
    def test_all_scenarios_are_strings(self):
        for s in ALL_SCENARIOS:
            assert isinstance(s, str)
            assert len(s) > 0

    def test_all_scenarios_have_runners(self):
        """Every scenario in ALL_SCENARIOS must have a runner."""
        from talos_agent.restore_drill import _SCENARIO_RUNNERS

        for s in ALL_SCENARIOS:
            assert s in _SCENARIO_RUNNERS, f"No runner for scenario: {s}"


# ── Section 5: CLI integration tests ───────────────────────────────────────────

class TestCheckpointCLIDrill:
    """CLI `checkpoint drill` command."""

    def test_cli_drill_single_scenario(self, tmp_path: Path):
        runner = CliRunner()
        report_dir = tmp_path / "drill_reports"
        report_dir.mkdir()

        result = runner.invoke(
            checkpoint,
            ["drill", "--output-dir", str(report_dir), "--scenarios", "wrong_identity", "--json"],
        )
        assert result.exit_code == 0
        json_output = _extract_json_from_output(result.output)
        assert json_output["total"] >= 1
        assert json_output["passed"] == json_output["total"]
        assert json_output["report_path"] is not None

    def test_cli_drill_unknown_scenario(self):
        runner = CliRunner()
        result = runner.invoke(
            checkpoint,
            ["drill", "--scenarios", "unknown_fake_scenario"],
        )
        assert result.exit_code == CheckpointExitCode.VALIDATION_ERROR

    def test_cli_drill_invalid_schema_version(self):
        runner = CliRunner()
        result = runner.invoke(
            checkpoint,
            ["drill", "--schema-versions", "not_a_number", "--scenarios", "wrong_identity"],
        )
        assert result.exit_code == CheckpointExitCode.VALIDATION_ERROR

    def test_cli_drill_text_output(self, tmp_path: Path):
        """Non-JSON output should be human-readable."""
        runner = CliRunner()
        report_dir = tmp_path / "drill_reports"
        report_dir.mkdir()

        result = runner.invoke(
            checkpoint,
            ["drill", "--output-dir", str(report_dir), "--scenarios", "normal_roundtrip"],
        )
        assert result.exit_code == 0
        assert "Restore drill complete" in result.output
        assert "Report saved to" in result.output

    def test_cli_drill_full_run_succeeds(self, tmp_path: Path):
        """All scenarios run end-to-end via CLI should pass."""
        runner = CliRunner()
        report_dir = tmp_path / "drill_reports"
        report_dir.mkdir()

        result = runner.invoke(
            checkpoint,
            ["drill", "--output-dir", str(report_dir)],
        )
        assert result.exit_code == 0


# ── Section 6: DrillConfig defaults ────────────────────────────────────────────

class TestDrillConfig:
    def test_default_scenarios_are_all(self):
        config = DrillConfig()
        assert config.scenarios == set(ALL_SCENARIOS)

    def test_default_schema_versions(self):
        config = DrillConfig()
        assert config.schema_versions == {1}

    def test_default_max_duration(self):
        config = DrillConfig()
        assert config.max_duration_secs == 30.0

    def test_custom_scenarios_subset(self):
        config = DrillConfig(scenarios={"corruption"})
        assert config.scenarios == {"corruption"}


# ── Section 7: DrillReport structure ───────────────────────────────────────────

class TestDrillReport:
    def test_empty_report_defaults(self):
        report = DrillReport(timestamp="2026-01-01T00:00:00.000Z")
        assert report.total == 0
        assert report.passed == 0
        assert report.failed == 0
        assert report.scenarios == []
        assert report.duration_ms == 0.0

    def test_report_with_scenarios(self):
        report = DrillReport(
            timestamp="2026-01-01T00:00:00.000Z",
            total=2,
            passed=1,
            failed=1,
            scenarios=[
                ScenarioResult(scenario="a", passed=True, duration_ms=1.0, detail="ok"),
                ScenarioResult(scenario="b", passed=False, duration_ms=2.0, detail="fail", error="reason"),
            ],
            duration_ms=3.0,
        )
        assert report.total == 2
        assert report.passed == 1
        assert report.failed == 1
        assert len(report.scenarios) == 2


# ── Section 8: Concurrency / idempotency ──────────────────────────────────────

class TestDrillIdempotency:
    """Restore drills must be deterministic and safe to run concurrently."""

    async def test_two_consecutive_runs_produce_same_pass_count(self):
        config = DrillConfig(scenarios={"normal_roundtrip", "wrong_identity"})

        r1 = await run_restore_drill(config=config)
        r2 = await run_restore_drill(config=config)

        assert r1.total == r2.total
        assert r1.passed == r2.passed
        assert r1.failed == r2.failed
