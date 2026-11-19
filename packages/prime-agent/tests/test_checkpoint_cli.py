"""Tests for checkpoint CLI helpers."""

from pathlib import Path

import pytest

from talos_agent.checkpoint_cli import validate_agent_id


def test_validate_agent_id_accepts_safe_value() -> None:
    assert validate_agent_id("agent-123_test") == "agent-123_test"


def test_validate_agent_id_strips_whitespace() -> None:
    assert validate_agent_id("  agent-123  ") == "agent-123"


def test_validate_agent_id_rejects_path_traversal() -> None:
    with pytest.raises(ValueError, match="Agent ID must contain"):
        validate_agent_id("../../secret")

def test_validate_size_limit_accepts_positive_value() -> None:
    from talos_agent.checkpoint_cli import validate_size_limit

    assert validate_size_limit(1024) == 1024


def test_validate_size_limit_rejects_zero() -> None:
    from talos_agent.checkpoint_cli import validate_size_limit

    with pytest.raises(ValueError, match="greater than zero"):
        validate_size_limit(0)


def test_atomic_write_creates_complete_file(tmp_path) -> None:
    from talos_agent.checkpoint_cli import atomic_write

    output = tmp_path / "checkpoint.json"
    atomic_write(output, b'{"schema_version":1}', max_size=1024)

    assert output.read_bytes() == b'{"schema_version":1}'


def test_atomic_write_rejects_oversized_data(tmp_path) -> None:
    from talos_agent.checkpoint_cli import atomic_write

    output = tmp_path / "checkpoint.json"

    with pytest.raises(ValueError, match="maximum allowed size"):
        atomic_write(output, b"too large", max_size=3)

    assert not output.exists()


def test_read_bounded_returns_file_bytes(tmp_path) -> None:
    from talos_agent.checkpoint_cli import read_bounded

    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_bytes(b'{"schema_version":1}')

    assert read_bounded(checkpoint, max_size=1024) == b'{"schema_version":1}'


def test_read_bounded_rejects_oversized_file(tmp_path) -> None:
    from talos_agent.checkpoint_cli import read_bounded

    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_bytes(b"too large")

    with pytest.raises(ValueError, match="maximum allowed size"):
        read_bounded(checkpoint, max_size=3)


def test_parse_checkpoint_accepts_json_object() -> None:
    from talos_agent.checkpoint_cli import parse_checkpoint

    checkpoint = parse_checkpoint(b'{"schema_version": 1}')

    assert checkpoint == {"schema_version": 1}


def test_parse_checkpoint_rejects_invalid_json() -> None:
    from talos_agent.checkpoint_cli import parse_checkpoint

    with pytest.raises(ValueError, match="not valid JSON"):
        parse_checkpoint(b"not-json")


def test_parse_checkpoint_rejects_non_object_json() -> None:
    from talos_agent.checkpoint_cli import parse_checkpoint

    with pytest.raises(ValueError, match="top-level JSON object"):
        parse_checkpoint(b'["not", "an", "object"]')


def test_validate_schema_version_accepts_positive_value() -> None:
    from talos_agent.checkpoint_cli import validate_schema_version

    assert validate_schema_version(1) == 1


def test_validate_schema_version_rejects_zero() -> None:
    from talos_agent.checkpoint_cli import validate_schema_version

    with pytest.raises(ValueError, match="greater than zero"):
        validate_schema_version(0)


def test_ensure_compatible_schema_version_accepts_supported_version() -> None:
    from talos_agent.checkpoint_cli import ensure_compatible_schema_version

    assert ensure_compatible_schema_version(1, {1}) == 1


def test_ensure_compatible_schema_version_rejects_unsupported_version() -> None:
    from talos_agent.checkpoint_cli import (
        CheckpointCompatibilityError,
        ensure_compatible_schema_version,
    )

    with pytest.raises(CheckpointCompatibilityError, match="Unsupported"):
        ensure_compatible_schema_version(2, {1})


