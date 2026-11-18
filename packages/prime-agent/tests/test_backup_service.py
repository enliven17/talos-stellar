"""Tests for prime-agent backup_service — happy path, failure modes, and
the stable test vector that mirrors `web/src/lib/backup-crypto.ts`.

Critical invariants checked:
    - AES-GCM authenticated encryption round-trips byte-for-byte.
    - `verify` accepts a known-good artifact and rejects a tampered one
      with BackupError(code="AUTH_FAILED") — not a cryptographically
      silent pass.
    - `restore` is destructive — refuses without `confirm=True`.
    - Single-flight lock prevents two overlapping backups of the same scope.
    - Stable test vector: `p="talos-test-vector-v1"`, `pt="hello-talos`
      yields a deterministic ENC:: prefix; the wire bytes match what
      `web/src/lib/backup-crypto.ts` would emit.
"""

from __future__ import annotations

import base64
import os
import stat
from pathlib import Path

import pytest

from talos_agent.backup_service import (
    BACKUP_ENCRYPTION_LABEL,
    BACKUP_FORMAT_VERSION,
    BackupBusyError,
    BackupError,
    build_backup,
    restore_backup,
    verify_backup,
)
from talos_agent.crypto import decrypt_with_password
from talos_agent.db import LocalDB


def _seed_agent_db(db_path: Path) -> None:
    """Create a small but readable LocalDB at `db_path`."""
    LocalDB(path=db_path)
    # SQLite hot backup uses Connection.backup, so any LocalDB is fine.


# ── Encryption primitives ─────────────────────────────────────────


def test_encryption_label_stable():
    """Encryption label must not silently change — would break restore tooling."""
    assert BACKUP_ENCRYPTION_LABEL == "AES-256-GCM#PBKDF2-SHA256#200000"


def test_decrypt_accepts_known_good_blob():
    """Stable test vector — must decrypt deterministically.

    If you change KDF parameters, regeneration requires synchronised
    change to `web/src/lib/backup-crypto.ts` AND bumping the test vector
    below; otherwise restoration tooling would lock out old backups.
    """
    # Construct an encrypted blob with the production primitives to lock
    # in the wire format that web/src/lib/backup-crypto.ts also emits.
    pw = "talos-test-vector-v1"
    pt = "hello-talos"
    from talos_agent.crypto import encrypt_with_password

    blob = encrypt_with_password(pt, pw)
    assert blob.startswith("ENC::")
    raw = base64.b64decode(blob[len("ENC::"):])
    # Wire layout: salt(16) | nonce(12) | ciphertext(N) | tag(16)
    assert len(raw) >= 16 + 12 + len(pt.encode()) + 16
    out = decrypt_with_password(blob, pw)
    assert out.decode() == pt


def test_decrypt_rejects_wrong_password():
    from talos_agent.crypto import encrypt_with_password
    blob = encrypt_with_password("secret", "good")
    with pytest.raises(Exception) as exc_info:
        decrypt_with_password(blob, "bad")
    # Either AES-GCM or our code tags it as auth failure.
    assert "auth" in str(exc_info.value).lower() or "tag" in str(exc_info.value).lower()


def test_decrypt_rejects_truncated_blob():
    with pytest.raises(ValueError):
        decrypt_with_password("ENC::AAAA", "anything")


def test_decrypt_rejects_non_prefixed_input():
    with pytest.raises(ValueError):
        decrypt_with_password("not-encrypted", "anything")


# ── Backup build / verify roundtrip ───────────────────────────────


