"""Focused coverage for preserving failed backup artifacts (#1452)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import talos_agent.backup_service as bs
from talos_agent.backup_service import (
    BackupError,
    build_backup,
    stream_encrypted_artifact,
    verify_backup,
)


PASSWORD = "correct horse battery staple"


def write_fake_sqlite_backup(_src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(dest) as conn:
        conn.execute("CREATE TABLE fixture (id INTEGER)")


def test_stream_failure_preserves_partial_as_incomplete(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    out = tmp_path / "backup.enc"

    # A non-string ciphertext triggers the precondition, but we want to hit
    # the write path and force a failure. Patch os.fsync to raise, which is a
    # realistic mid-write failure and leaves the tmp file on disk.
    real_fsync = bs.os.fsync
    def broken_fsync(fd):
        raise OSError("simulated disk failure during fsync")
    monkeypatch.setattr(bs.os, "fsync", broken_fsync)

    with pytest.raises(OSError):
        stream_encrypted_artifact("x" * 2048, out)

    incomplete = out.with_suffix(out.suffix + ".incomplete")
    assert incomplete.exists(), "partial must be preserved as .incomplete"
    assert not out.exists(), "no final .enc may land on a failed write"
    monkeypatch.setattr(bs.os, "fsync", real_fsync)


def test_build_backup_wraps_failure_as_incomplete_write(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    # Give collect_agent_files something to find so we reach the stream step.
    (tmp_path / "talos-agent.db").write_bytes(b"")
    monkeypatch.setattr(bs, "collect_agent_files", lambda agent_id=None: [tmp_path / "talos-agent.db"])
    # Patch _sqlite_hot_backup to a no-op write so we get to stream_encrypted_artifact.
    monkeypatch.setattr(bs, "_sqlite_hot_backup", write_fake_sqlite_backup)
    # Force the write failure inside stream_encrypted_artifact.
    def broken_stream(ciphertext, out_path, **kw):
        raise OSError("simulated write failure")
    monkeypatch.setattr(bs, "stream_encrypted_artifact", broken_stream)

    out = tmp_path / "artifact.enc"
    with pytest.raises(BackupError) as excinfo:
        build_backup(password=PASSWORD, out_path=out)
    assert excinfo.value.code == "INCOMPLETE_WRITE"
    assert "incomplete" in str(excinfo.value).lower()


def test_verify_refuses_incomplete_artifact(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    partial = tmp_path / "artifact.enc.incomplete"
    partial.write_text("not a real backup")

    with pytest.raises(BackupError) as excinfo:
        verify_backup(artifact_path=partial, password=PASSWORD)
    assert excinfo.value.code == "INCOMPLETE_WRITE"


def test_successful_backup_leaves_enc_and_no_incomplete(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    (tmp_path / "talos-agent.db").write_bytes(b"")
    monkeypatch.setattr(bs, "collect_agent_files", lambda agent_id=None: [tmp_path / "talos-agent.db"])
    monkeypatch.setattr(bs, "_sqlite_hot_backup", write_fake_sqlite_backup)

    out = tmp_path / "good.enc"
    build_backup(password=PASSWORD, out_path=out)

    assert out.exists(), "successful backup must produce the .enc"
    assert not (tmp_path / "good.enc.incomplete").exists(), "no .incomplete on success"
    # Verify still works on a real artifact.
    run = verify_backup(artifact_path=out, password=PASSWORD)
    assert run.scope == "agent"