def test_open_readonly_database_reads_without_writing(tmp_path: Path) -> None:
    import sqlite3

    from talos_agent.checkpoint_cli import open_readonly_database

    database_path = tmp_path / "agent.db"
    writable = sqlite3.connect(database_path)
    writable.execute("CREATE TABLE state (value TEXT)")
    writable.execute("INSERT INTO state VALUES ('ready')")
    writable.commit()
    writable.close()

    readonly = open_readonly_database(database_path)
    assert readonly.execute("SELECT value FROM state").fetchone()["value"] == "ready"

    with pytest.raises(sqlite3.OperationalError):
        readonly.execute("INSERT INTO state VALUES ('changed')")

    readonly.close()


def test_open_readonly_database_does_not_create_missing_file(tmp_path: Path) -> None:
    import sqlite3

    from talos_agent.checkpoint_cli import open_readonly_database

    database_path = tmp_path / "missing.db"

    with pytest.raises(sqlite3.OperationalError):
        open_readonly_database(database_path)

    assert not database_path.exists()


def test_checkpoint_cli_error_preserves_exit_code() -> None:
    from talos_agent.checkpoint_cli import (
        CheckpointCLIError,
        CheckpointExitCode,
    )

    error = CheckpointCLIError(
        "Invalid checkpoint.",
        CheckpointExitCode.VALIDATION_ERROR,
    )

    assert error.exit_code == 2


def test_summarize_database_returns_only_recognised_table_counts() -> None:
    import sqlite3

    from talos_agent.checkpoint_cli import summarize_database

    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("CREATE TABLE secret_table (secret TEXT)")
    connection.executemany(
        "INSERT INTO schedules VALUES (?)",
        [("first",), ("second",)],
    )
    connection.execute("INSERT INTO secret_table VALUES ('do-not-export')")

    summary = summarize_database(connection)

    assert summary == {"schedules": 2}
    assert "secret_table" not in summary

    connection.close()


def test_build_checkpoint_payload_contains_only_safe_metadata() -> None:
    from talos_agent.checkpoint_cli import build_checkpoint_payload

    payload = build_checkpoint_payload(
        agent_id="agent-1",
        schema_version=1,
        table_counts={"schedules": 2, "activity_log": 5},
    )

    assert payload == {
        "schema_version": 1,
        "agent_id": "agent-1",
        "tables": {
            "activity_log": 5,
            "schedules": 2,
        },
    }


def test_build_checkpoint_payload_rejects_invalid_agent_id() -> None:
    from talos_agent.checkpoint_cli import build_checkpoint_payload

    with pytest.raises(ValueError, match="Agent ID"):
        build_checkpoint_payload(
            agent_id="../agent",
            schema_version=1,
            table_counts={},
        )


def test_encode_checkpoint_is_deterministic() -> None:
    from talos_agent.checkpoint_cli import encode_checkpoint

    payload = {
        "tables": {"schedules": 2, "activity_log": 5},
        "agent_id": "agent-1",
        "schema_version": 1,
    }

    assert encode_checkpoint(payload) == (
        b'{"agent_id":"agent-1","schema_version":1,'
        b'"tables":{"activity_log":5,"schedules":2}}\n'
    )


def test_create_checkpoint_from_database_uses_safe_readonly_summary(
    tmp_path: Path,
) -> None:
    import sqlite3

    from talos_agent.checkpoint_cli import create_checkpoint_from_database

    database_path = tmp_path / "agent.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("CREATE TABLE activity_log (content TEXT)")
    connection.executemany(
        "INSERT INTO schedules VALUES (?)",
        [("first",), ("second",)],
    )
    connection.execute("INSERT INTO activity_log VALUES ('sensitive content')")
    connection.commit()
    connection.close()

    checkpoint = create_checkpoint_from_database(
        database_path=database_path,
        agent_id="agent-1",
        schema_version=1,
    )

    assert checkpoint == {
        "schema_version": 1,
        "agent_id": "agent-1",
        "tables": {
            "activity_log": 1,
            "schedules": 2,
        },
    }
    assert "sensitive content" not in repr(checkpoint)


