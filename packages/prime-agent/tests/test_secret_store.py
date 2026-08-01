"""Security, lifecycle, concurrency, and recovery tests for encrypted secrets."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

import pytest
from click.testing import CliRunner

from talos_agent.cli import main
from talos_agent.db import LocalDB
from talos_agent.secret_store import (
    ActiveSecretRevocationError,
    SecretBusyError,
    SecretConflictError,
    SecretDecryptionError,
    SecretStore,
    SecretValidationError,
    decode_keyring,
)


def _key(byte: int) -> bytes:
    return bytes([byte]) * 32


def _store(
    db: LocalDB,
    *,
    keyring: dict[str, bytes] | None = None,
    active_key_id: str = "primary",
    dual_read: bool = True,
    legacy_fallback: bool = True,
    max_value_bytes: int = 65536,
) -> SecretStore:
    return SecretStore(
        db,
        keyring=keyring or {"primary": _key(1)},
        active_key_id=active_key_id,
        scope="test",
        dual_read=dual_read,
        legacy_fallback=legacy_fallback,
        max_value_bytes=max_value_bytes,
    )


def _stage_activate(
    store: SecretStore, name: str, value: str, request_id: str
) -> int:
    expected = store.current_version(name)
    staged = store.stage(name, value, request_id=request_id)
    store.activate(name, staged.version, expected_active_version=expected)
    return staged.version


def test_keyring_decoding_requires_exactly_32_bytes():
    encoded = base64.urlsafe_b64encode(_key(9)).decode().rstrip("=")
    assert decode_keyring(f'{{"primary":"{encoded}"}}') == {"primary": _key(9)}

    short = base64.urlsafe_b64encode(b"short").decode()
    with pytest.raises(Exception, match="exactly 32 bytes"):
        decode_keyring(f'{{"primary":"{short}"}}')


def test_plaintext_is_never_persisted_and_audit_is_redacted(mock_db: LocalDB):
    store = _store(mock_db)
    plaintext = "super-secret-provider-token"

    version = _stage_activate(store, "provider.api_key", plaintext, "request-1")

    row = mock_db._conn.execute(
        "SELECT ciphertext, key_id FROM secret_versions WHERE version = ?", (version,)
    ).fetchone()
    assert plaintext not in row["ciphertext"]
    assert row["ciphertext"].startswith("TALOS-SECRET::1::")

    audit_rows = mock_db._conn.execute(
        """
        SELECT event_id, scope, name, version, event_type, outcome, actor, reason, metadata
        FROM secret_audit_events
        """
    ).fetchall()
    persisted = json.dumps([dict(row) for row in audit_rows], sort_keys=True)
    assert plaintext not in persisted
    assert row["ciphertext"] not in persisted
    assert row["key_id"] not in persisted


def test_duplicate_stage_delivery_is_idempotent(mock_db: LocalDB):
    store = _store(mock_db)
    first = store.stage("openai_api_key", "value-one", request_id="same-request")
    duplicate = store.stage("openai_api_key", "ignored-retry-value", request_id="same-request")

    assert duplicate.version == first.version
    assert len(store.list_versions("openai_api_key")) == 1
    store.activate("openai_api_key", first.version, expected_active_version=None)
    assert store.resolve("openai_api_key").value == "value-one"


def test_atomic_activation_rejects_stale_concurrent_operator(tmp_path: Path):
    path = tmp_path / "shared.db"
    db_a = LocalDB(path=path)
    db_b = LocalDB(path=path)
    store_a = _store(db_a)
    store_b = _store(db_b)
    first = store_a.stage("talos_api_key", "one", request_id="first")
    second = store_b.stage("talos_api_key", "two", request_id="second")

    store_a.activate("talos_api_key", first.version, expected_active_version=None)
    with pytest.raises(SecretConflictError, match="expected None, found 1"):
        store_b.activate("talos_api_key", second.version, expected_active_version=None)

    assert store_b.resolve("talos_api_key").value == "one"
    db_a.close()
    db_b.close()


def test_dual_read_falls_back_to_previous_on_corrupt_active(mock_db: LocalDB):
    store = _store(mock_db)
    old_version = _stage_activate(store, "groq_api_key", "old-key", "old")
    new_version = _stage_activate(store, "groq_api_key", "new-key", "new")
    mock_db._conn.execute(
        "UPDATE secret_versions SET ciphertext = ? WHERE scope = 'test' AND name = ? AND version = ?",
        ("TALOS-SECRET::1::broken", "groq_api_key", new_version),
    )
    mock_db._conn.commit()

    resolved = store.resolve("groq_api_key")

    assert resolved.value == "old-key"
    assert resolved.source == "previous"
    assert resolved.version == old_version


def test_missing_decryption_key_uses_legacy_only_when_enabled(tmp_path: Path):
    path = tmp_path / "keys.db"
    db = LocalDB(path=path)
    original = _store(db)
    _stage_activate(original, "discord_bot_token", "encrypted", "original")

    replacement = _store(
        db,
        keyring={"replacement": _key(2)},
        active_key_id="replacement",
        legacy_fallback=True,
    )
    assert replacement.resolve("discord_bot_token", "legacy").value == "legacy"

    strict = _store(
        db,
        keyring={"replacement": _key(2)},
        active_key_id="replacement",
        legacy_fallback=False,
    )
    with pytest.raises(SecretDecryptionError):
        strict.resolve("discord_bot_token", "legacy")
    db.close()


def test_revoke_active_rejected_then_old_version_can_be_revoked(mock_db: LocalDB):
    store = _store(mock_db)
    first = _stage_activate(store, "x_password", "old-password", "old")
    second = _stage_activate(store, "x_password", "new-password", "new")

    with pytest.raises(ActiveSecretRevocationError):
        store.revoke("x_password", second)
    revoked = store.revoke("x_password", first)

    assert revoked.status == "revoked"
    assert store.resolve("x_password").value == "new-password"


def test_recovery_is_atomic_and_survives_restart(tmp_path: Path):
    path = tmp_path / "recovery.db"
    db = LocalDB(path=path)
    store = _store(db)
    first = _stage_activate(store, "wallet.secret_key", "wallet-old", "wallet-old")
    second = _stage_activate(store, "wallet.secret_key", "wallet-bad", "wallet-new")

    recovered = store.recover(
        "wallet.secret_key",
        first,
        expected_active_version=second,
        reason="credential_rejected",
    )
    assert recovered.status == "active"
    db.close()

    reopened = LocalDB(path=path)
    assert _store(reopened).resolve("wallet.secret_key").value == "wallet-old"
    reopened.close()


def test_failed_stage_rolls_back_without_partial_row(mock_db: LocalDB, monkeypatch):
    store = _store(mock_db)

    def fail_encrypt(*args, **kwargs):
        raise RuntimeError("simulated encryption failure")

    monkeypatch.setattr(store, "_encrypt", fail_encrypt)
    with pytest.raises(RuntimeError, match="simulated"):
        store.stage("provider.api_key", "never-persist", request_id="failure")

    count = mock_db._conn.execute("SELECT COUNT(*) FROM secret_versions").fetchone()[0]
    assert count == 0


def test_input_boundaries_are_enforced(mock_db: LocalDB):
    store = _store(mock_db, max_value_bytes=8)

    with pytest.raises(SecretValidationError, match="secret name"):
        store.stage("../escape", "value", request_id="request")
    with pytest.raises(SecretValidationError, match="cannot be empty"):
        store.stage("valid_name", "", request_id="request")
    with pytest.raises(SecretValidationError, match="byte limit"):
        store.stage("valid_name", "123456789", request_id="request")
    with pytest.raises(SecretValidationError, match="request ID"):
        store.stage("valid_name", "value", request_id="contains whitespace")
    with pytest.raises(SecretValidationError, match="actor"):
        store.stage("valid_name", "value", request_id="request", actor="bad actor")


def test_authenticated_metadata_prevents_ciphertext_row_swapping(mock_db: LocalDB):
    store = _store(mock_db, legacy_fallback=False)
    source = store.stage("provider.first", "first-value", request_id="first")
    target = store.stage("provider.second", "second-value", request_id="second")
    source_row = mock_db._conn.execute(
        """
        SELECT ciphertext, key_id FROM secret_versions
        WHERE scope = 'test' AND name = 'provider.first' AND version = ?
        """,
        (source.version,),
    ).fetchone()
    mock_db._conn.execute(
        """
        UPDATE secret_versions SET ciphertext = ?, key_id = ?
        WHERE scope = 'test' AND name = 'provider.second' AND version = ?
        """,
        (source_row["ciphertext"], source_row["key_id"], target.version),
    )
    mock_db._conn.commit()

    with pytest.raises(SecretDecryptionError, match="authentication failed"):
        store.activate(
            "provider.second",
            target.version,
            expected_active_version=None,
        )


def test_sqlite_lock_wait_is_bounded(tmp_path: Path):
    path = tmp_path / "locked.db"
    holder = LocalDB(path=path, timeout_ms=50)
    contender = LocalDB(path=path, timeout_ms=50)
    holder._conn.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(SecretBusyError, match="retry"):
            _store(contender).stage("openai_api_key", "value", request_id="locked")
    finally:
        holder._conn.rollback()
        holder.close()
        contender.close()


def test_database_file_is_owner_only_where_supported(tmp_path: Path):
    path = tmp_path / "permissions.db"
    db = LocalDB(path=path)
    mode = os.stat(path).st_mode & 0o777
    db.close()
    assert mode & 0o077 == 0


def test_operator_cli_never_echoes_secret_or_envelope(tmp_path: Path):
    runner = CliRunner()
    encoded = base64.urlsafe_b64encode(_key(7)).decode().rstrip("=")
    secret = "cli-sensitive-value"

    result = runner.invoke(
        main,
        [
            "secrets",
            "--db-path",
            str(tmp_path / "cli.db"),
            "rotate",
            "provider.api_key",
            "--request-id",
            "cli-request",
        ],
        input=f"{secret}\n{secret}\n",
        env={
            "TALOS_SECRET_KEYRING": json.dumps({"primary": encoded}),
            "TALOS_SECRET_ACTIVE_KEY_ID": "primary",
            "TALOS_SECRET_SCOPE": "cli",
        },
    )

    assert result.exit_code == 0, result.output
    assert secret not in result.output
    assert "TALOS-SECRET" not in result.output
    assert '"status": "active"' in result.output
