"""Focused coverage for the verified restore staging path (#1448).

The restore flow must stage artifact databases away from live state, validate
SQLite integrity, required schema, schema version and agent identity, and only
then atomically replace the active database. A rejected candidate must leave
the active database byte-for-byte untouched.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from talos_agent import backup_service as bs
from talos_agent.backup_service import BackupError, restore_backup
from talos_agent.crypto import encrypt_with_password
from talos_agent.db import LocalDB

PASSWORD = "restore-staging-passphrase"


def _make_db(
    path: Path,
    *,
    schedule: str = "existing_task",
    agent_id: str | None = None,
    user_version: int | None = None,
) -> None:
    db = LocalDB(path=path)
    db._conn.execute(
        "INSERT OR REPLACE INTO schedules (task_name, last_run_at) VALUES (?, ?)",
        (schedule, "2026-01-01T00:00:00Z"),
    )
    if agent_id is not None:
        db.set_config("agent_id", agent_id)
    if user_version is not None:
        db._conn.execute(f"PRAGMA user_version = {int(user_version)}")
    db._conn.commit()
    db.close()


def _artifact(out_path: Path, files: dict[str, bytes], password: str = PASSWORD) -> Path:
    """Write a wire-compatible encrypted backup artifact for restore tests."""
    files_meta = {
        name: {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size_bytes": len(data),
        }
        for name, data in files.items()
    }
    body = {
        name: base64.b64encode(data).decode("ascii")
        for name, data in files.items()
    }
    manifest_inner = {
        "encryption": bs.BACKUP_ENCRYPTION_LABEL,
        "files": files_meta,
        "rowCountsSqlite": {},
        "scope": "agent",
        "schemaVersion": 3,
    }
    payload = {
        "version": bs.BACKUP_FORMAT_VERSION,
        "encryption": bs.BACKUP_ENCRYPTION_LABEL,
        "scope": "agent",
        "timestamp": "2026-01-01T00:00:00+00:00",
        "database": {},
        "filesMeta": files_meta,
        "body": body,
        "manifest": {
            "sha256": hashlib.sha256(
                json.dumps(manifest_inner, sort_keys=True).encode("utf8")
            ).hexdigest(),
            "rowCountTotal": 0,
            "encryption": bs.BACKUP_ENCRYPTION_LABEL,
            "formatVersion": bs.BACKUP_FORMAT_VERSION,
            "size_bytes": 0,
        },
    }
    plaintext = json.dumps(payload, sort_keys=True)
    out_path.write_text(encrypt_with_password(plaintext, password), encoding="utf8")
    return out_path


@pytest.fixture
def restore_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.migrations.APP_DIR", tmp_path)
    return tmp_path


def _task_names(db_path: Path) -> set[str]:
    conn = sqlite3.connect(str(db_path))
    try:
        return {
            str(row[0])
            for row in conn.execute("SELECT task_name FROM schedules").fetchall()
        }
    finally:
        conn.close()


def test_restore_validates_candidate_then_swaps(restore_root: Path) -> None:
    source = restore_root / "source-agent-a.db"
    _make_db(source, schedule="restored_task", agent_id="a")
    artifact = _artifact(
        restore_root / "backup.enc", {"db/agent-a.db": source.read_bytes()}
    )

    active = restore_root / "agent-a.db"
    _make_db(active, schedule="active_task", agent_id="a")

    restore_backup(
        artifact_path=artifact,
        password=PASSWORD,
        confirm=True,
        agent_id="a",
    )

    assert _task_names(active) == {"restored_task"}
    assert (restore_root / "agent-a.db.pre-restore").exists()
    assert not list(restore_root.glob(".restore-candidate-*"))


def test_restore_rejects_corrupt_candidate_without_touching_active_db(
    restore_root: Path,
) -> None:
    active = restore_root / "talos-agent.db"
    _make_db(active, schedule="active_task")
    before = active.read_bytes()
    artifact = _artifact(
        restore_root / "corrupt.enc",
        {"db/talos-agent.db": b"this is not a sqlite database"},
    )

    with pytest.raises(BackupError) as exc_info:
        restore_backup(artifact_path=artifact, password=PASSWORD, confirm=True)

    assert exc_info.value.code == "CORRUPT_DB"
    assert active.read_bytes() == before
    assert not (restore_root / "talos-agent.db.pre-restore").exists()
    assert not list(restore_root.glob(".restore-candidate-*"))


def test_restore_rejects_newer_schema_without_touching_active_db(
    restore_root: Path,
) -> None:
    source = restore_root / "source.db"
    _make_db(source, user_version=9999)
    artifact = _artifact(
        restore_root / "newer-schema.enc", {"db/talos-agent.db": source.read_bytes()}
    )

    active = restore_root / "talos-agent.db"
    _make_db(active, schedule="active_task")
    before = active.read_bytes()

    with pytest.raises(BackupError) as exc_info:
        restore_backup(artifact_path=artifact, password=PASSWORD, confirm=True)

    assert exc_info.value.code == "SCHEMA_MISMATCH"
    assert active.read_bytes() == before


def test_restore_rejects_artifact_filename_identity_mismatch(
    restore_root: Path,
) -> None:
    source = restore_root / "source-agent-a.db"
    _make_db(source, agent_id="a")
    artifact = _artifact(
        restore_root / "wrong-agent.enc", {"db/agent-a.db": source.read_bytes()}
    )

    with pytest.raises(BackupError) as exc_info:
        restore_backup(
            artifact_path=artifact,
            password=PASSWORD,
            confirm=True,
            agent_id="b",
        )

    assert exc_info.value.code == "IDENTITY_MISMATCH"
    assert not (restore_root / "agent-b.db").exists()


def test_restore_rejects_in_database_identity_mismatch(
    restore_root: Path,
) -> None:
    source = restore_root / "source.db"
    _make_db(source, agent_id="a")
    artifact = _artifact(
        restore_root / "generic-name.enc", {"db/talos-agent.db": source.read_bytes()}
    )

    with pytest.raises(BackupError) as exc_info:
        restore_backup(
            artifact_path=artifact,
            password=PASSWORD,
            confirm=True,
            agent_id="b",
        )

    assert exc_info.value.code == "IDENTITY_MISMATCH"
    assert not (restore_root / "agent-b.db").exists()


def test_restore_allows_legacy_artifact_without_stamped_identity(
    restore_root: Path,
) -> None:
    """Backups created before agent identity was stamped remain restorable."""
    source = restore_root / "legacy-source.db"
    _make_db(source, schedule="legacy_task")
    artifact = _artifact(
        restore_root / "legacy.enc", {"db/agent-a.db": source.read_bytes()}
    )

    restore_backup(
        artifact_path=artifact,
        password=PASSWORD,
        confirm=True,
        agent_id="a",
    )

    assert _task_names(restore_root / "agent-a.db") == {"legacy_task"}
