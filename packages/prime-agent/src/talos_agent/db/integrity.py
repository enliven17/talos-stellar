"""Read-only integrity and schema checks for per-agent SQLite databases."""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import quote

from talos_agent.config import APP_DIR
from talos_agent.db.migrations import _MIGRATIONS


@dataclass(frozen=True)
class AgentIntegrityReport:
    """Privacy-safe result for one agent database."""

    agent_id: str
    path: str
    status: str
    schema_version: int | None = None
    quick_check: str | None = None
    foreign_key_errors: int = 0
    missing_tables: tuple[str, ...] = ()
    missing_columns: tuple[str, ...] = ()
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


_REQUIRED_COLUMNS: dict[str, tuple[str, ...]] = {
    "schedules": ("task_name", "last_run_at"),
    "talos_config": ("key", "value"),
    "activity_log": ("id", "type", "content", "channel", "status"),
    "content_history": ("id", "content", "channel"),
    "commerce_queue": ("id", "job_id", "talos_id", "service_type", "status"),
    "approval_cache": ("id", "approval_id", "status"),
    "spending_log": ("id", "amount", "currency", "category"),
    "playbooks": ("id", "name", "data"),
}


def _latest_schema_version() -> int:
    return max(version for version, _ in _MIGRATIONS)


def discover_agent_databases(directory: Path = APP_DIR) -> list[Path]:
    """Return the default DB and per-agent DBs, without following symlinks."""
    if not directory.is_dir():
        return []
    paths: list[Path] = []
    default = directory / "talos-agent.db"
    if default.is_file() and not default.is_symlink():
        paths.append(default)
    paths.extend(path for path in sorted(directory.glob("agent-*.db")) if path.is_file() and not path.is_symlink())
    return paths


def _agent_id(path: Path) -> str:
    if path.name == "talos-agent.db":
        return "default"
    return path.stem.removeprefix("agent-") or "unknown"


def check_agent_database(path: Path) -> AgentIntegrityReport:
    """Run bounded, read-only SQLite checks for *path*."""
    path = path.resolve()
    agent_id = _agent_id(path)
    uri = f"file:{quote(str(path), safe='/')}?mode=ro"
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        quick = str(conn.execute("PRAGMA quick_check").fetchone()[0])
        fk_errors = len(conn.execute("PRAGMA foreign_key_check").fetchall())
        schema_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")}
        missing_tables = tuple(sorted(set(_REQUIRED_COLUMNS) - tables))
        missing_columns: list[str] = []
        for table, required in _REQUIRED_COLUMNS.items():
            if table not in tables:
                continue
            columns = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
            missing_columns.extend(f"{table}.{column}" for column in set(required) - columns)

        healthy = quick.lower() == "ok" and fk_errors == 0 and not missing_tables and not missing_columns and schema_version >= _latest_schema_version()
        return AgentIntegrityReport(
            agent_id=agent_id,
            path=str(path),
            status="healthy" if healthy else "degraded",
            schema_version=schema_version,
            quick_check=quick,
            foreign_key_errors=fk_errors,
            missing_tables=missing_tables,
            missing_columns=tuple(sorted(missing_columns)),
            error=(f"schema version {schema_version} is older than {_latest_schema_version()}" if schema_version < _latest_schema_version() else None),
        )
    except (OSError, sqlite3.Error) as exc:
        return AgentIntegrityReport(agent_id=agent_id, path=str(path), status="error", error=f"{type(exc).__name__}: {exc}")
    finally:
        if conn is not None:
            conn.close()


def check_agent_databases(directory: Path = APP_DIR) -> list[AgentIntegrityReport]:
    """Check every discovered database, continuing after individual failures."""
    return [check_agent_database(path) for path in discover_agent_databases(directory)]


__all__ = ["AgentIntegrityReport", "check_agent_database", "check_agent_databases", "discover_agent_databases"]
