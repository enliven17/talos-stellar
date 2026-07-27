"""CLI helpers for exporting and inspecting portable checkpoints."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
from enum import IntEnum
from pathlib import Path
from threading import Lock

import click

from talos_agent.state_classify import (
    StateCategory,
    registered_classification,
)

DEFAULT_MAX_SIZE = 10 * 1024 * 1024
SUPPORTED_SCHEMA_VERSIONS = {1}
_AGENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_ATOMIC_WRITE_LOCKS_GUARD = Lock()
_ATOMIC_WRITE_LOCKS: dict[str, Lock] = {}

_CHECKPOINT_TABLES = (
    "schedules",
    "activity_log",
    "content_history",
    "commerce_queue",
    "approval_cache",
    "spending_log",
    "talos_config",
    "playbooks",
    "content_performance",
    "strategy_learnings",
    "audience_insights",
    "loans",
    "loan_repayments",
    "dividends_log",
    "retry_state",
)


class CheckpointExitCode(IntEnum):
    """Stable process exit codes for checkpoint commands."""

    SUCCESS = 0
    VALIDATION_ERROR = 2
    COMPATIBILITY_ERROR = 3
    IO_ERROR = 4


def validate_agent_id(agent_id: str) -> str:
    """Return a valid agent ID or raise ValueError."""

    normalized = agent_id.strip()
    if not _AGENT_ID_PATTERN.fullmatch(normalized):
        raise ValueError(
            "Agent ID must contain only letters, numbers, underscores, or hyphens "
            "and be no more than 128 characters."
        )
    return normalized


def validate_size_limit(max_size: int) -> int:
    """Return a positive checkpoint size limit or raise ValueError."""

    if max_size <= 0:
        raise ValueError("Maximum checkpoint size must be greater than zero.")
    return max_size


def _atomic_write_lock(destination: Path) -> Lock:
    """Return a process-local lock for one checkpoint destination."""

    destination_key = os.path.normcase(str(destination.resolve()))
    with _ATOMIC_WRITE_LOCKS_GUARD:
        return _ATOMIC_WRITE_LOCKS.setdefault(destination_key, Lock())


def atomic_write(output_path: Path, data: bytes, max_size: int) -> None:
    """Write checkpoint bytes atomically without leaving partial output."""

    size_limit = validate_size_limit(max_size)
    if len(data) > size_limit:
        raise ValueError("Checkpoint exceeds the maximum allowed size.")

    destination = Path(output_path)
    temporary_path: Path | None = None

    with _atomic_write_lock(destination):
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                temporary_file.write(data)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())

            os.replace(temporary_path, destination)
            temporary_path = None
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)



def open_readonly_database(path: Path) -> sqlite3.Connection:
    """Open an existing SQLite database without creating or modifying it."""

    database_path = Path(path)
    connection = sqlite3.connect(
        f"{database_path.resolve().as_uri()}?mode=ro",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection



def summarize_database(connection: sqlite3.Connection) -> dict[str, int]:
    """Return row counts for recognised tables without exposing row values."""

    existing_tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }

    return {
        table_name: connection.execute(
            f'SELECT COUNT(*) FROM "{table_name}"'
        ).fetchone()[0]
        for table_name in _CHECKPOINT_TABLES
        if table_name in existing_tables
    }


def read_bounded(path: Path, max_size: int) -> bytes:
    """Read a checkpoint without exceeding the configured size limit."""

    size_limit = validate_size_limit(max_size)

    with Path(path).open("rb") as checkpoint_file:
        data = checkpoint_file.read(size_limit + 1)

    if len(data) > size_limit:
        raise ValueError("Checkpoint exceeds the maximum allowed size.")

    return data


def parse_checkpoint(data: bytes) -> dict[str, object]:
    """Parse checkpoint JSON and require a top-level object."""

    try:
        checkpoint = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Checkpoint is not valid JSON.") from exc

    if not isinstance(checkpoint, dict):
        raise ValueError("Checkpoint must contain a top-level JSON object.")

    return checkpoint



@click.group()
def checkpoint() -> None:
    """Export and inspect portable agent checkpoints."""


def validate_schema_version(schema_version: int) -> int:
    """Return a positive schema version or raise ValueError."""

    if schema_version <= 0:
        raise ValueError("Schema version must be greater than zero.")
    return schema_version


class CheckpointCompatibilityError(ValueError):
    """Raised when a checkpoint schema version is unsupported."""


def ensure_compatible_schema_version(
    schema_version: int,
    supported_versions: set[int],
) -> int:
    """Return the schema version when supported."""

    validated_version = validate_schema_version(schema_version)
    if validated_version not in supported_versions:
        raise CheckpointCompatibilityError(
            f"Unsupported checkpoint schema version: {validated_version}."
        )
    return validated_version


class CheckpointCLIError(click.ClickException):
    """CLI error with a stable checkpoint-specific exit code."""

    def __init__(self, message: str, exit_code: CheckpointExitCode) -> None:
        super().__init__(message)
        self.exit_code = int(exit_code)


def build_checkpoint_payload(
    agent_id: str,
    schema_version: int,
    table_counts: dict[str, int],
) -> dict[str, object]:
    """Build a checkpoint payload containing only non-sensitive metadata."""

    return {
        "schema_version": validate_schema_version(schema_version),
        "agent_id": validate_agent_id(agent_id),
        "tables": dict(sorted(table_counts.items())),
    }


def encode_checkpoint(payload: dict[str, object]) -> bytes:
    """Encode a checkpoint deterministically as UTF-8 JSON."""

    return (
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        + "\n"
    ).encode("utf-8")


def create_checkpoint_from_database(
    database_path: Path,
    agent_id: str,
    schema_version: int,
) -> dict[str, object]:
    """Create a safe checkpoint payload from an existing database.

    Validates that every table in the checkpoint has a registered
    classification and that no FORBIDDEN tables are included.
    """

    connection = open_readonly_database(database_path)
    try:
        connection.execute("BEGIN")
        table_counts = summarize_database(connection)
        # ── Classification guard ──────────────────────────────────────────
        for table_name in table_counts:
            cls_ = registered_classification(table_name)
            if cls_ is None:
                raise ValueError(
                    f"Table {table_name!r} has no registered state classification. "
                    f"Register it via state_classifications.py before exporting."
                )
            if cls_.category is StateCategory.FORBIDDEN:
                raise ValueError(
                    f"Table {table_name!r} is classified as FORBIDDEN "
                    f"and must not be included in checkpoints."
                )
        connection.rollback()
    finally:
        connection.close()

    return build_checkpoint_payload(
        agent_id=agent_id,
        schema_version=schema_version,
        table_counts=table_counts,
    )


@checkpoint.command("export")
@click.option("--agent", "agent_id", required=True, help="Agent ID to export.")
@click.option(
    "--output",
    type=click.Path(path_type=Path, dir_okay=False),
    required=True,
    help="Checkpoint output file.",
)
@click.option(
    "--schema-version",
    type=int,
    default=1,
    show_default=True,
    help="Checkpoint schema version.",
)
@click.option(
    "--max-size",
    type=int,
    default=DEFAULT_MAX_SIZE,
    show_default=True,
    help="Maximum checkpoint size in bytes.",
)
def export_checkpoint(
    agent_id: str,
    output: Path,
    schema_version: int,
    max_size: int,
) -> None:
    """Export a safe checkpoint without mutating agent state."""

    from talos_agent.db import get_db_path

    try:
        validated_agent_id = validate_agent_id(agent_id)
        validated_schema_version = ensure_compatible_schema_version(
            schema_version,
            SUPPORTED_SCHEMA_VERSIONS,
        )
        validate_size_limit(max_size)

        database_path = get_db_path(validated_agent_id)
        ensure_distinct_paths(database_path, output)

        payload = create_checkpoint_from_database(
            database_path=database_path,
            agent_id=validated_agent_id,
            schema_version=validated_schema_version,
        )
        encoded = encode_checkpoint(payload)
        atomic_write(output, encoded, max_size)
    except CheckpointCompatibilityError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.COMPATIBILITY_ERROR,
        ) from exc
    except ValueError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.VALIDATION_ERROR,
        ) from exc
    except PermissionError as exc:
        raise CheckpointCLIError(
            f"Checkpoint access denied: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc
    except (OSError, sqlite3.Error) as exc:
        raise CheckpointCLIError(
            f"Unable to export checkpoint: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc

    click.echo(f"Checkpoint exported to {output}")


def validate_checkpoint_payload(
    payload: dict[str, object],
) -> dict[str, object]:
    """Validate checkpoint metadata before inspection."""

    schema_version = payload.get("schema_version")
    if isinstance(schema_version, bool) or not isinstance(schema_version, int):
        raise ValueError("Checkpoint schema_version must be an integer.")

    ensure_compatible_schema_version(
        schema_version,
        SUPPORTED_SCHEMA_VERSIONS,
    )

    agent_id = payload.get("agent_id")
    if not isinstance(agent_id, str):
        raise ValueError("Checkpoint agent_id must be a string.")

    tables = payload.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Checkpoint tables must be a JSON object.")

    validated_tables: dict[str, int] = {}
    for table_name, row_count in tables.items():
        if not isinstance(table_name, str):
            raise ValueError("Checkpoint table names must be strings.")
        if table_name not in _CHECKPOINT_TABLES:
            raise ValueError(f"Checkpoint contains an unknown table: {table_name}.")
        if (
            isinstance(row_count, bool)
            or not isinstance(row_count, int)
            or row_count < 0
        ):
            raise ValueError(
                f"Checkpoint row count for {table_name!r} must be "
                "a non-negative integer."
            )
        validated_tables[table_name] = row_count

    return {
        "schema_version": schema_version,
        "agent_id": validate_agent_id(agent_id),
        "tables": dict(sorted(validated_tables.items())),
    }


def format_checkpoint_summary(
    checkpoint_data: dict[str, object],
    *,
    as_json: bool,
) -> str:
    """Format validated checkpoint metadata for human or JSON output."""

    validated = validate_checkpoint_payload(checkpoint_data)

    if as_json:
        return json.dumps(validated, indent=2, sort_keys=True)

    tables = validated["tables"]
    assert isinstance(tables, dict)

    lines = [
        f"Agent: {validated['agent_id']}",
        f"Schema version: {validated['schema_version']}",
        "Tables:",
    ]

    if tables:
        lines.extend(
            f"  {table_name}: {row_count}"
            for table_name, row_count in tables.items()
        )
    else:
        lines.append("  none")

    return "\n".join(lines)


@checkpoint.command("inspect")
@click.option(
    "--input",
    "input_path",
    type=click.Path(path_type=Path, dir_okay=False),
    required=True,
    help="Checkpoint file to inspect.",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output the summary as JSON.",
)
@click.option(
    "--max-size",
    type=int,
    default=DEFAULT_MAX_SIZE,
    show_default=True,
    help="Maximum checkpoint size in bytes.",
)
def inspect_checkpoint(
    input_path: Path,
    as_json: bool,
    max_size: int,
) -> None:
    """Inspect checkpoint metadata without exposing sensitive values."""

    try:
        validate_size_limit(max_size)
        checkpoint_data = parse_checkpoint(
            read_bounded(input_path, max_size),
        )
        output = format_checkpoint_summary(
            checkpoint_data,
            as_json=as_json,
        )
    except CheckpointCompatibilityError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.COMPATIBILITY_ERROR,
        ) from exc
    except ValueError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.VALIDATION_ERROR,
        ) from exc
    except PermissionError as exc:
        raise CheckpointCLIError(
            f"Checkpoint access denied: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc
    except (OSError, sqlite3.Error) as exc:
        raise CheckpointCLIError(
            f"Unable to inspect checkpoint: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc

    click.echo(output)


def ensure_distinct_paths(source_path: Path, output_path: Path) -> None:
    """Reject an output path that resolves to the source database."""

    if Path(source_path).resolve() == Path(output_path).resolve():
        raise ValueError("Checkpoint output must not overwrite the agent database.")


@checkpoint.command("restore")
@click.option(
    "--input",
    "input_path",
    type=click.Path(path_type=Path, dir_okay=False, exists=True),
    required=True,
    help="Checkpoint file to restore.",
)
@click.option(
    "--agent",
    "agent_id",
    required=True,
    help="Agent ID to restore into.",
)
@click.option(
    "--schema-version",
    type=int,
    default=1,
    show_default=True,
    help="Expected checkpoint schema version.",
)
@click.option(
    "--max-size",
    type=int,
    default=DEFAULT_MAX_SIZE,
    show_default=True,
    help="Maximum checkpoint size in bytes.",
)
@click.option(
    "--no-verify-invariants",
    is_flag=True,
    help="Skip invariant checks.",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output the restore summary as JSON.",
)
def restore_checkpoint(
    input_path: Path,
    agent_id: str,
    schema_version: int,
    max_size: int,
    no_verify_invariants: bool,
    as_json: bool,
) -> None:
    """Restore agent state through transactional staging, validation, and rollback safety."""

    from talos_agent.db import get_db_path
    from talos_agent.restore import (
        InvariantError,
        PreflightError,
        RollbackError,
        StagedRestoreConfig,
        StagingError,
        perform_staged_restore_sync,
    )

    try:
        validated_agent_id = validate_agent_id(agent_id)
        validated_schema_version = ensure_compatible_schema_version(
            schema_version,
            SUPPORTED_SCHEMA_VERSIONS,
        )
        validate_size_limit(max_size)

        database_path = get_db_path(validated_agent_id)
        ensure_distinct_paths(input_path, database_path)

        cfg = StagedRestoreConfig(
            max_size_bytes=max_size,
            allowed_schema_versions={validated_schema_version},
            require_agent_match=True,
            verify_invariants=not no_verify_invariants,
        )

        res = perform_staged_restore_sync(
            target_db_path=database_path,
            checkpoint_input=input_path,
            agent_id=validated_agent_id,
            config=cfg,
        )

        if as_json:
            output_dict = {
                "agent_id": res.agent_id,
                "schema_version": res.schema_version,
                "tables_restored": res.tables_restored,
                "committed": res.committed,
                "preflight_passed": res.preflight_passed,
                "invariants_passed": res.invariants_passed,
                "duration_ms": res.duration_ms,
            }
            click.echo(json.dumps(output_dict, indent=2))
        else:
            click.echo(f"Successfully restored checkpoint for agent '{validated_agent_id}' in {res.duration_ms}ms")
            click.echo("Tables restored:")
            if res.tables_restored:
                for tbl, cnt in res.tables_restored.items():
                    click.echo(f"  {tbl}: {cnt}")
            else:
                click.echo("  none")

    except CheckpointCompatibilityError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.COMPATIBILITY_ERROR,
        ) from exc
    except PreflightError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.VALIDATION_ERROR,
        ) from exc
    except (StagingError, InvariantError, RollbackError, PermissionError, OSError, sqlite3.Error) as exc:
        raise CheckpointCLIError(
            f"Restore failed: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc
    except ValueError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.VALIDATION_ERROR,
        ) from exc


@checkpoint.command("drill")
@click.option(
    "--scenarios",
    "scenarios",
    default="all",
    show_default=True,
    help="Comma-separated list of scenarios to run, or 'all'.",
)
@click.option(
    "--schema-versions",
    "schema_versions_str",
    default="1",
    show_default=True,
    help="Comma-separated list of schema versions to test for migration compatibility.",
)
@click.option(
    "--output-dir",
    type=click.Path(path_type=Path, file_okay=False),
    default=None,
    help="Directory for drill reports. Default: ~/.talos-agent/drill_reports.",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output the full drill report as JSON to stdout.",
)
def drill_checkpoint(
    scenarios: str,
    schema_versions_str: str,
    output_dir: Path | None,
    as_json: bool,
) -> None:
    """Run automated restore drills and publish a bounded report.

    Exercises the full checkpoint/restore pipeline with synthetic state and
    ephemeral keys.  Safe to run at any time — it never touches real data.

    Available scenarios:

    \b
    - normal_roundtrip       Seal & open with correct identity
    - key_rotation           Old envelopes readable after key rotation
    - migration              Cross-schema-version compatibility
    - corruption             Tampered ciphertext/HMAC/AAD detection
    - wrong_identity         Rejection of mismatched agent_id
    - rollback               Stale sequence rejection (open_latest)
    - scheduler_no_duplicate_effects   Scheduler idempotency after restore
    """
    from talos_agent.restore_drill import (
        _DEFAULT_DRILL_DIR,
        ALL_SCENARIOS,
        DrillConfig,
        run_restore_drill_sync,
        write_drill_report,
    )

    try:
        # Parse scenarios
        if scenarios.strip().lower() == "all":
            selected = set(ALL_SCENARIOS)
        else:
            selected = {s.strip() for s in scenarios.split(",") if s.strip()}
            unknown = selected - ALL_SCENARIOS
            if unknown:
                raise CheckpointCLIError(
                    f"Unknown scenario(s): {', '.join(sorted(unknown))}. "
                    f"Available: {', '.join(sorted(ALL_SCENARIOS))}",
                    CheckpointExitCode.VALIDATION_ERROR,
                )

        # Parse schema versions
        schema_versions: set[int] = set()
        for sv in schema_versions_str.split(","):
            sv_clean = sv.strip()
            if not sv_clean:
                continue
            try:
                schema_versions.add(int(sv_clean))
            except ValueError:
                raise CheckpointCLIError(
                    f"Invalid schema version: {sv_clean!r}",
                    CheckpointExitCode.VALIDATION_ERROR,
                )

        config = DrillConfig(
            scenarios=selected,
            schema_versions=schema_versions,
            report_dir=output_dir if output_dir else _DEFAULT_DRILL_DIR,
        )

        report = run_restore_drill_sync(config=config)

        # Always persist to disk
        report_path = write_drill_report(report, report_dir=config.report_dir)

        if as_json:
            import json
            click.echo(json.dumps({
                "timestamp": report.timestamp,
                "total": report.total,
                "passed": report.passed,
                "failed": report.failed,
                "duration_ms": report.duration_ms,
                "report_path": str(report_path),
                "scenarios": [
                    {
                        "scenario": s.scenario,
                        "passed": s.passed,
                        "duration_ms": s.duration_ms,
                        "detail": s.detail,
                        "error": s.error,
                    }
                    for s in report.scenarios
                ],
            }, indent=2))
        else:
            click.echo(f"Restore drill complete: {report.passed}/{report.total} passed in {report.duration_ms}ms")
            click.echo(f"Report saved to {report_path}")
            if report.failed > 0:
                click.echo()
                click.echo("Failures:")
                for s in report.scenarios:
                    if not s.passed:
                        click.echo(f"  [FAIL] {s.scenario}: {s.error or s.detail}")

        if report.failed > 0:
            raise SystemExit(1)

    except CheckpointCLIError:
        raise
    except ValueError as exc:
        raise CheckpointCLIError(
            str(exc),
            CheckpointExitCode.VALIDATION_ERROR,
        ) from exc
    except (OSError, sqlite3.Error) as exc:
        raise CheckpointCLIError(
            f"Drill failed: {exc}",
            CheckpointExitCode.IO_ERROR,
        ) from exc