def test_export_command_returns_validation_exit_code_for_invalid_agent(
    tmp_path: Path,
) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "../unsafe",
            "--output",
            str(tmp_path / "checkpoint.json"),
        ],
    )

    assert result.exit_code == 2
    assert "Agent ID" in result.output
    assert not (tmp_path / "checkpoint.json").exists()


def test_export_command_returns_compatibility_exit_code_for_unsupported_schema(
    tmp_path: Path,
) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(tmp_path / "checkpoint.json"),
            "--schema-version",
            "999",
        ],
    )

    assert result.exit_code == 3
    assert "Unsupported checkpoint schema version" in result.output
    assert not (tmp_path / "checkpoint.json").exists()


def test_export_command_returns_io_exit_code_when_database_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    output = tmp_path / "checkpoint.json"
    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(output),
        ],
    )

    assert result.exit_code == 4
    assert "Unable to export checkpoint" in result.output
    assert not output.exists()


def test_export_command_writes_safe_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("CREATE TABLE activity_log (content TEXT)")
    connection.executemany(
        "INSERT INTO schedules VALUES (?)",
        [("first",), ("second",)],
    )
    connection.execute("INSERT INTO activity_log VALUES ('private content')")
    connection.commit()
    connection.close()

    output = tmp_path / "checkpoint.json"
    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(output),
        ],
    )

    assert result.exit_code == 0
    assert output.exists()
    assert json.loads(output.read_text()) == {
        "agent_id": "agent-1",
        "schema_version": 1,
        "tables": {
            "activity_log": 1,
            "schedules": 2,
        },
    }
    assert "private content" not in output.read_text()


def test_validate_checkpoint_payload_accepts_valid_checkpoint() -> None:
    from talos_agent.checkpoint_cli import validate_checkpoint_payload

    checkpoint_data = {
        "schema_version": 1,
        "agent_id": "agent-1",
        "tables": {
            "activity_log": 3,
            "schedules": 1,
        },
    }

    assert validate_checkpoint_payload(checkpoint_data) == checkpoint_data


def test_validate_checkpoint_payload_rejects_unknown_table() -> None:
    from talos_agent.checkpoint_cli import validate_checkpoint_payload

    with pytest.raises(ValueError, match="unknown table"):
        validate_checkpoint_payload(
            {
                "schema_version": 1,
                "agent_id": "agent-1",
                "tables": {"secret_table": 1},
            }
        )


def test_format_checkpoint_summary_as_human_text() -> None:
    from talos_agent.checkpoint_cli import format_checkpoint_summary

    output = format_checkpoint_summary(
        {
            "schema_version": 1,
            "agent_id": "agent-1",
            "tables": {
                "activity_log": 3,
                "schedules": 1,
            },
        },
        as_json=False,
    )

    assert output == (
        "Agent: agent-1\n"
        "Schema version: 1\n"
        "Tables:\n"
        "  activity_log: 3\n"
        "  schedules: 1"
    )


def test_format_checkpoint_summary_as_json() -> None:
    import json

    from talos_agent.checkpoint_cli import format_checkpoint_summary

    output = format_checkpoint_summary(
        {
            "schema_version": 1,
            "agent_id": "agent-1",
            "tables": {"schedules": 1},
        },
        as_json=True,
    )

    assert json.loads(output) == {
        "schema_version": 1,
        "agent_id": "agent-1",
        "tables": {"schedules": 1},
    }