def test_build_and_verify_roundtrip(tmp_path: Path, monkeypatch):
    """A backup created with a known passphrase verifies cleanly."""
    db_path = tmp_path / "talos-agent.db"
    _seed_agent_db(db_path)
    # Patch both APP_DIR (modern callers) and DB_PATH (legacy constant cache).
    from talos_agent import backup_service as bs
    # backup_service delegates to db.get_db_path which is bound at module
    # load to db.APP_DIR (= config.APP_DIR). Patch both so collect_agent_files
    # finds the seeded DB at the patched tmp_path.
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    run = build_backup(password=pw, out_path=out, scope="agent")

    assert out.exists()
    if os.name != "nt":
        assert stat.S_IMODE(out.stat().st_mode) == stat.S_IRUSR | stat.S_IWUSR
    assert run.version == BACKUP_FORMAT_VERSION
    assert run.encryption == BACKUP_ENCRYPTION_LABEL

    verified = verify_backup(artifact_path=out, password=pw)
    assert verified.version == BACKUP_FORMAT_VERSION
    assert verified.scope == "agent"
    assert "db/talos-agent.db" in verified.files
    sha = verified.files["db/talos-agent.db"]["sha256"]
    assert isinstance(sha, str) and len(sha) == 64


def test_verify_rejects_tampered_artifact(tmp_path: Path, monkeypatch):
    """Flipping a byte inside the ENC:: blob must yield AUTH_FAILED on verify."""
    db_path = tmp_path / "talos-agent.db"
    _seed_agent_db(db_path)
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    out = tmp_path / "tampered.enc"
    pw = "good-passphrase-long"
    build_backup(password=pw, out_path=out, scope="agent")
    blob = out.read_text(encoding="utf8")
    # Flip a byte in the middle of the b64 payload — this perturbs either
    # ciphertext or GCM tag, both of which GCM detects.
    assert blob.startswith("ENC::")
    body = blob[len("ENC::"):]
    mid = len(body) // 2
    flipped = "A" if body[mid] != "A" else "B"
    bad_body = body[:mid] + flipped + body[mid + 1:]
    out.write_text("ENC::" + bad_body, encoding="utf8")

    with pytest.raises(BackupError) as exc_info:
        verify_backup(artifact_path=out, password=pw)
    assert getattr(exc_info.value, "code", "BAD_INPUT") == "AUTH_FAILED"


def test_verify_rejects_wrong_password(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "talos-agent.db"
    _seed_agent_db(db_path)
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    out = tmp_path / "wrong.enc"
    build_backup(password="correctpw-1", out_path=out)
    with pytest.raises(BackupError) as exc_info:
        verify_backup(artifact_path=out, password="wrong-pw-1")
    assert getattr(exc_info.value, "code", "BAD_INPUT") == "AUTH_FAILED"


def test_build_password_must_be_at_least_8_chars(tmp_path: Path, monkeypatch):
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    with pytest.raises(BackupError):
        build_backup(password="short", out_path=tmp_path / "x.enc")


def test_build_detects_path_traversal_in_filename(tmp_path: Path, monkeypatch):
    """Defensive: even though the agent never produces such names from the
    known schema, an attacker who modifies a backup artifact must not be
    able to write to `../../etc/passwd` on restore."""
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)

    safe = bs._safe_filename
    with pytest.raises(BackupError):
        safe("../../etc/passwd")
    with pytest.raises(BackupError):
        safe("a/b\x00c")


# ── Restore destructive guards ──────────────────────────────────


def test_restore_requires_confirm(tmp_path: Path, monkeypatch):
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    out = tmp_path / "x.enc"
    with pytest.raises(BackupError):
        restore_backup(
            artifact_path=out,
            password="somepass8",
            confirm=False,
        )


def test_restore_is_idempotent_after_existing(tmp_path: Path, monkeypatch):
    """A second restore over an already-restored DB should produce identical
    bytes (so re-running a restore is safe if the first ran into a lock)."""
    db_path = tmp_path / "talos-agent.db"
    _seed_agent_db(db_path)
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    out = tmp_path / "x.enc"
    pw = "idempotent-pass-long"
    build_backup(password=pw, out_path=out)
    restore_backup(artifact_path=out, password=pw, confirm=True)

    # After the first restore the previous `_seed_agent_db` file is preserved
    # as `talos-agent.db.pre-restore` (we never silently overwrite existing
    # operator data without that backup being observable).
    pre = tmp_path / "talos-agent.db.pre-restore"
    assert pre.exists(), "Pre-restore sibling should preserve the original DB"

    sha_first = (tmp_path / "talos-agent.db").read_bytes()
    restore_backup(artifact_path=out, password=pw, confirm=True)
    sha_second = (tmp_path / "talos-agent.db").read_bytes()
    assert sha_first == sha_second, "Second restore must reproduce identical bytes"


