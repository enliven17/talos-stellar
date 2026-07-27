"""Versioned encrypted secret storage with transactional activation.

Plaintext exists only in caller memory and is never persisted or included in
logs/audit events. SQLite transactions provide cross-process compare-and-swap
semantics; no correctness decision relies on process-local state.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Mapping

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from talos_agent.observability import log

_ENVELOPE_PREFIX = "TALOS-SECRET::1::"
_NAME_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,127}$")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REASON_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
_MAX_HARD_LIMIT = 1024 * 1024
_ACTIVATABLE = {"staged", "superseded"}


class SecretStoreError(Exception):
    """Base class for errors safe to report without sensitive context."""


class SecretConfigurationError(SecretStoreError):
    pass


class SecretValidationError(SecretStoreError):
    pass


class SecretNotFoundError(SecretStoreError):
    pass


class SecretConflictError(SecretStoreError):
    pass


class SecretBusyError(SecretStoreError):
    pass


class SecretDecryptionError(SecretStoreError):
    pass


class ActiveSecretRevocationError(SecretStoreError):
    pass


@dataclass(frozen=True)
class SecretVersion:
    name: str
    version: int
    status: str
    created_at: str
    activated_at: str | None
    revoked_at: str | None


@dataclass(frozen=True)
class SecretResolution:
    value: str
    source: str
    version: int | None = None


def decode_keyring(raw: str | Mapping[str, str]) -> dict[str, bytes]:
    """Decode and validate a key-id -> URL-safe-base64 AES-256 key mapping."""
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SecretConfigurationError("TALOS_SECRET_KEYRING must be valid JSON") from exc
    else:
        parsed = dict(raw)
    if not isinstance(parsed, dict) or len(parsed) > 32:
        raise SecretConfigurationError("secret keyring must be an object with at most 32 keys")

    result: dict[str, bytes] = {}
    for key_id, encoded in parsed.items():
        if not isinstance(key_id, str) or not _NAME_RE.fullmatch(key_id):
            raise SecretConfigurationError("secret key IDs must use lowercase safe identifiers")
        if not isinstance(encoded, str) or len(encoded) > 128:
            raise SecretConfigurationError("keyring contains an invalid encoded key")
        try:
            padded = encoded + "=" * (-len(encoded) % 4)
            key = base64.urlsafe_b64decode(padded.encode("ascii"))
        except (ValueError, UnicodeEncodeError, binascii.Error) as exc:
            raise SecretConfigurationError("keyring contains invalid base64") from exc
        if len(key) != 32:
            raise SecretConfigurationError("every keyring key must contain exactly 32 bytes")
        result[key_id] = key
    return result


class SecretStore:
    """Encrypted versions and atomic lifecycle transitions for one scope."""

    def __init__(
        self,
        db,
        *,
        keyring: Mapping[str, bytes],
        active_key_id: str,
        scope: str = "default",
        max_value_bytes: int = 65536,
        dual_read: bool = True,
        legacy_fallback: bool = True,
    ) -> None:
        self._db = db
        self._conn: sqlite3.Connection = db._conn
        self._keyring = dict(keyring)
        self._active_key_id = active_key_id
        self._scope = self._validate_identifier(scope, "scope")
        self._max_value_bytes = min(max(max_value_bytes, 1), _MAX_HARD_LIMIT)
        self._dual_read = dual_read
        self._legacy_fallback = legacy_fallback
        if active_key_id not in self._keyring:
            raise SecretConfigurationError("active secret key ID is missing from the keyring")

    @staticmethod
    def _validate_identifier(value: str, label: str) -> str:
        if not isinstance(value, str) or not _NAME_RE.fullmatch(value):
            raise SecretValidationError(
                f"{label} must match {_NAME_RE.pattern} and be at most 128 characters"
            )
        return value

    def _validate_value(self, value: str) -> bytes:
        if not isinstance(value, str):
            raise SecretValidationError("secret value must be a string")
        encoded = value.encode("utf-8")
        if not encoded:
            raise SecretValidationError("secret value cannot be empty")
        if len(encoded) > self._max_value_bytes:
            raise SecretValidationError(
                f"secret value exceeds configured {self._max_value_bytes}-byte limit"
            )
        return encoded

    def _aad(self, name: str, version: int, key_id: str) -> bytes:
        return json.dumps(
            {
                "format": 1,
                "scope": self._scope,
                "name": name,
                "version": version,
                "key_id": key_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    def _encrypt(self, name: str, version: int, plaintext: bytes) -> str:
        import os

        nonce = os.urandom(12)
        key = self._keyring[self._active_key_id]
        ciphertext = AESGCM(key).encrypt(
            nonce, plaintext, self._aad(name, version, self._active_key_id)
        )
        return _ENVELOPE_PREFIX + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")

    def _decrypt(self, row: sqlite3.Row) -> str:
        key_id = row["key_id"]
        key = self._keyring.get(key_id)
        if key is None:
            raise SecretDecryptionError("encryption key is unavailable")
        envelope = row["ciphertext"]
        if not isinstance(envelope, str) or not envelope.startswith(_ENVELOPE_PREFIX):
            raise SecretDecryptionError("unsupported encrypted envelope")
        try:
            raw = base64.b64decode(
                envelope[len(_ENVELOPE_PREFIX):],
                altchars=b"-_",
                validate=True,
            )
            if len(raw) < 12 + 16:
                raise ValueError("short envelope")
            plaintext = AESGCM(key).decrypt(
                raw[:12],
                raw[12:],
                self._aad(row["name"], row["version"], key_id),
            )
            return plaintext.decode("utf-8")
        except Exception as exc:
            raise SecretDecryptionError("secret envelope authentication failed") from exc

    def _audit(
        self,
        *,
        name: str,
        version: int | None,
        event_type: str,
        outcome: str,
        actor: str,
        reason: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> None:
        if not _REQUEST_ID_RE.fullmatch(actor):
            raise SecretValidationError("actor must be a safe identifier of at most 128 characters")
        if reason is not None and not _REASON_RE.fullmatch(reason):
            raise SecretValidationError("reason must be a lowercase reason code of at most 64 characters")
        safe_metadata = json.dumps(dict(metadata or {}), sort_keys=True)
        if len(safe_metadata.encode("utf-8")) > 2048:
            raise SecretValidationError("audit metadata exceeds 2048-byte limit")
        self._conn.execute(
            """
            INSERT INTO secret_audit_events
                (event_id, scope, name, version, event_type, outcome, actor, reason, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                self._scope,
                name,
                version,
                event_type,
                outcome,
                actor,
                reason,
                safe_metadata,
            ),
        )

    def _transition_log(
        self, name: str, version: int | None, transition: str, outcome: str, error: Exception | None = None
    ) -> None:
        fields = {
            "scope": self._scope,
            "secret_name": name,
            "secret_version": version,
            "transition": transition,
            "outcome": outcome,
        }
        try:
            if error is not None:
                fields["error_type"] = type(error).__name__
                log.warning("secret_rotation_transition", **fields)
            else:
                log.info("secret_rotation_transition", **fields)
        except Exception:
            # Logging must never change a committed secret transition.
            pass

    def stage(
        self,
        name: str,
        value: str,
        *,
        request_id: str,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        """Persist one encrypted staged version; duplicate request IDs are idempotent."""
        name = self._validate_identifier(name, "secret name")
        plaintext = self._validate_value(value)
        if not isinstance(request_id, str) or not _REQUEST_ID_RE.fullmatch(request_id):
            raise SecretValidationError("request ID must be a safe identifier of at most 128 characters")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            existing = self._conn.execute(
                """
                SELECT name, version, status, created_at, activated_at, revoked_at
                FROM secret_versions WHERE scope = ? AND name = ? AND request_id = ?
                """,
                (self._scope, name, request_id),
            ).fetchone()
            if existing:
                self._conn.commit()
                return SecretVersion(**dict(existing))
            row = self._conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS version "
                "FROM secret_versions WHERE scope = ? AND name = ?",
                (self._scope, name),
            ).fetchone()
            version = int(row["version"])
            ciphertext = self._encrypt(name, version, plaintext)
            self._conn.execute(
                """
                INSERT INTO secret_versions
                    (scope, name, version, ciphertext, key_id, status, request_id)
                VALUES (?, ?, ?, ?, ?, 'staged', ?)
                """,
                (self._scope, name, version, ciphertext, self._active_key_id, request_id),
            )
            self._audit(
                name=name,
                version=version,
                event_type="staged",
                outcome="success",
                actor=actor,
                reason=reason,
            )
            result_row = self._conn.execute(
                """
                SELECT name, version, status, created_at, activated_at, revoked_at
                FROM secret_versions WHERE scope = ? AND name = ? AND version = ?
                """,
                (self._scope, name, version),
            ).fetchone()
            self._conn.commit()
            result = SecretVersion(**dict(result_row))
            self._transition_log(name, version, "stage", "success")
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, None, "stage", "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError("secret store is busy; retry the idempotent operation") from exc
            raise

    def current_version(self, name: str) -> int | None:
        name = self._validate_identifier(name, "secret name")
        row = self._conn.execute(
            "SELECT active_version FROM secret_heads WHERE scope = ? AND name = ?",
            (self._scope, name),
        ).fetchone()
        return int(row["active_version"]) if row else None

    def activate(
        self,
        name: str,
        version: int,
        *,
        expected_active_version: int | None,
        actor: str = "operator",
        reason: str | None = None,
        event_type: str = "activated",
    ) -> SecretVersion:
        """Atomically activate a version if the caller's head is still current."""
        name = self._validate_identifier(name, "secret name")
        if version < 1:
            raise SecretValidationError("version must be positive")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            head = self._conn.execute(
                "SELECT active_version, generation FROM secret_heads WHERE scope = ? AND name = ?",
                (self._scope, name),
            ).fetchone()
            actual = int(head["active_version"]) if head else None
            if actual == version:
                self._conn.commit()
                row = self._get_version_row(name, version)
                return self._public_version(row)
            if actual != expected_active_version:
                raise SecretConflictError(
                    f"active version changed: expected {expected_active_version}, found {actual}"
                )
            target = self._get_version_row(name, version)
            if target["status"] not in _ACTIVATABLE:
                raise SecretConflictError(
                    f"version {version} cannot be activated from state {target['status']}"
                )
            # Prove the target can be decrypted before changing the head.
            self._decrypt(target)
            if actual is not None:
                self._conn.execute(
                    """
                    UPDATE secret_versions SET status = 'superseded'
                    WHERE scope = ? AND name = ? AND version = ? AND status = 'active'
                    """,
                    (self._scope, name, actual),
                )
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = 'active', activated_at = datetime('now'), revoked_at = NULL
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (self._scope, name, version),
            )
            if head:
                self._conn.execute(
                    """
                    UPDATE secret_heads
                    SET active_version = ?, previous_version = ?, generation = generation + 1,
                        updated_at = datetime('now')
                    WHERE scope = ? AND name = ?
                    """,
                    (version, actual, self._scope, name),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO secret_heads (scope, name, active_version, previous_version)
                    VALUES (?, ?, ?, NULL)
                    """,
                    (self._scope, name, version),
                )
            self._audit(
                name=name,
                version=version,
                event_type=event_type,
                outcome="success",
                actor=actor,
                reason=reason,
                metadata={"previous_version": actual},
            )
            row = self._get_version_row(name, version)
            self._conn.commit()
            result = self._public_version(row)
            self._transition_log(name, version, event_type, "success")
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, version, event_type, "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError("secret store is busy; retry the idempotent operation") from exc
            raise

    def recover(
        self,
        name: str,
        version: int,
        *,
        expected_active_version: int,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        return self.activate(
            name,
            version,
            expected_active_version=expected_active_version,
            actor=actor,
            reason=reason,
            event_type="recovered",
        )

    def revoke(
        self,
        name: str,
        version: int,
        *,
        actor: str = "operator",
        reason: str | None = None,
    ) -> SecretVersion:
        """Revoke a non-active version. Active revocation is deliberately rejected."""
        name = self._validate_identifier(name, "secret name")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            row = self._get_version_row(name, version)
            if row["status"] == "revoked":
                self._conn.commit()
                return self._public_version(row)
            head = self._conn.execute(
                "SELECT active_version FROM secret_heads WHERE scope = ? AND name = ?",
                (self._scope, name),
            ).fetchone()
            if head and int(head["active_version"]) == version:
                raise ActiveSecretRevocationError(
                    "cannot revoke the active version; activate or recover another version first"
                )
            self._conn.execute(
                """
                UPDATE secret_versions
                SET status = 'revoked', revoked_at = datetime('now')
                WHERE scope = ? AND name = ? AND version = ?
                """,
                (self._scope, name, version),
            )
            self._conn.execute(
                """
                UPDATE secret_heads SET previous_version = NULL, updated_at = datetime('now')
                WHERE scope = ? AND name = ? AND previous_version = ?
                """,
                (self._scope, name, version),
            )
            self._audit(
                name=name,
                version=version,
                event_type="revoked",
                outcome="success",
                actor=actor,
                reason=reason,
            )
            updated = self._get_version_row(name, version)
            self._conn.commit()
            result = self._public_version(updated)
            self._transition_log(name, version, "revoke", "success")
            return result
        except Exception as exc:
            self._conn.rollback()
            self._transition_log(name, version, "revoke", "failure", exc)
            if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
                raise SecretBusyError("secret store is busy; retry the idempotent operation") from exc
            raise

    def _get_version_row(self, name: str, version: int) -> sqlite3.Row:
        row = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at,
                   ciphertext, key_id
            FROM secret_versions WHERE scope = ? AND name = ? AND version = ?
            """,
            (self._scope, name, version),
        ).fetchone()
        if not row:
            raise SecretNotFoundError(f"secret version {version} does not exist")
        return row

    @staticmethod
    def _public_version(row: sqlite3.Row) -> SecretVersion:
        return SecretVersion(
            name=row["name"],
            version=int(row["version"]),
            status=row["status"],
            created_at=row["created_at"],
            activated_at=row["activated_at"],
            revoked_at=row["revoked_at"],
        )

    def resolve(self, name: str, legacy_value: str = "") -> SecretResolution:
        """Resolve active -> previous -> legacy according to rollout configuration."""
        name = self._validate_identifier(name, "secret name")
        head = self._conn.execute(
            """
            SELECT active_version, previous_version
            FROM secret_heads WHERE scope = ? AND name = ?
            """,
            (self._scope, name),
        ).fetchone()
        candidates: list[tuple[str, int]] = []
        if head:
            candidates.append(("active", int(head["active_version"])))
            if self._dual_read and head["previous_version"] is not None:
                candidates.append(("previous", int(head["previous_version"])))

        last_error: Exception | None = None
        for source, version in candidates:
            try:
                row = self._get_version_row(name, version)
                if row["status"] == "revoked":
                    continue
                return SecretResolution(self._decrypt(row), source, version)
            except (SecretNotFoundError, SecretDecryptionError) as exc:
                last_error = exc
                log.warning(
                    "secret_resolution",
                    scope=self._scope,
                    secret_name=name,
                    secret_version=version,
                    source=source,
                    outcome="fallback",
                    error_type=type(exc).__name__,
                )
        if self._legacy_fallback and legacy_value:
            return SecretResolution(legacy_value, "legacy", None)
        if last_error:
            raise last_error
        raise SecretNotFoundError(f"no active value for secret {name!r}")

    def list_versions(self, name: str) -> list[SecretVersion]:
        name = self._validate_identifier(name, "secret name")
        rows = self._conn.execute(
            """
            SELECT name, version, status, created_at, activated_at, revoked_at
            FROM secret_versions WHERE scope = ? AND name = ? ORDER BY version DESC
            """,
            (self._scope, name),
        ).fetchall()
        return [SecretVersion(**dict(row)) for row in rows]

    def audit_events(self, name: str, limit: int = 50) -> list[dict]:
        name = self._validate_identifier(name, "secret name")
        bounded_limit = min(max(limit, 1), 500)
        rows = self._conn.execute(
            """
            SELECT event_id, name, version, event_type, outcome, actor, reason, metadata, created_at
            FROM secret_audit_events
            WHERE scope = ? AND name = ? ORDER BY id DESC LIMIT ?
            """,
            (self._scope, name, bounded_limit),
        ).fetchall()
        return [dict(row) for row in rows]


__all__ = [
    "ActiveSecretRevocationError",
    "SecretConfigurationError",
    "SecretBusyError",
    "SecretConflictError",
    "SecretDecryptionError",
    "SecretNotFoundError",
    "SecretResolution",
    "SecretStore",
    "SecretStoreError",
    "SecretValidationError",
    "SecretVersion",
    "decode_keyring",
]