def test_inspect_command_outputs_human_summary(tmp_path: Path) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint_path.write_text(
        '{"agent_id":"agent-1","schema_version":1,'
        '"tables":{"activity_log":3,"schedules":1}}\n'
    )

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(checkpoint_path),
        ],
    )

    assert result.exit_code == 0
    assert result.output == (
        "Agent: agent-1\n"
        "Schema version: 1\n"
        "Tables:\n"
        "  activity_log: 3\n"
        "  schedules: 1\n"
    )


def test_inspect_command_outputs_json_summary(tmp_path: Path) -> None:
    import json

    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint_path.write_text(
        '{"agent_id":"agent-1","schema_version":1,'
        '"tables":{"schedules":2}}\n'
    )

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(checkpoint_path),
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert json.loads(result.output) == {
        "agent_id": "agent-1",
        "schema_version": 1,
        "tables": {"schedules": 2},
    }


def test_inspect_command_returns_validation_exit_code_for_invalid_json(
    tmp_path: Path,
) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint_path.write_text("not valid json")

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(checkpoint_path),
        ],
    )

    assert result.exit_code == 2
    assert "Checkpoint is not valid JSON" in result.output


def test_inspect_command_returns_compatibility_exit_code_for_unsupported_schema(
    tmp_path: Path,
) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint_path.write_text(
        '{"agent_id":"agent-1","schema_version":999,"tables":{}}\n'
    )

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(checkpoint_path),
        ],
    )

    assert result.exit_code == 3
    assert "Unsupported checkpoint schema version" in result.output


def test_inspect_command_returns_io_exit_code_for_missing_file(
    tmp_path: Path,
) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    missing_path = tmp_path / "missing-checkpoint.json"

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(missing_path),
        ],
    )

    assert result.exit_code == 4
    assert "Unable to inspect checkpoint" in result.output


def test_repeated_export_replaces_output_deterministically(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("INSERT INTO schedules VALUES ('first')")
    connection.commit()
    connection.close()

    output = tmp_path / "checkpoint.json"
    runner = CliRunner()
    command = [
        "export",
        "--agent",
        "agent-1",
        "--output",
        str(output),
    ]

    first_result = runner.invoke(checkpoint, command)
    first_bytes = output.read_bytes()

    second_result = runner.invoke(checkpoint, command)
    second_bytes = output.read_bytes()

    assert first_result.exit_code == 0
    assert second_result.exit_code == 0
    assert second_bytes == first_bytes


def test_atomic_write_cleans_up_after_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os

    from talos_agent.checkpoint_cli import atomic_write

    output = tmp_path / "checkpoint.json"
    output.write_bytes(b"original")

    def interrupt_replace(source: object, destination: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(os, "replace", interrupt_replace)

    with pytest.raises(KeyboardInterrupt):
        atomic_write(output, b"replacement", max_size=1024)

    assert output.read_bytes() == b"original"
    assert list(tmp_path.glob(".checkpoint.json.*.tmp")) == []


def test_concurrent_atomic_writes_never_leave_partial_output(
    tmp_path: Path,
) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from talos_agent.checkpoint_cli import atomic_write

    output = tmp_path / "checkpoint.json"
    first = b'{"agent_id":"agent-1","schema_version":1,"tables":{"schedules":1}}\n'
    second = b'{"agent_id":"agent-1","schema_version":1,"tables":{"schedules":2}}\n'

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(atomic_write, output, first, 1024),
            executor.submit(atomic_write, output, second, 1024),
        ]
        for future in futures:
            future.result()

    assert output.read_bytes() in {first, second}
    assert list(tmp_path.glob(".checkpoint.json.*.tmp")) == []


def test_checkpoint_remains_inspectable_after_cli_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("INSERT INTO schedules VALUES ('first')")
    connection.commit()
    connection.close()

    output = tmp_path / "checkpoint.json"

    export_result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(output),
        ],
    )

    inspect_result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(output),
            "--json",
        ],
    )

    assert export_result.exit_code == 0
    assert inspect_result.exit_code == 0
    assert '"agent_id": "agent-1"' in inspect_result.output
    assert '"schedules": 1' in inspect_result.output


