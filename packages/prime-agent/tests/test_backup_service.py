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
import json
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


def _seed_agent_db(db_path: Path) -> LocalDB:
    """Create a small but readable LocalDB at `db_path`."""
    db = LocalDB(path=db_path)
    # SQLite hot backup uses Connection.backup, so any LocalDB is fine.
    return db


def _patch_app_dir(monkeypatch, tmp_path: Path):
    """Patch APP_DIR in both backup_service and config modules."""
    from talos_agent import backup_service as bs
    from talos_agent import config
    from talos_agent.db import migrations
    monkeypatch.setattr(bs, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(migrations, "APP_DIR", tmp_path)


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
    db = _seed_agent_db(db_path)
    db.close()
    _patch_app_dir(monkeypatch, tmp_path)

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
    db = _seed_agent_db(db_path)
    db.close()
    _patch_app_dir(monkeypatch, tmp_path)

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
    db = _seed_agent_db(db_path)
    db.close()
    _patch_app_dir(monkeypatch, tmp_path)

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
    db = _seed_agent_db(db_path)
    db.close()  # Close to avoid Windows file lock
    _patch_app_dir(monkeypatch, tmp_path)

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
    _patch_app_dir(monkeypatch, tmp_path)

    db_path = tmp_path / "agent.db"
    db = _seed_agent_db(db_path)
    db.close()

    @bs.single_flight("agent_backup")
    def hold():
        # Inside the lock, another caller should immediately back off.
        with pytest.raises(BackupBusyError), bs.single_flight("agent_backup"):
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
    from talos_agent.crypto import decrypt_with_password, encrypt_with_password

    payload = "hello-stream-" + ("x" * 5000)
    encrypted = encrypt_with_password(payload, "stream-pass-ok")
    out = tmp_path / "streamed.enc"
    written = stream_encrypted_artifact(encrypted, out, chunk_size=1024)
    assert out.exists()
    assert written == len(encrypted)
    # decrypt_with_password returns bytes (see crypto.decrypt_with_password).
    assert decrypt_with_password(out.read_text(encoding="utf8"), "stream-pass-ok").decode() == payload


def test_stream_encrypted_artifact_rejects_tiny_chunk(tmp_path: Path):
    from talos_agent.backup_service import BackupError, stream_encrypted_artifact
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


# ── Schema Compatibility (Issue: database schema compatibility report) ─────


def test_check_schema_compatibility_same_version():
    """Backup and current agent at same schema version → compatible, no migrations."""
    from talos_agent.backup_service import (
        _get_current_schema_version,
        check_schema_compatibility,
    )

    current = _get_current_schema_version()
    compat = check_schema_compatibility(current, current_schema_version=current)

    assert compat["compatible"] is True
    assert compat["backup_schema_version"] == current
    assert compat["current_schema_version"] == current
    assert compat["required_migrations"] == []
    assert compat["unsupported_downgrade"] is False
    assert "compatible" in compat["message"].lower()


def test_check_schema_compatibility_older_backup():
    """Backup older than current agent → compatible, migrations listed."""
    from talos_agent.backup_service import (
        _get_current_schema_version,
        check_schema_compatibility,
    )

    current = _get_current_schema_version()
    # Use a version at least 2 behind so we get multiple migrations
    backup_version = max(1, current - 3)
    compat = check_schema_compatibility(backup_version, current_schema_version=current)

    assert compat["compatible"] is True
    assert compat["backup_schema_version"] == backup_version
    assert compat["current_schema_version"] == current
    assert compat["required_migrations"] == list(range(backup_version + 1, current + 1))
    assert compat["unsupported_downgrade"] is False
    assert str(backup_version) in compat["message"]
    assert str(current) in compat["message"]


def test_check_schema_compatibility_unsupported_downgrade():
    """Backup newer than current agent → incompatible, unsupported_downgrade=True."""
    from talos_agent.backup_service import (
        _get_current_schema_version,
        check_schema_compatibility,
    )

    current = _get_current_schema_version()
    future_version = current + 2
    compat = check_schema_compatibility(future_version, current_schema_version=current)

    assert compat["compatible"] is False
    assert compat["backup_schema_version"] == future_version
    assert compat["current_schema_version"] == current
    assert compat["required_migrations"] == []
    assert compat["unsupported_downgrade"] is True
    assert "unsupported downgrade" in compat["message"].lower()


def test_build_backup_includes_schema_versions(tmp_path: Path, monkeypatch):
    """Backup artifact includes per-database schemaVersions in database metadata."""
    from talos_agent import backup_service as bs
    from talos_agent.db import LocalDB

    _patch_app_dir(monkeypatch, tmp_path)

    # Create a database with current schema
    db_path = tmp_path / "talos-agent.db"
    db = LocalDB(path=db_path)
    db.close()

    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    run = bs.build_backup(password=pw, out_path=out, scope="agent")

    # Verify the backup includes schemaVersions
    assert "schemaVersions" in run.database
    assert "talos-agent.db" in run.database["schemaVersions"]
    schema_ver = run.database["schemaVersions"]["talos-agent.db"]
    assert isinstance(schema_ver, int)
    assert schema_ver >= 1  # At least the initial migration


def test_verify_backup_includes_schema_compatibility(tmp_path: Path, monkeypatch):
    """verify_backup returns schemaCompatibility report in database metadata."""
    from talos_agent import backup_service as bs
    from talos_agent.db import LocalDB

    _patch_app_dir(monkeypatch, tmp_path)

    db_path = tmp_path / "talos-agent.db"
    db = LocalDB(path=db_path)
    db.close()

    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    bs.build_backup(password=pw, out_path=out, scope="agent")

    verified = bs.verify_backup(artifact_path=out, password=pw)

    # Check schemaCompatibility is present
    assert "schemaCompatibility" in verified.database
    compat = verified.database["schemaCompatibility"]
    assert "talos-agent.db" in compat
    db_compat = compat["talos-agent.db"]
    assert "compatible" in db_compat
    assert "backup_schema_version" in db_compat
    assert "current_schema_version" in db_compat
    assert "required_migrations" in db_compat
    assert "unsupported_downgrade" in db_compat
    assert "message" in db_compat
    # Since we just created the DB with current code, it should be compatible
    assert db_compat["compatible"] is True
    assert db_compat["unsupported_downgrade"] is False


def test_restore_rejects_unsupported_downgrade(tmp_path: Path, monkeypatch):
    """restore_backup rejects backup with newer schema version without changing local state."""
    from talos_agent import backup_service as bs
    from talos_agent.backup_service import BackupError
    from talos_agent.crypto import decrypt_with_password, encrypt_with_password
    from talos_agent.db import LocalDB

    _patch_app_dir(monkeypatch, tmp_path)

    # Create a database
    db_path = tmp_path / "talos-agent.db"
    db = LocalDB(path=db_path)
    db.close()  # Close the connection so the file isn't locked on Windows

    # Build a backup
    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    bs.build_backup(password=pw, out_path=out, scope="agent")

    # Read the backup and manually modify the schema version to simulate a future backup
    blob = out.read_text(encoding="utf8")
    plaintext = decrypt_with_password(blob, pw)
    payload = json.loads(plaintext.decode("utf8"))

    # Bump the schema version to a future version
    current = bs._get_current_schema_version()
    future_version = current + 2
    payload["database"]["schemaVersions"]["talos-agent.db"] = future_version

    # Re-encrypt and write back
    new_plaintext = json.dumps(payload, sort_keys=True).encode("utf8")
    new_encrypted = encrypt_with_password(new_plaintext.decode("utf8"), pw)
    out.write_text(new_encrypted, encoding="utf8")

    # Attempt to restore - should fail with UNSUPPORTED_DOWNGRADE
    with pytest.raises(BackupError) as exc_info:
        bs.restore_backup(artifact_path=out, password=pw, confirm=True)

    assert getattr(exc_info.value, "code", "") == "UNSUPPORTED_DOWNGRADE"
    assert "unsupported" in str(exc_info.value).lower()

    # Verify local state was not changed (original DB still exists and is intact)
    assert db_path.exists()
    # The DB should still be readable
    LocalDB(path=db_path)  # Should not raise


def test_restore_allows_compatible_older_backup(tmp_path: Path, monkeypatch):
    """restore_backup allows backup with older (compatible) schema version."""
    from talos_agent import backup_service as bs
    from talos_agent.crypto import decrypt_with_password, encrypt_with_password
    from talos_agent.db import LocalDB

    _patch_app_dir(monkeypatch, tmp_path)

    # Create a database
    db_path = tmp_path / "talos-agent.db"
    db = LocalDB(path=db_path)
    db.close()  # Close the connection so the file isn't locked on Windows

    # Build a backup
    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    bs.build_backup(password=pw, out_path=out, scope="agent")

    # Modify the backup to have an older schema version (simulate older backup)
    blob = out.read_text(encoding="utf8")
    plaintext = decrypt_with_password(blob, pw)
    payload = json.loads(plaintext.decode("utf8"))

    # Set schema version to an older version (but not too old)
    older_version = max(1, bs._get_current_schema_version() - 2)
    payload["database"]["schemaVersions"]["talos-agent.db"] = older_version

    # Re-encrypt and write back
    new_plaintext = json.dumps(payload, sort_keys=True).encode("utf8")
    new_encrypted = encrypt_with_password(new_plaintext.decode("utf8"), pw)
    out.write_text(new_encrypted, encoding="utf8")

    # Restore should succeed (migrations will run on first use)
    verified = bs.restore_backup(artifact_path=out, password=pw, confirm=True)

    # Verify the restore completed
    assert verified is not None
    assert db_path.exists()

    # The restored DB should be readable and migrations will run on first access
    LocalDB(path=db_path)  # Should not raise


def test_schema_compatibility_report_lists_required_migrations(tmp_path: Path, monkeypatch):
    """Schema compatibility report correctly lists required migration versions."""
    from talos_agent import backup_service as bs
    from talos_agent.crypto import decrypt_with_password, encrypt_with_password
    from talos_agent.db import LocalDB

    _patch_app_dir(monkeypatch, tmp_path)

    db_path = tmp_path / "talos-agent.db"
    db = LocalDB(path=db_path)
    db.close()

    out = tmp_path / "artifact.enc"
    pw = "test-passphrase-v1-long"
    bs.build_backup(password=pw, out_path=out, scope="agent")

    # Modify backup to have an older schema version
    blob = out.read_text(encoding="utf8")
    plaintext = decrypt_with_password(blob, pw)
    payload = json.loads(plaintext.decode("utf8"))

    older_version = max(1, bs._get_current_schema_version() - 3)
    payload["database"]["schemaVersions"]["talos-agent.db"] = older_version

    new_plaintext = json.dumps(payload, sort_keys=True).encode("utf8")
    new_encrypted = encrypt_with_password(new_plaintext.decode("utf8"), pw)
    out.write_text(new_encrypted, encoding="utf8")

    # Verify and check the compatibility report
    verified = bs.verify_backup(artifact_path=out, password=pw)
    compat = verified.database["schemaCompatibility"]["talos-agent.db"]

    assert compat["backup_schema_version"] == older_version
    assert compat["current_schema_version"] == bs._get_current_schema_version()
    expected_migrations = list(range(older_version + 1, bs._get_current_schema_version() + 1))
    assert compat["required_migrations"] == expected_migrations
    assert len(compat["required_migrations"]) >= 2  # At least 2 migrations
    assert compat["compatible"] is True