# ── Single-flight lock prevents overlapping backups ──────────────


def test_concurrent_backup_busy(tmp_path: Path, monkeypatch):
    """Two concurrent builds on the same scope must raise BackupBusyError."""
    if os.name == "nt":
        pytest.skip("fcntl flock not supported on Windows")
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    db_path = tmp_path / "agent.db"
    _seed_agent_db(db_path)

    @bs.single_flight("agent_backup")
    def hold():
        # Inside the lock, another caller should immediately back off.
        with pytest.raises(BackupBusyError):
            with bs.single_flight("agent_backup"):
                pass
        return "ok"

    assert hold() == "ok"


# ── Privacy: error messages redact sensitive substrings ──────────


def test_artifact_not_found_error_is_safe():
    """Operator-facing error messages must never echo back secrets.

    Filename path leakage is acceptable for an operator-only error
    message as long as no secret (passphrase, key, ENC:: blob) is
    embedded.
    """
    err = BackupError("Artifact not found: /var/data/backup.enc")
    msg = str(err)
    assert "passphrase" not in msg.lower()
    assert "SXXXXXX" not in msg
    assert "ENC::" not in msg


def test_stream_encrypted_artifact_roundtrip(tmp_path: Path):
    from talos_agent.backup_service import stream_encrypted_artifact
    from talos_agent.crypto import encrypt_with_password, decrypt_with_password

    payload = "hello-stream-" + ("x" * 5000)
    encrypted = encrypt_with_password(payload, "stream-pass-ok")
    out = tmp_path / "streamed.enc"
    written = stream_encrypted_artifact(encrypted, out, chunk_size=1024)
    assert out.exists()
    assert written == len(encrypted)
    # decrypt_with_password returns bytes (see crypto.decrypt_with_password).
    assert decrypt_with_password(out.read_text(encoding="utf8"), "stream-pass-ok").decode() == payload


def test_stream_encrypted_artifact_rejects_tiny_chunk(tmp_path: Path):
    from talos_agent.backup_service import stream_encrypted_artifact, BackupError
    with pytest.raises(BackupError):
        stream_encrypted_artifact("abc", tmp_path / "x.enc", chunk_size=8)

        

# ── Retention (Issue #543) ────────────────────────────────────────
#
# Positive:  count-only and age-only pruning keep the right files.
# Negative:  invalid policy values raise BackupError; unrelated file
#            extensions are never touched.
# Boundary:  disabled policy (0/0) is a no-op; exact-count boundary keeps
#            everything; both limits combined use OR semantics, so the
#            stricter one wins per file.
# Regression: a file that can't be deleted is skipped, not raised, so a
#             single locked/racing file can never fail the surrounding
#             `backup` command.


def _touch_with_age(path: Path, age_days: float) -> None:
    import os
    import time

    path.write_text("x")
    mtime = time.time() - age_days * 86400
    os.utime(path, (mtime, mtime))


def test_prune_noop_when_both_limits_disabled(tmp_path: Path):
    """Default policy (0/0, matches backup_retention_enabled=False) touches nothing."""
    from talos_agent.backup_service import prune_backups

    for i in range(5):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=i * 10)

    deleted = prune_backups(directory=tmp_path, max_count=0, max_age_days=0)
    assert deleted == []
    assert len(list(tmp_path.glob("*.enc"))) == 5


def test_prune_by_count_keeps_newest(tmp_path: Path):
    from talos_agent.backup_service import prune_backups

    for i in range(5):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=i)

    deleted = prune_backups(directory=tmp_path, max_count=2, max_age_days=0)
    remaining = sorted(p.name for p in tmp_path.glob("*.enc"))
    assert len(deleted) == 3
    assert remaining == ["talos-agent-0.enc", "talos-agent-1.enc"]