def test_export_does_not_modify_source_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.execute("INSERT INTO schedules VALUES ('first')")
    connection.commit()
    connection.close()

    original_bytes = database_path.read_bytes()
    original_mtime = database_path.stat().st_mtime_ns

    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(tmp_path / "checkpoint.json"),
        ],
    )

    assert result.exit_code == 0
    assert database_path.read_bytes() == original_bytes
    assert database_path.stat().st_mtime_ns == original_mtime


def test_export_command_enforces_max_size(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.commit()
    connection.close()

    output = tmp_path / "checkpoint.json"
    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(output),
            "--max-size",
            "10",
        ],
    )

    assert result.exit_code == 2
    assert "maximum allowed size" in result.output
    assert not output.exists()


def test_export_rejects_database_as_output_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.commit()
    connection.close()

    original_bytes = database_path.read_bytes()

    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(database_path),
        ],
    )

    assert result.exit_code == 2
    assert "must not overwrite the agent database" in result.output
    assert database_path.read_bytes() == original_bytes


def test_export_command_reports_access_denied(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from click.testing import CliRunner

    from talos_agent import checkpoint_cli

    def deny_access(path: Path) -> object:
        raise PermissionError("permission denied")

    monkeypatch.setattr(
        checkpoint_cli,
        "open_readonly_database",
        deny_access,
    )
    monkeypatch.setattr(
        "talos_agent.db.get_db_path",
        lambda agent_id: tmp_path / f"agent-{agent_id}.db",
    )

    result = CliRunner().invoke(
        checkpoint_cli.checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(tmp_path / "checkpoint.json"),
        ],
    )

    assert result.exit_code == 4
    assert "Checkpoint access denied" in result.output


def test_inspect_command_reports_access_denied(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from click.testing import CliRunner

    from talos_agent import checkpoint_cli

    def deny_read(path: Path, max_size: int) -> bytes:
        raise PermissionError("permission denied")

    monkeypatch.setattr(checkpoint_cli, "read_bounded", deny_read)

    result = CliRunner().invoke(
        checkpoint_cli.checkpoint,
        [
            "inspect",
            "--input",
            str(tmp_path / "checkpoint.json"),
        ],
    )

    assert result.exit_code == 4
    assert "Checkpoint access denied" in result.output


def test_inspect_command_enforces_max_size(tmp_path: Path) -> None:
    from click.testing import CliRunner

    from talos_agent.checkpoint_cli import checkpoint

    checkpoint_path = tmp_path / "checkpoint.json"
    checkpoint_path.write_text(
        '{"agent_id":"agent-1","schema_version":1,"tables":{}}\n'
    )

    result = CliRunner().invoke(
        checkpoint,
        [
            "inspect",
            "--input",
            str(checkpoint_path),
            "--max-size",
            "10",
        ],
    )

    assert result.exit_code == 2
    assert "maximum allowed size" in result.output


def test_failed_export_preserves_existing_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlite3

    from click.testing import CliRunner

    from talos_agent import db
    from talos_agent.checkpoint_cli import checkpoint

    monkeypatch.setattr(db, "APP_DIR", tmp_path)

    database_path = tmp_path / "agent-agent-1.db"
    connection = sqlite3.connect(database_path)
    connection.execute("CREATE TABLE schedules (task_name TEXT)")
    connection.commit()
    connection.close()

    output = tmp_path / "checkpoint.json"
    output.write_bytes(b"existing checkpoint")

    result = CliRunner().invoke(
        checkpoint,
        [
            "export",
            "--agent",
            "agent-1",
            "--output",
            str(output),
            "--max-size",
            "10",
        ],
    )

    assert result.exit_code == 2
    assert output.read_bytes() == b"existing checkpoint"
    assert list(tmp_path.glob(".checkpoint.json.*.tmp")) == []
