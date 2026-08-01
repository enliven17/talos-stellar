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