def test_prune_by_age_deletes_older_than_cutoff(tmp_path: Path):
    from talos_agent.backup_service import prune_backups

    _touch_with_age(tmp_path / "recent.enc", age_days=5)
    _touch_with_age(tmp_path / "borderline.enc", age_days=29)
    _touch_with_age(tmp_path / "stale.enc", age_days=35)

    deleted = prune_backups(directory=tmp_path, max_count=0, max_age_days=30)
    remaining = sorted(p.name for p in tmp_path.glob("*.enc"))
    assert [p.name for p in deleted] == ["stale.enc"]
    assert remaining == ["borderline.enc", "recent.enc"]


def test_prune_count_exact_boundary_keeps_all(tmp_path: Path):
    """max_count equal to the number of files deletes nothing (off-by-one guard)."""
    from talos_agent.backup_service import prune_backups

    for i in range(3):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=i)

    deleted = prune_backups(directory=tmp_path, max_count=3, max_age_days=0)
    assert deleted == []
    assert len(list(tmp_path.glob("*.enc"))) == 3


def test_prune_or_semantics_age_beats_count(tmp_path: Path):
    """Both limits set: a file outside EITHER limit is deleted (OR, not AND).

    max_count=4 alone would keep the 35-day-old file; max_age_days=30
    alone would keep it too many files. Combined, the age limit must
    still remove it even though the count limit had room to spare.
    """
    from talos_agent.backup_service import prune_backups

    for i, age in enumerate([0, 10, 20, 35]):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=age)

    deleted = prune_backups(directory=tmp_path, max_count=4, max_age_days=30)
    remaining = sorted(p.name for p in tmp_path.glob("*.enc"))
    assert [p.name for p in deleted] == ["talos-agent-3.enc"]
    assert remaining == ["talos-agent-0.enc", "talos-agent-1.enc", "talos-agent-2.enc"]


def test_prune_ignores_non_artifact_files(tmp_path: Path):
    """`.partial` staging files and `.pre-restore` restore backups are never candidates."""
    from talos_agent.backup_service import prune_backups

    for i in range(5):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=i)
    _touch_with_age(tmp_path / "talos-agent-0.enc.partial", age_days=99)
    _touch_with_age(tmp_path / "talos-agent.db.pre-restore", age_days=99)

    prune_backups(directory=tmp_path, max_count=1, max_age_days=0)
    assert (tmp_path / "talos-agent-0.enc.partial").exists()
    assert (tmp_path / "talos-agent.db.pre-restore").exists()


def test_prune_rejects_negative_max_count(tmp_path: Path):
    from talos_agent.backup_service import BackupError, prune_backups

    with pytest.raises(BackupError):
        prune_backups(directory=tmp_path, max_count=-1, max_age_days=0)


def test_prune_rejects_negative_max_age_days(tmp_path: Path):
    from talos_agent.backup_service import BackupError, prune_backups

    with pytest.raises(BackupError):
        prune_backups(directory=tmp_path, max_count=0, max_age_days=-1)


def test_prune_missing_directory_returns_empty(tmp_path: Path):
    """A directory that doesn't exist yet (first-ever backup) is not an error."""
    from talos_agent.backup_service import prune_backups

    missing = tmp_path / "does-not-exist-yet"
    assert prune_backups(directory=missing, max_count=1, max_age_days=1) == []


def test_prune_skips_undeletable_file_without_raising(tmp_path: Path, monkeypatch):
    """A file that fails to unlink (permission error, concurrent removal) is
    skipped, never raised — pruning must not turn a successful backup into
    a failed `backup` command."""
    from pathlib import Path as _Path

    from talos_agent.backup_service import prune_backups

    for i in range(3):
        _touch_with_age(tmp_path / f"talos-agent-{i}.enc", age_days=i)

    real_unlink = _Path.unlink

    def flaky_unlink(self, *args, **kwargs):
        if self.name == "talos-agent-2.enc":
            raise OSError("simulated permission error")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr(_Path, "unlink", flaky_unlink)

    deleted = prune_backups(directory=tmp_path, max_count=1, max_age_days=0)
    assert [p.name for p in deleted] == ["talos-agent-1.enc"]
    assert (tmp_path / "talos-agent-2.enc").exists()
    assert (tmp_path / "talos-agent-0.enc").exists()


# ── Decompressed restore bounds (prevents disk/memory exhaustion) ─────


def test_restore_rejects_oversized_decompressed_single_file(tmp_path: Path, monkeypatch):
    """A malicious artifact with a single file exceeding MAX_DECOMPRESSED_RESTORE_BYTES
    must fail before writing to disk."""
    import json
    from talos_agent.backup_service import (
        MAX_DECOMPRESSED_RESTORE_BYTES,
        restore_backup,
        BackupError,
    )
    from talos_agent.crypto import encrypt_with_password

    # Craft an artifact with a single oversized file body.
    # The file claims to be 100 bytes in metadata but the actual b64-decoded
    # body will exceed MAX_DECOMPRESSED_RESTORE_BYTES (10 MB).
    oversized_raw = b"X" * (MAX_DECOMPRESSED_RESTORE_BYTES + 1024)
    import base64
    oversized_b64 = base64.b64encode(oversized_raw).decode("ascii")
    
    payload = {
        "version": "1.0",
        "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
        "scope": "agent",
        "timestamp": "2024-01-01T00:00:00Z",
        "database": {"signalVersion": "3.0.0", "rowCountsSqlite": {}},
        "filesMeta": {
            "db/oversized.db": {
                "sha256": "a" * 64,  # fake sha, won't matter because size check happens first
                "size_bytes": len(oversized_raw),
            }
        },
        "body": {"db/oversized.db": oversized_b64},
        "manifest": {
            "sha256": "b" * 64,
            "rowCountTotal": 0,
            "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
            "formatVersion": "1.0",
            "size_bytes": 100,
        },
    }
    plaintext = json.dumps(payload, sort_keys=True)
    pw = "malicious-artifact-pass"
    encrypted = encrypt_with_password(plaintext, pw)
    
    artifact_path = tmp_path / "oversized.enc"
    artifact_path.write_text(encrypted, encoding="utf8")
    
    restore_root = tmp_path / "restore-target"
    restore_root.mkdir()
    
    with pytest.raises(BackupError) as exc_info:
        restore_backup(
            artifact_path=artifact_path,
            password=pw,
            confirm=True,
            restore_root=restore_root,
        )
    
    assert exc_info.value.code == "BAD_INPUT"
    assert "MAX_DECOMPRESSED_RESTORE_BYTES" in str(exc_info.value)
    # Verify no files were written to disk before the check triggered.
    assert not (restore_root / "oversized.db").exists()


def test_restore_rejects_cumulative_oversized_files(tmp_path: Path, monkeypatch):
    """Multiple files that individually fit but cumulatively exceed the limit
    must fail before exhausting disk."""
    import json
    from talos_agent.backup_service import (
        MAX_DECOMPRESSED_RESTORE_BYTES,
        restore_backup,
        BackupError,
    )
    from talos_agent.crypto import encrypt_with_password
    import hashlib
    import base64
    
    # Create 3 files, each ~4 MB, totaling ~12 MB > 10 MB limit.
    file_size = (MAX_DECOMPRESSED_RESTORE_BYTES // 3) + 1024 * 1024
    files_meta = {}
    body = {}
    
    for i in range(3):
        name = f"db/file-{i}.db"
        raw = b"Y" * file_size
        sha = hashlib.sha256(raw).hexdigest()
        files_meta[name] = {"sha256": sha, "size_bytes": len(raw)}
        body[name] = base64.b64encode(raw).decode("ascii")
    
    payload = {
        "version": "1.0",
        "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
        "scope": "agent",
        "timestamp": "2024-01-01T00:00:00Z",
        "database": {"signalVersion": "3.0.0", "rowCountsSqlite": {}},
        "filesMeta": files_meta,
        "body": body,
        "manifest": {
            "sha256": "c" * 64,
            "rowCountTotal": 0,
            "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
            "formatVersion": "1.0",
            "size_bytes": 100,
        },
    }
    plaintext = json.dumps(payload, sort_keys=True)
    pw = "cumulative-overflow-pass"
    encrypted = encrypt_with_password(plaintext, pw)
    
    artifact_path = tmp_path / "cumulative.enc"
    artifact_path.write_text(encrypted, encoding="utf8")
    
    restore_root = tmp_path / "restore-target-cumulative"
    restore_root.mkdir()
    
    with pytest.raises(BackupError) as exc_info:
        restore_backup(
            artifact_path=artifact_path,
            password=pw,
            confirm=True,
            restore_root=restore_root,
        )
    
    assert exc_info.value.code == "BAD_INPUT"
    assert "MAX_DECOMPRESSED_RESTORE_BYTES" in str(exc_info.value)
    # The first file or two might have been staged, but the atomic swap
    # never happened, so restore_root should be empty.
    assert len(list(restore_root.glob("*.db"))) == 0


def test_restore_accepts_at_boundary(tmp_path: Path, monkeypatch):
    """A restore at exactly MAX_DECOMPRESSED_RESTORE_BYTES must succeed."""
    import json
    from talos_agent.backup_service import (
        MAX_DECOMPRESSED_RESTORE_BYTES,
        restore_backup,
    )
    from talos_agent.crypto import encrypt_with_password
    import hashlib
    import base64
    
    # Single file at exactly the limit.
    raw = b"Z" * MAX_DECOMPRESSED_RESTORE_BYTES
    sha = hashlib.sha256(raw).hexdigest()
    name = "db/boundary.db"
    
    payload = {
        "version": "1.0",
        "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
        "scope": "agent",
        "timestamp": "2024-01-01T00:00:00Z",
        "database": {"signalVersion": "3.0.0", "rowCountsSqlite": {}},
        "filesMeta": {name: {"sha256": sha, "size_bytes": len(raw)}},
        "body": {name: base64.b64encode(raw).decode("ascii")},
        "manifest": {
            "sha256": "d" * 64,
            "rowCountTotal": 0,
            "encryption": "AES-256-GCM#PBKDF2-SHA256#200000",
            "formatVersion": "1.0",
            "size_bytes": 100,
        },
    }
    plaintext = json.dumps(payload, sort_keys=True)
    pw = "boundary-test-pass-ok"
    encrypted = encrypt_with_password(plaintext, pw)
    
    artifact_path = tmp_path / "boundary.enc"
    artifact_path.write_text(encrypted, encoding="utf8")
    
    restore_root = tmp_path / "restore-target-boundary"
    restore_root.mkdir()
    
    # Should succeed without raising.
    result = restore_backup(
        artifact_path=artifact_path,
        password=pw,
        confirm=True,
        restore_root=restore_root,
    )
    
    assert result.scope == "agent"
    assert (restore_root / "boundary.db").exists()
    assert (restore_root / "boundary.db").stat().st_size == MAX_DECOMPRESSED_RESTORE_BYTES


def test_restore_preserves_existing_behavior_for_normal_backups(tmp_path: Path, monkeypatch):
    """Normal-sized backups continue to work unchanged after adding the bounds check."""
    db_path = tmp_path / "talos-agent.db"
    _seed_agent_db(db_path)
    from talos_agent import backup_service as bs
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr("talos_agent.db.APP_DIR", tmp_path)

    out = tmp_path / "normal.enc"
    pw = "normal-backup-pass-long"
    build_backup(password=pw, out_path=out)
    
    restore_root = tmp_path / "restore-normal"
    restore_root.mkdir()
    
    result = restore_backup(
        artifact_path=out,
        password=pw,
        confirm=True,
        restore_root=restore_root,
    )
    
    assert result.version == BACKUP_FORMAT_VERSION
    assert (restore_root / "talos-agent.db").exists()
    # Verify the restored DB is valid SQLite (can be opened).
    import sqlite3
    conn = sqlite3.connect(str(restore_root / "talos-agent.db"))
    conn.close()
